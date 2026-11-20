import { EventEmitter } from 'node:events';
import type { PluginHost } from '../core/plugin-host.js';
import type { EventHub } from '../core/event-hub.js';
import type { RunService } from '../core/run-service.js';
import type { ActivityEntry, ActivityNotice, ActivitySnapshot, AnyBridgeEvent, Approval, BridgeEventMap } from '../../shared/contract.js';
import type { InboxSignal } from '../../shared/inbox.js';
import { get } from '../../shared/guards.js';
const terminal = new Set<unknown>(['completed', 'failed', 'interrupted']);
const stamp = (value: unknown): number => typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(String(value)) || 0;
/** A message the feed may show: its id, its text (or preview), when it was said. */
export interface NoticeSource { id?: string; text?: unknown; preview?: unknown; phase?: unknown; at?: unknown; timestamp?: unknown }

// Status and public, truncated assistant messages only. Never private reasoning.
class ActivityFeed {
  host: PluginHost; hub: EventHub; runs: RunService; intervalMs: number;
  entries: Map<string, ActivityEntry>; notices: ActivityNotice[]; knownMessages: Map<string, Set<string>>; nativeRunning: Set<string>;
  private waitingWatches = new Map<string, () => void>();
  private readonly baselines = new Map<string, number>();
  private readonly pending = new Map<string, Extract<InboxSignal, { requestId?: string }>[]>();
  bus: EventEmitter; polling: boolean; timer: ReturnType<typeof setInterval> | null; clients: number; unsubscribe: () => void;
  constructor(host: PluginHost, hub: EventHub, runs: RunService, { intervalMs = 3000 }: { intervalMs?: number } = {}) {
    this.host = host; this.hub = hub; this.runs = runs; this.intervalMs = intervalMs;
    this.entries = new Map(); this.notices = []; this.knownMessages = new Map(); this.nativeRunning = new Set();
    this.bus = new EventEmitter(); this.bus.setMaxListeners(0);
    this.polling = false; this.timer = null; this.clients = 0;
    this.unsubscribe = hub.subscribeAll(event => this.record(event));
  }
  notice(engine: string, sessionId: string, message: NoticeSource, seed = false): boolean {
    if (message.phase === 'analysis' || message.phase === 'reasoning') return false;
    const key = this.hub.key(engine, sessionId);
    const known = this.knownMessages.get(key) || new Set<string>();
    this.knownMessages.set(key, known);
    if (!message.id || known.has(message.id)) return false;
    known.add(message.id); if (known.size > 120) { const oldest = known.values().next().value; if (oldest !== undefined) known.delete(oldest); }
    if (seed) return false;
    const preview = String(message.preview || message.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!preview) return false;
    const entry: ActivityEntry = this.entries.get(key) || { engine, sessionId, running: false, completedAt: 0 };
    // When the message was said, not when it was first seen here: a late sighting stays old.
    const said = stamp(message.at || message.timestamp || 0), at = said > 0 && said <= Date.now() ? said : Date.now();
    entry.lastMessageAt = Math.max(entry.lastMessageAt || 0, at); this.entries.set(key, entry);
    this.notices.push({ id: `${key}:${message.id}`, messageId: message.id, engine, sessionId, preview, phase: String(message.phase || 'assistant'), at });
    this.notices.sort((a, b) => a.at - b.at);
    // Kept per engine: a talkative engine does not push out the last thing a quiet one said.
    const own = this.notices.filter(item => item.engine === engine);
    if (own.length > 40) this.notices.splice(this.notices.indexOf(own[0]!), 1);
    return true;
  }
  record(event: AnyBridgeEvent): void {
    const key = this.hub.key(event.engine, event.sessionId);
    const prior = this.pending.get(key) || [];
    const card = (item: Approval, turnId?: string | null) => ({
      engine: event.engine, sessionId: event.sessionId, requestId: item.id, kind: item.kind || 'approval' as const, title: item.title,
      turnId: turnId || undefined, since: prior.find(value => value.requestId === item.id)?.since || Date.parse(event.timestamp),
      desktopOnly: item.decisions.length > 0 && item.decisions.every(choice => (typeof choice === 'string' ? choice : choice.id) === 'desktop'),
    });
    if (event.type === 'approval.requested') {
      const request = event.data as Approval;
      this.pending.set(key, [...prior.filter(item => item.requestId !== request.id), card(request, event.turnId)]);
    } else if (event.type === 'approval.resolved') {
      const remaining = prior.filter(item => item.requestId !== get(event.data, 'id'));
      if (remaining.length) this.pending.set(key, remaining); else this.pending.delete(key);
      const activity = this.entries.get(key);
      if (activity && !remaining.length) delete activity.waitingFor;
    } else if (event.type === 'session.snapshot') {
      const turn = (event.data as BridgeEventMap['session.snapshot']).turns.at(-1);
      const requests = turn?.approvals?.map(item => card(item, turn.id));
      if (requests?.length) this.pending.set(key, requests); else this.pending.delete(key);
    } else if (['run.started', 'run.completed', 'run.failed', 'run.interrupted'].includes(event.type)) {
      this.pending.delete(key);
    }
    if (event.type === 'assistant.notice' || (event.type === 'message.updated' && get(event.data, 'status') === 'completed')) {
      // Both carry a message: { id, text | preview, phase, at }.
      const data = event.data;
      const said: NoticeSource = { id: String(get(data, 'id') ?? ''), text: get(data, 'text'), preview: get(data, 'preview'), phase: get(data, 'phase'),
        at: get(data, 'at'), timestamp: event.timestamp };
      if (this.notice(event.engine, event.sessionId, said)) this.changed();
      return;
    }
    if (event.type === 'approval.requested' || event.type === 'approval.resolved') { this.changed(); return; }
    const ended = ['run.completed', 'run.failed', 'run.interrupted'].includes(event.type);
    if (event.type !== 'run.started' && !ended && event.type !== 'run.connection_lost') return;
    const previous: Partial<ActivityEntry> = this.entries.get(key) || {};
    // An old snapshot/late event cannot rewrite an already confirmed terminal outcome.
    if (ended && previous.turnId === event.turnId && previous.confirmedTerminal) return;
    // A console run that lost track of its turn is not shown as working on its word alone:
    // from then on the desktop's own record says whether the chat runs (poll).
    this.entries.set(key, { ...previous, waitingFor: undefined, engine: event.engine, sessionId: event.sessionId, turnId: event.turnId,
      running: event.type === 'run.started' || (event.type === 'run.connection_lost' && this.nativeRunning.has(key)), outcome: ended ? event.type.slice(4) : null,
      startedAt: event.type === 'run.started' ? Date.parse(event.timestamp) || Date.now() : previous.startedAt || 0,
      confirmedTerminal: ended, completedAt: ended ? Date.parse(event.timestamp) : previous.completedAt || 0,
    });
    this.changed();
  }
  /** An engine has left the console: what it was doing and what it said leave the feed with it. */
  forget(engine: string): void {
    this.baselines.delete(engine);
    for (const [key, stop] of this.waitingWatches) if (this.hub.owns(engine, key)) { stop(); this.waitingWatches.delete(key); }
    for (const store of [this.entries, this.knownMessages, this.pending]) for (const key of [...store.keys()]) if (this.hub.owns(engine, key)) store.delete(key);
    for (const key of [...this.nativeRunning]) if (this.hub.owns(engine, key)) this.nativeRunning.delete(key);
    this.notices = this.notices.filter(item => item.engine !== engine);
    this.changed();
  }
  snapshot(): ActivitySnapshot {
    const sessions = [...this.entries.values()].map(entry => {
      const run = this.runs.get(entry.engine, entry.sessionId)?.run;
      if (!run || run.status === 'reconnecting') return entry;
      const request = run.approvals?.[0];
      return { ...entry, waitingFor: request ? request.kind || 'approval' as const : entry.waitingFor };
    });
    return { sessions, notices: this.notices, timestamp: Date.now() };
  }
  pendingRequests(): InboxSignal[] {
    const live = [...this.pending.values()].flat().map(item => ({
      ...item, sessionTitle: this.entries.get(this.hub.key(item.engine, item.sessionId))?.title,
    }));
    return live.concat(this.snapshot().sessions.flatMap(item => !item.waitingFor ? [] : [{
      engine: item.engine, sessionId: item.sessionId, kind: item.waitingFor,
      sessionTitle: item.title, turnId: item.turnId || undefined, since: item.startedAt || undefined,
    }]));
  }
  private stopWatches() {
    for (const stop of this.waitingWatches.values()) stop();
    this.waitingWatches.clear();
  }
  changed(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= 512) break;
      if (!entry.running && !entry.waitingFor) { this.entries.delete(key); this.knownMessages.delete(key); }
    }
    this.bus.emit('change', this.snapshot());
  }
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const results = await Promise.allSettled([...this.host.engines.values()].map(async engine => {
        const observedAt = Date.now();
        const list = await engine.list(); let changed = false;
        // The engine left while its list was being read (its agent was switched off): nothing is written.
        if (this.host.engines.get(engine.id) !== engine) return false;
        const baseline = this.baselines.get(engine.id) ?? observedAt;
        this.baselines.set(engine.id, baseline);
        const wanted = new Set<string>(), listed = new Set<string>();
        for (const session of Array.isArray(list) ? list : []) {
          const key = this.hub.key(engine.id, session.id), previous = this.entries.get(key);
          listed.add(key);
          const latest = session.metadata?.latestTurn;
          const confirmed = !!(latest && terminal.has(latest.status) && latest.completedAt != null && latest.statusEvidence);
          const token = confirmed && latest ? `${latest.id}:${latest.status}:${latest.completedAt}` : null;
          const activeRun = this.runs.get(engine.id, session.id);
          const running = latest?.status === 'running' || ['busy', 'running', 'inProgress'].includes(String(session.status));
          const waitingFor = session.metadata?.waitingFor;
          // Follow the desktop’s live requests without loading background chat transcripts.
          if (engine.watchSession && this.clients && (running || waitingFor || stamp(latest?.completedAt) > Date.now() - 60_000)) {
            wanted.add(key);
            if (!this.waitingWatches.has(key)) this.waitingWatches.set(key, engine.watchSession(session.id, () => {}));
          }
          if (running) this.nativeRunning.add(key); else this.nativeRunning.delete(key);
          // What the turn in progress said is shown even when the chat is first seen mid-turn
          // (a chat started in the desktop, or one already working when the console opened).
          const since = activeRun ? stamp(activeRun.run.timestamp) : running ? stamp(session.metadata?.turnStartedAt || 0) : 0;
          for (const message of session.metadata?.recentMessages || []) {
            const said = stamp(message.at);
            const currentSpeech = since > 0 && said >= since;
            const historical = said ? said <= baseline : previous?.nativeRevision == null;
            changed = this.notice(engine.id, session.id, message, historical && !currentSpeech) || changed;
          }
          if (activeRun && activeRun.run.status !== 'reconnecting') {
            if (previous && (previous.waitingFor !== waitingFor || previous.title !== session.title)) {
              this.entries.set(key, { ...previous, waitingFor, title: session.title }); changed = true;
            }
            continue;
          }
          const revision = String(session.updatedAt || '');
          // Idle/mtime and a finished shell command are not proof that the task ended.
          const endedAt = stamp(latest?.completedAt);
          const finished = !running && confirmed && token !== previous?.nativeTerminalToken
            && endedAt >= baseline && endedAt > (previous?.completedAt || 0);
          const outcome = finished ? latest?.status ?? null : running ? null : previous?.outcome || null;
          // A run seen here first starts when its turn did, so older speech is not shown as its.
          const startedAt = !running ? previous?.startedAt || 0 : (previous?.running && previous.startedAt) || stamp(session.metadata?.turnStartedAt || 0) || Date.now();
          const next: ActivityEntry = { ...previous, engine: engine.id, sessionId: session.id, title: session.title, running, startedAt, waitingFor,
            nativeRevision: revision, nativeTerminalToken: token || previous?.nativeTerminalToken || null,
            outcome, confirmedTerminal: finished || previous?.confirmedTerminal || false,
            completedAt: finished ? endedAt : previous?.completedAt || 0 };
          if (JSON.stringify(next) !== JSON.stringify(previous)) { this.entries.set(key, next); changed = true; }
        }
        for (const [key, stop] of this.waitingWatches) if (this.hub.owns(engine.id, key) && !wanted.has(key)) {
          stop(); this.waitingWatches.delete(key);
        }
        for (const [key, entry] of this.entries) if (entry.engine === engine.id && entry.waitingFor && !listed.has(key)) {
          delete entry.waitingFor; changed = true;
        }
        return changed;
      }));
      if (results.some(result => result.status === 'fulfilled' && result.value)) this.changed();
    } finally { this.polling = false; }
  }
  subscribe(listener: (snapshot: ActivitySnapshot) => void): () => void {
    this.clients++; this.bus.on('change', listener);
    if (!this.timer) { this.poll(); this.timer = setInterval(() => this.poll(), this.intervalMs); this.timer.unref?.(); }
    listener(this.snapshot());
    return () => { this.bus.off('change', listener); if (--this.clients === 0) { if (this.timer) clearInterval(this.timer); this.timer = null; this.stopWatches(); } };
  }
  dispose(): void { this.clients = 0; this.stopWatches(); this.unsubscribe(); if (this.timer) clearInterval(this.timer); this.bus.removeAllListeners(); }
}
export { ActivityFeed };
