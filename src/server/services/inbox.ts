import type { Engine } from '../../shared/contract.js';
import type { InboxItem, InboxSignal, InboxView, NativePendingRequest } from '../../shared/inbox.js';
import type { PluginHost } from '../core/plugin-host.js';

const sessionKey = (item: { engine: string; sessionId?: string }) => JSON.stringify([item.engine, item.sessionId]);
const requestKey = (item: { engine: string; sessionId?: string; requestId?: string }) =>
  JSON.stringify([sessionKey(item), item.requestId]);

export class Inbox {
  private readonly native = new Map<Engine, { requests: NativePendingRequest[]; checkedAt: number; offline: boolean; resolved: Set<string> }>();
  private readonly firstSeen = new Map<string, number>();
  private pending?: Promise<InboxView>;

  constructor(private readonly host: PluginHost, private readonly signals: () => InboxSignal[]) {}

  read() {
    this.pending ??= this.discover().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async discover(): Promise<InboxView> {
    const engines = [...this.host.engines.values()];
    for (const engine of this.native.keys()) if (!engines.includes(engine)) this.native.delete(engine);
    await Promise.all(engines.map(async engine => {
      if (!engine.listWaiting) return;
      const previous = this.native.get(engine);
      try {
        const requests = await engine.listWaiting();
        const key = (item: NativePendingRequest) => requestKey({ ...item, engine: engine.id });
        const current = new Set(requests.map(key));
        const resolved = new Set(previous?.resolved);
        for (const item of previous?.requests || []) {
          if (item.requestId && !current.has(key(item)) && !requests.some(request => request.sessionId === item.sessionId)) resolved.add(key(item));
        }
        for (const id of current) resolved.delete(id);
        while (resolved.size > 512) resolved.delete(resolved.values().next().value!);
        this.native.set(engine, { requests, checkedAt: Date.now(), offline: false, resolved });
      } catch {
        this.native.set(engine, { requests: previous?.requests || [], checkedAt: previous?.checkedAt || 0,
          offline: true, resolved: previous?.resolved || new Set() });
      }
    }));
    const byEngine = new Map(engines.filter(engine => this.host.engines.get(engine.id) === engine).map(engine => [engine.id, engine]));
    const signals = this.signals().filter(item => {
      const engine = byEngine.get(item.engine);
      if (!engine) return false;
      if (item.kind === 'delivery') return true;
      const native = this.native.get(engine);
      if (!native || native.offline) return true;
      return item.requestId ? !native.resolved.has(requestKey(item)) : native.requests.some(request => request.sessionId === item.sessionId);
    });
    for (const engine of byEngine.values()) {
      for (const item of this.native.get(engine)?.requests || []) signals.push({ ...item, engine: engine.id });
    }
    const items = this.merge(signals);
    const coverage = [...byEngine.values()].map(engine => ({
      engine: engine.id, mode: engine.listWaiting ? 'native' as const : 'tracked' as const,
      checkedAt: this.native.get(engine)?.checkedAt || null,
      offline: !!this.native.get(engine)?.offline,
    }));
    return { items, coverage };
  }

  private merge(signals: InboxSignal[]): InboxItem[] {
    const items = new Map<string, InboxItem>();
    const exact = new Set(signals.filter(item => item.kind !== 'delivery' && item.requestId).map(sessionKey));
    for (const signal of signals) {
      const { source, ...fields } = signal;
      const id = fields.kind === 'delivery' ? JSON.stringify([fields.engine, fields.operationId])
        : fields.requestId ? requestKey(fields) : JSON.stringify([sessionKey(fields), fields.kind]);
      if (fields.kind !== 'delivery' && !fields.requestId && exact.has(sessionKey(fields))) continue;
      const previous = items.get(id);
      const since = Math.min(...[fields.since, previous?.since, this.firstSeen.get(id)].filter((at): at is number => !!at && at > 0), Date.now());
      const sources = previous?.sources || [];
      if (source && !sources.some(item => item.href === source.href)) sources.push(source);
      const defined = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== ''));
      const item = { ...fields, ...previous, ...defined, id, since, sources };
      if (previous && previous.kind !== 'approval' && fields.kind === 'approval') item.kind = previous.kind;
      items.set(id, item);
      this.firstSeen.set(id, since);
    }
    for (const id of this.firstSeen.keys()) if (!items.has(id)) this.firstSeen.delete(id);
    return [...items.values()].sort((left, right) => left.since - right.since || left.id.localeCompare(right.id));
  }
}
