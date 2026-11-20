// DeepSeek Harness (DSH) as a Frontdesk engine.
//
// Everything this bridge knows comes from the desktop app's own process: the bridge plugin
// (`integrations/dsh-frontdesk-bridge`, installed in the app's profile) forwards the Host's Remote
// calls as an owner Peer over a loopback port guarded by a secret in `~/.dsh/frontdesk-bridge.json`.
// A turn therefore runs in the app itself and shows up in its window at once, exactly like a
// message typed there. Nothing here reads a launch token, and the session log is only read through
// the same owner-facing interface the app's own page uses.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { UnifiedSession, UnifiedStep, UnifiedTurn, EngineEvents, assignPhases } from './types.js';
import { questionCard, type Question } from './core/presentation.js';
import { get, list, num, str, bag, messageOf, failure, type Bag } from '../shared/guards.js';
import type {
  Approval, CreateInput, EngineEmitter, DesktopSettings, EngineStatus, History, LatestTurn, Model,
  Project, RecentMessage, SendInput, UnifiedMessage, UnifiedTurn as Turn, Usage, UsageWindow,
} from '../shared/contract.js';

const ENGINE = 'dsh';
const APP = 'DeepSeek Harness';
const NOT_RUNNING = '请打开 DeepSeek Harness，并在桌面设置中启用 Agent Frontdesk 桥插件';
const NO_BRIDGE = '桥插件没有起来：在 DeepSeek Harness 的「设置 → 插件」里启用「Agent Frontdesk 桥」，然后重试';
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** A reading of the app's own state that the desktop app says cannot happen is an error, not an empty list. */
class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface Rendezvous { port: number; secret: string; pid?: number }
interface BridgeOptions { home?: string; bridgeFile?: string }

/** One session row as the app's Session list returns it. */
interface Row {
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  settings: DesktopSettings;
  lastPromptAt: number | null;
  questions: PendingQuestion[];
}

interface PendingQuestion { callId: string; questions: Question[]; ids: string[] }
interface Workspace { id: string; path: string; title: string; sessionIds: string[] }

interface NativeEvent { type: string; seq: number; time: number; data: unknown }
interface TurnBuild {
  id: string;
  number: number;
  prompt: string;
  timestamp: number;
  status: string;
  evidence: string | null;
  completedAt: number | null;
  messages: UnifiedMessage[];
  steps: Map<string, UnifiedStep>;
  order: Array<{ kind: 'message' | 'activity'; id: string }>;
}
interface Recent { version: number; running: boolean; checkedAt: number; messages: RecentMessage[]; latestTurn?: LatestTurn }

const iso = (ms: number): string => new Date(ms).toISOString();
const clean = (value: unknown, limit = 400): string => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

/** Text of a content list of prompt parts (`[{ type: 'text', text }]`), dropping the app's own placeholders. */
function promptText(content: unknown): string {
  return list(content).filter(part => str(get(part, 'type')) === 'text').map(part => str(get(part, 'text')) || '').join('\n').replace(/\[Image: source: [^\]]*\]/g, '').trim();
}
/** Text of a message's content list (text parts only; reasoning and tool-call parts stay out). */
function contentText(content: unknown): string {
  return list(content).filter(part => str(get(part, 'type')) === 'text').map(part => str(get(part, 'text')) || '').join('\n').trim();
}
/** The turn-end reason as one of the contract's statuses, with the app's own word kept as evidence. */
function turnStatusOf(reason: unknown): { status: string; kind: string } {
  const kind = str(get(reason, 'kind')) || 'unknown';
  if (kind === 'completed') return { status: 'completed', kind };
  if (/cancel|abort|interrupt|stopped/i.test(kind)) return { status: 'interrupted', kind };
  if (/fail|error|timeout/i.test(kind)) return { status: 'failed', kind };
  return { status: 'unknown', kind };
}
const eventOf = (value: unknown): NativeEvent | null => {
  const type = str(get(value, 'type')), seq = num(get(value, 'seq'));
  return type && seq !== undefined ? { type, seq, time: num(get(value, 'time')) || 0, data: get(value, 'data') } : null;
};

/** The model id this engine uses: `<provider>/<model>`, both of which the app's catalog names. */
const modelId = (provider: string, model: string): string => `${provider}/${model}`;
function parseModelId(value: string): { provider: string; model: string } | null {
  const at = value.indexOf('/');
  return at > 0 && at < value.length - 1 ? { provider: value.slice(0, at), model: value.slice(at + 1) } : null;
}

export class DshBridge {
  private readonly home: string;
  private readonly file: string;
  private recordCache: { value: Rendezvous; at: number } | null = null;
  private sessionsCache: { at: number; rows: Row[] } | null = null;
  private workspaceCache: { at: number; items: Workspace[]; archived: Set<string>; order: Map<string, number> } | null = null;
  private readonly recent = new Map<string, Recent>();
  private readonly watchers = new Set<AbortController>();

  constructor(options: BridgeOptions = {}) {
    this.home = options.home || path.join(os.homedir(), '.dsh');
    this.file = options.bridgeFile || path.join(this.home, 'frontdesk-bridge.json');
  }

  dispose(): void { for (const controller of this.watchers) controller.abort(); this.watchers.clear(); }

  // -------------------------------------------------------------------------------------------
  // The loopback tunnel
  // -------------------------------------------------------------------------------------------

  private record(): Rendezvous {
    if (this.recordCache && Date.now() - this.recordCache.at < 2000) return this.recordCache.value;
    let raw: string;
    try { raw = fs.readFileSync(this.file, 'utf8'); }
    catch { throw new BridgeError('dsh/not-running', fs.existsSync(path.dirname(this.file)) ? NO_BRIDGE : NOT_RUNNING); }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new BridgeError('dsh/not-running', NO_BRIDGE); }
    const port = num(get(parsed, 'port')), secret = str(get(parsed, 'secret'));
    if (!Number.isInteger(port) || !port || port < 1 || port > 65535 || !secret) throw new BridgeError('dsh/not-running', NO_BRIDGE);
    const value: Rendezvous = { port, secret, pid: num(get(parsed, 'pid')) };
    this.recordCache = { value, at: Date.now() };
    return value;
  }

  private async request(pathname: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const record = this.record();
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${record.port}${pathname}`, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-dsh-bridge': record.secret },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ?? AbortSignal.timeout(30000),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      this.recordCache = null;
      throw new BridgeError('dsh/not-running', NOT_RUNNING);
    }
    if (response.status === 401) throw new BridgeError('dsh/unauthorized', NO_BRIDGE);
    let value: unknown;
    try { value = await response.json(); } catch { throw new BridgeError('dsh/bad-answer', `${APP} 的桥返回了看不懂的内容`); }
    if (pathname === '/health' && response.ok && get(value, 'ok') === true) return value;
    if (get(value, 'ok') !== true) {
      const code = str(get(value, 'error', 'code')) || 'dsh/error';
      const message = str(get(value, 'error', 'message')) || '桥返回了一个错误';
      throw new BridgeError(code, message);
    }
    return get(value, 'value');
  }

  /** One Host Remote call (`namespace/method`) as the app's owner. */
  async call(namespace: string, method: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request('/invoke', { namespace, method, args }, signal);
  }

  /** One Host stream Remote call, frame by frame; the generator stops when the provider ends it. */
  async *frames(namespace: string, method: string, args: unknown, signal?: AbortSignal): AsyncGenerator<unknown> {
    const record = this.record();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetch(`http://127.0.0.1:${record.port}/stream`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-dsh-bridge': record.secret },
        body: JSON.stringify({ namespace, method, args }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new BridgeError('dsh/stream', NO_BRIDGE);
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
          const frame = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
          if (frame.startsWith('event: error')) throw new BridgeError('dsh/stream', NO_BRIDGE);
          if (frame.startsWith('event: end')) return;
          if (data) yield JSON.parse(data);
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      throw error instanceof Error ? error : new Error(String(error));
    } finally { controller.abort(); signal?.removeEventListener('abort', abort); }
  }

  /** The first frame of a stream (its baseline), then the stream is closed. */
  private async firstFrame(namespace: string, method: string, args: unknown, timeoutMs = 8000): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      for await (const frame of this.frames(namespace, method, args, controller.signal)) return frame;
      throw new BridgeError('dsh/bad-answer', `${APP} 没有给出 ${namespace}/${method} 的初始快照`);
    } finally { clearTimeout(timer); controller.abort(); }
  }

  // -------------------------------------------------------------------------------------------
  // What the app says about itself
  // -------------------------------------------------------------------------------------------

  async status(): Promise<EngineStatus> {
    try {
      const health = await this.request('/health', undefined);
      return { connected: true, pid: num(get(health, 'pid')) ?? null, engine: ENGINE };
    } catch (error) {
      return { connected: false, error: messageOf(error), engine: ENGINE };
    }
  }

  async sendBlockedReason(_id?: string | null): Promise<string> {
    if (!fs.existsSync(this.file)) return NOT_RUNNING;
    try { await this.request('/health', undefined); return ''; }
    catch (error) { return messageOf(error); }
  }

  async getModels(): Promise<Model[]> {
    const catalog = bag(await this.call('session', 'modelCatalog', {}));
    const models: Model[] = [];
    for (const group of list(get(catalog, 'groups'))) {
      const provider = str(get(group, 'id')) || '';
      const providerName = str(get(group, 'name')) || provider;
      for (const item of list(get(group, 'models'))) {
        const id = str(get(item, 'id')), name = str(get(item, 'name')) || id;
        if (!provider || !id || !name) continue;
        const efforts = list(get(item, 'reasoning', 'efforts')).flatMap(effort => str(get(effort, 'id')) || []);
        const description = [providerName, str(get(item, 'description'))].filter(Boolean).join(' · ');
        models.push({ id: modelId(provider, id), name, ...(description ? { description } : {}), ...(efforts.length ? { reasoningEfforts: efforts } : {}),
          ...(str(get(item, 'reasoning', 'defaultEffort')) ? { defaultReasoningEffort: str(get(item, 'reasoning', 'defaultEffort')) } : {}), provider });
      }
    }
    return models;
  }

  async getUsage(): Promise<Usage> {
    // The app's own account interface; a profile signed in through one provider API key has no windows.
    try {
      const state = bag(await this.call('account', 'getState', {}));
      if (str(get(state, 'status')) !== 'signed-in') {
        const links = bag(get(state, 'links'));
        const usageUrl = str(get(links, 'usageUrl'));
        return { available: false, short: '未登录', reason: `我的桌面版没有登录 DeepSeek 账号，额度读不到。${usageUrl ? `用量页：${usageUrl}` : '在桌面版里登录后这里会显示余额。'}` };
      }
      const balance = bag(await this.call('account', 'getBalance', { client: {} }));
      const windows: UsageWindow[] = [];
      for (const item of list(get(balance, 'balances'))) {
        const total = num(get(item, 'totalBalance')), used = num(get(item, 'usedBalance'));
        if (total === undefined || total <= 0 || used === undefined) continue;
        const currency = str(get(item, 'currency')) || '';
        windows.push({ id: currency || 'balance', label: `${currency || '余额'} 剩余`, remainingPercent: total > 0 ? Math.max(0, Math.min(100, ((total - used) / total) * 100)) : null, usedPercent: total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : null, windowMinutes: null, resetsAt: null });
      }
      if (!windows.length) return { available: false, short: '无额度窗口', reason: '账号接口这次没有返回余额数字。' };
      return { available: true, windows };
    } catch (error) {
      return { available: false, short: '读不到', reason: `额度读不到：${messageOf(error)}` };
    }
  }

  // -------------------------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------------------------

  private async rows(force = false): Promise<Row[]> {
    if (!force && this.sessionsCache && Date.now() - this.sessionsCache.at < 4000) return this.sessionsCache.rows;
    const result = bag(await this.call('session', 'list', { _request: {} }));
    const rows: Row[] = [];
    for (const item of list(get(result, 'items'))) {
      const id = str(get(item, 'sessionId'));
      if (!id) continue;
      const values = bag(get(item, 'projections', 'values'));
      const next = bag(get(values, 'modelSelection', 'next'));
      const provider = str(get(next, 'provider')), model = str(get(next, 'model'));
      const settings: DesktopSettings = {
        ...(provider && model ? { model: modelId(provider, model) } : {}),
        ...(str(get(next, 'reasoningEffort')) ? { effort: str(get(next, 'reasoningEffort')) } : {}),
        ...(str(get(values, 'permissions', 'currentValue')) ? { permissionMode: str(get(values, 'permissions', 'currentValue')) } : {}),
      };
      rows.push({
        id,
        title: str(get(values, 'title')) || '',
        cwd: str(get(item, 'cwd')) || str(get(values, 'workingDirectory')) || '',
        updatedAt: num(get(item, 'updatedAt')) || 0,
        running: get(item, 'running') === true,
        blank: get(item, 'blank') === true,
        settings,
        lastPromptAt: num(get(values, 'sessionListMetadata', 'lastPromptAt')) ?? null,
        questions: this.questionsOf(values),
      });
    }
    this.sessionsCache = { at: Date.now(), rows };
    return rows;
  }

  private questionsOf(values: Bag | undefined): PendingQuestion[] {
    const active = list(get(values, 'userQuestions', 'active'));
    return active.flatMap(item => {
      const callId = str(get(item, 'callId'));
      if (!callId) return [];
      const questions: Question[] = [];
      const ids: string[] = [];
      for (const question of list(get(item, 'questions'))) {
        const options = list(get(question, 'options')).flatMap(option => {
          const label = str(get(option, 'label')) || str(get(option, 'value'));
          return label ? [{ id: label, label }] : [];
        });
        const prompt = str(get(question, 'question')) || str(get(question, 'header')) || '';
        if (!prompt) continue;
        ids.push(str(get(question, 'id')) || `q${ids.length + 1}`);
        questions.push({ question: prompt, ...(get(question, 'multiSelect') === true || get(question, 'multi') === true || get(question, 'multiple') === true ? { multi: true } : {}), options });
      }
      return questions.length ? [{ callId, questions, ids }] : [];
    });
  }

  private async workspaces(): Promise<{ items: Workspace[]; archived: Set<string>; order: Map<string, number> }> {
    if (this.workspaceCache && Date.now() - this.workspaceCache.at < 5000) return this.workspaceCache;
    const baseline = bag(await this.firstFrame('workspace', 'follow', {}));
    const value = bag(get(baseline, 'value')) || bag(baseline);
    const items: Workspace[] = [];
    const order = new Map<string, number>();
    for (const item of list(get(value, 'items'))) {
      const id = str(get(item, 'workspaceId'));
      if (!id) continue;
      const sessionIds = list(get(item, 'sessionIds')).flatMap(item => str(item) || []);
      items.push({ id, path: str(get(item, 'path')) || '', title: str(get(item, 'title')) || str(get(item, 'path')) || id, sessionIds });
      sessionIds.forEach((sessionId, index) => order.set(sessionId, index));
    }
    const archived = new Set(list(get(value, 'archivedSessionIds')).flatMap(item => str(item) || []));
    this.workspaceCache = { at: Date.now(), items, archived, order };
    return this.workspaceCache;
  }

  async projects(): Promise<Project[]> {
    const { items } = await this.workspaces();
    return items.map(item => ({ id: item.id, name: item.title, cwd: item.path }));
  }

  async catalog(cwd?: string, includeBlank = false) {
    const [rows, space] = await Promise.all([this.rows(), this.workspaces()]);
    return rows.filter(row => (includeBlank || !row.blank) && !space.archived.has(row.id) && (!cwd || row.cwd === cwd))
      .map(({ id, title, cwd, updatedAt }) => ({ id, title, cwd, updatedAt }));
  }

  async list(): Promise<UnifiedSession[]> {
    const [rows, space] = await Promise.all([this.rows(), this.workspaces()]);
    const workspaceOf = new Map<string, Workspace>();
    for (const workspace of space.items) for (const sessionId of workspace.sessionIds) workspaceOf.set(sessionId, workspace);
    const visible = rows.filter(row => !row.blank && !space.archived.has(row.id));
    await this.refreshRecent(visible);
    const sessions = visible.map(row => this.toSession(row, workspaceOf.get(row.id) ?? null, space.order.get(row.id)));
    return sessions;
  }

  async listWaiting(): Promise<import('../shared/inbox.js').NativePendingRequest[]> {
    return (await this.rows(true)).flatMap(row => row.questions.map(question => ({
      sessionId: row.id, requestId: this.card(row.id, question).id, kind: 'input' as const,
      sessionTitle: row.title, project: row.cwd,
    })));
  }

  private toSession(row: Row, workspace: Workspace | null, rank: number | undefined): UnifiedSession {
    const recent = this.recent.get(row.id);
    const metadata: UnifiedSession['metadata'] = {
      group: workspace ? { id: workspace.id, name: workspace.title, cwd: workspace.path } : null,
      desktop: row.settings,
      ...(row.questions.length ? { waitingFor: 'input' } : {}),
      ...(row.running && row.lastPromptAt ? { turnStartedAt: row.lastPromptAt } : {}),
      ...(recent ? { recentMessages: recent.messages, latestTurn: recent.latestTurn } : {}),
    };
    return new UnifiedSession({
      id: row.id, engine: ENGINE, title: row.title || '新会话', updatedAt: row.updatedAt ? iso(row.updatedAt) : new Date().toISOString(),
      cwd: row.cwd, status: row.running ? 'busy' : 'idle', isDesktopActive: row.running, metadata,
    });
  }

  /**
   * The list timestamp is the last prompt. Use the native log for reply and completion times,
   * and refresh again when the app reports that a turn has stopped running.
   */
  private async refreshRecent(rows: Row[]): Promise<void> {
    const now = Date.now();
    const candidates = rows.flatMap(row => {
      const cached = this.recent.get(row.id);
      const changed = cached && (cached.version !== row.updatedAt || cached.running !== row.running);
      if (cached && !changed && (!row.running || now - cached.checkedAt < 3000)) return [];
      return [{ row, priority: changed ? 2 : row.running ? 1 : 0, checkedAt: cached?.checkedAt || 0 }];
    }).sort((a, b) => b.priority - a.priority || a.checkedAt - b.checkedAt || b.row.updatedAt - a.row.updatedAt).slice(0, 8);
    for (const { row } of candidates) {
      try {
        const events = await this.tail(row.id, 16);
        const last = events.findLast(event => ['turn/start', 'assistant/message', 'turn/end'].includes(event.type));
        const turn = num(get(last?.data, 'turn'));
        const reply = turn === undefined ? undefined : events.findLast(event => event.type === 'assistant/message' && get(event.data, 'turn') === turn
          && event.time > 0 && contentText(get(event.data, 'message', 'content')));
        const messages: RecentMessage[] = list(get(reply?.data, 'message', 'content')).flatMap((part, index) => {
          const preview = get(part, 'type') === 'text' ? clean(get(part, 'text'), 1000) : '';
          return reply && preview ? [{ id: `m${reply.seq}-${index}`, preview, phase: last?.type === 'turn/end' ? 'final_answer' : 'commentary', at: reply.time }] : [];
        });
        const end = last?.type === 'turn/end' && last.time > 0 ? turnStatusOf(get(last.data, 'reason')) : null;
        const latestTurn = end && turn !== undefined && end.status !== 'unknown' ? {
          id: `turn-${turn}`, status: end.status, completedAt: last!.time, statusEvidence: `turn/end:${end.kind}`,
        } : undefined;
        this.recent.set(row.id, { version: row.updatedAt, running: row.running, checkedAt: now, messages, latestTurn });
      } catch { /* a session whose tail cannot be read keeps its older line */ }
    }
  }

  private async allEvents(sessionId: string, maxMessages = 4000): Promise<NativeEvent[]> {
    const pages: NativeEvent[][] = [];
    let before: number | undefined;
    let total = 0;
    for (let page = 0; page < 60 && total < maxMessages; page++) {
      const request: Record<string, unknown> = { address: { kind: 'session', sessionId }, maxMessages: 200 };
      if (before !== undefined) request.beforeSeq = before;
      const result = bag(await this.call('session', 'events', { request }));
      const events = list(get(result, 'records')).flatMap(record => eventOf(get(record, 'event')) ?? []);
      if (!events.length) break;
      pages.unshift(events);
      total += events.length;
      const first = events[0]?.seq;
      if (first === undefined || first <= 1) break;
      if (first === before || get(result, 'hasMore') === false) break;
      before = first;
    }
    return pages.flat();
  }

  private tail(sessionId: string, maxMessages = 120): Promise<NativeEvent[]> {
    return this.call('session', 'events', { request: { address: { kind: 'session', sessionId }, maxMessages } })
      .then(result => list(get(result, 'records')).flatMap(record => eventOf(get(record, 'event')) ?? []));
  }

  private lastSeq(events: NativeEvent[]): number {
    return events.at(-1)?.seq ?? 0;
  }

  async read(id: string): Promise<History> {
    const row = await this.row(id);
    if (!row) throw failure('DSH 桌面没有这个会话', { status: 404 });
    const [events, space] = await Promise.all([this.allEvents(id), this.workspaces()]);
    const session = this.toSession(row, space.items.find(workspace => workspace.sessionIds.includes(id)) || null, space.order.get(id));
    const turns = this.turnsOf(events), current = turns.at(-1);
    if (current?.status === 'running' && row.questions.length) current.approvals = row.questions.map(pending => this.card(id, pending));
    return { session, turns };
  }

  private turnsOf(events: NativeEvent[]): Turn[] {
    const turns: Turn[] = [];
    let current: TurnBuild | null = null;
    const openTurn = (number: number, time: number): TurnBuild => ({
      id: `turn-${number}`, number, prompt: '', timestamp: time || Date.now(), status: 'running', evidence: null, completedAt: null,
      messages: [], steps: new Map(), order: [],
    });
    const close = (build: TurnBuild): void => {
      const turn = new UnifiedTurn({
        id: build.id, userPrompt: build.prompt, timestamp: build.timestamp, status: build.status, statusEvidence: build.evidence,
        completedAt: build.completedAt, messages: build.messages, steps: [...build.steps.values()], timeline: build.order,
        artifacts: [], durationMs: build.completedAt ? Math.max(0, build.completedAt - build.timestamp) : 0,
      });
      turns.push(assignPhases(turn));
    };
    for (const event of events) {
      const data = event.data;
      if (event.type === 'turn/start') {
        if (current) close(current);
        current = openTurn(num(get(data, 'turn')) ?? turns.length + 1, event.time);
        continue;
      }
      if (!current) {
        if (event.type === 'user/message' || event.type === 'assistant/message') { current = openTurn(num(get(data, 'turn')) ?? turns.length + 1, event.time); }
        else continue;
      }
      const build = current;
      switch (event.type) {
        case 'user/message': {
          if (str(get(data, 'source', 'kind')) !== 'user') break;
          const prompt = promptText(get(data, 'content'));
          if (prompt && !build.prompt) { build.prompt = prompt; build.timestamp = event.time || build.timestamp; }
          else if (prompt) {
            const id = 'user-' + event.seq;
            build.steps.set(id, new UnifiedStep({ id, type: 'user_message', title: prompt, status: 'completed' }));
            build.order.push({ kind: 'activity', id });
          }
          break;
        }
        case 'assistant/message': {
          const parts = list(get(data, 'message', 'content'));
          parts.forEach((part, index) => {
            if (str(get(part, 'type')) !== 'text') return;
            const value = str(get(part, 'text')) || '';
            if (!value.trim()) return;
            const messageId = `m${event.seq}-${index}`;
            build.messages.push({ id: messageId, text: value, at: event.time });
            build.order.push({ kind: 'message', id: messageId });
          });
          break;
        }
        case 'tool/call': {
          const callId = str(get(data, 'callId'));
          const name = str(get(data, 'name')) || 'tool';
          if (!callId) break;
          const raw = get(data, 'arguments');
          let input: unknown = raw;
          if (typeof raw === 'string') { try { input = JSON.parse(raw); } catch { input = raw; } }
          const stepId = `c:${callId}`;
          build.steps.set(stepId, new UnifiedStep({ id: stepId, type: 'tool_call', name, input, status: 'running' }));
          build.order.push({ kind: 'activity', id: stepId });
          break;
        }
        case 'tool/result': {
          const callId = str(get(data, 'toolCallId')) || str(get(data, 'message', 'toolCallId'));
          if (!callId) break;
          const stepId = `c:${callId}`;
          const output = contentText(get(data, 'message', 'content'));
          const failed = get(data, 'message', 'isError') === true || get(data, 'isError') === true;
          const step = build.steps.get(stepId);
          if (step) { step.output = output; step.status = failed ? 'failed' : 'completed'; }
          else { build.steps.set(stepId, new UnifiedStep({ id: stepId, type: 'tool_call', name: 'tool', output, status: failed ? 'failed' : 'completed' })); build.order.push({ kind: 'activity', id: stepId }); }
          break;
        }
        case 'todo/write': {
          const todos = list(get(data, 'todos')).flatMap(item => {
            const content = str(get(item, 'content')) || str(get(item, 'text'));
            const status = str(get(item, 'status')) || 'pending';
            if (!content) return [];
            return [{ content, status }];
          });
          if (!todos.length) break;
          const stepId = `plan-${event.seq}`;
          build.steps.set(stepId, new UnifiedStep({ id: stepId, type: 'tool_call', name: 'todo_write', plan: todos, status: 'completed' }));
          build.order.push({ kind: 'activity', id: stepId });
          break;
        }
        case 'turn/end': {
          const { status, kind } = turnStatusOf(get(data, 'reason'));
          build.status = status;
          build.evidence = `turn/end:${kind}`;
          build.completedAt = event.time || Date.now();
          break;
        }
        default: break;
      }
    }
    if (current) close(current);
    return turns;
  }

  // -------------------------------------------------------------------------------------------
  // Steering a turn
  // -------------------------------------------------------------------------------------------

  async create(input: CreateInput): Promise<{ id: string; cwd?: string }> {
    const request: Record<string, unknown> = {};
    if (input.cwd) {
      const project = (await this.workspaces()).items.find(project => project.path === input.cwd);
      if (project) request.workspaceId = project.id;
      else request.cwd = input.cwd;
    }
    const result = await this.call('session', 'create', { request });
    const sessionId = str(get(result, 'sessionId'));
    if (!sessionId) throw failure(`${APP} 没有给出新会话的 id`, { status: 502 });
    this.sessionsCache = null;
    return { id: sessionId, cwd: input.cwd };
  }

  async prepareGroupModel(id: string, model: string): Promise<void> {
    await this.applySettings(id, { prompt: '', model, attachments: [] });
  }

  send(id: string, input: SendInput): EngineEvents {
    const emitter = new EngineEvents();
    queueMicrotask(() => { void this.runSend(id, input, emitter); });
    return emitter;
  }

  private async runSend(id: string, input: SendInput, emitter: EngineEvents): Promise<void> {
    let submitted = false;
    try {
      await this.applySettings(id, input);
      const before = this.lastSeq(await this.tail(id, 1));
      const rpcId = randomUUID();
      submitted = true;
      await this.call('session', 'prompt', { request: { sessionId: id, requestId: rpcId, mode: 'queue', content: [{ type: 'text', text: input.prompt }], clientTimeZone: TZ } });
      await this.watch(id, emitter, before, rpcId);
    } catch (error) {
      emitter.emit('error', Object.assign(new Error(messageOf(error)), { code: str(get(error, 'code')), terminal: !submitted }));
    }
  }

  async steer(id: string, input: SendInput, _emitter?: EngineEmitter | null): Promise<{ shown: boolean }> {
    await this.applySettings(id, input);
    const before = this.lastSeq(await this.tail(id, 1));
    const rpcId = randomUUID();
    await this.call('session', 'prompt', { request: { sessionId: id, requestId: rpcId, mode: 'steer', content: [{ type: 'text', text: input.prompt }], clientTimeZone: TZ } });
    const seen = await this.waitForMessage(id, rpcId, before, 12000);
    if (!seen) throw failure(`${APP} 的记录里没有出现这条插话：到桌面版里看一下，它可能排队到了这一轮之后`, { status: 504 });
    return { shown: true };
  }

  private async waitForMessage(id: string, rpcId: string, afterSeq: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const events = await this.tail(id);
        if (events.some(event => event.seq > afterSeq && (
          (event.type === 'user/message' && get(event.data, 'source', 'rpcId') === rpcId) ||
          (event.type === 'agent/inbox/spliced' && get(event.data, 'target') === 'next-step' &&
            list(get(event.data, 'inserted')).some(item => get(item, 'source', 'rpcId') === rpcId))
        ))) return true;
      } catch { /* keep waiting while the app is busy */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
  }

  async interrupt(id: string): Promise<{ pending: boolean }> {
    await this.call('session', 'cancel', { request: { sessionId: id } });
    return { pending: true };
  }

  observe(id: string): EngineEvents {
    const emitter = new EngineEvents();
    queueMicrotask(() => {
      void (async () => {
        try {
          const before = this.lastSeq(await this.tail(id, 1));
          await this.watch(id, emitter, before, null);
        } catch (error) { emitter.emit('error', new Error(messageOf(error))); }
      })();
    });
    return emitter;
  }

  /**
   * Follow the app's own record from `afterSeq`; the record decides everything. `rpcId` is the
   * message this run put in (a null one follows a turn Frontdesk did not start).
   */
  private async watch(id: string, emitter: EngineEvents, afterSeq: number, rpcId: string | null): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    emitter.once('interrupt', abort);
    this.watchers.add(controller);
    const deadline = Date.now() + 6 * 60 * 60 * 1000;
    let last = afterSeq;
    let seenPrompt = rpcId === null;
    let confirmTimer: NodeJS.Timeout | null = null;
    if (!seenPrompt) confirmTimer = setTimeout(() => emitter.emit('warning', { message: '正在确认桌面版是否收到这条消息', awaitingEnd: true }), 8000);
    const emitted = new Set<string>();
    let questionsAt = 0;
    try {
      let stopped = false;
      while (!controller.signal.aborted && !stopped && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 650));
        if (controller.signal.aborted) break;
        let events: NativeEvent[];
        try { events = await this.tail(id); } catch { continue; }
        const fresh = events.filter(event => event.seq > last).sort((a, b) => a.seq - b.seq);
        for (const event of fresh) {
          if (event.seq <= last) continue;
          last = Math.max(last, event.seq);
          if (!seenPrompt) {
            if (event.type !== 'user/message' || get(event.data, 'source', 'rpcId') !== rpcId) continue;
            seenPrompt = true;
            if (confirmTimer) clearTimeout(confirmTimer);
          }
          if (event.type === 'assistant/message') {
            list(get(event.data, 'message', 'content')).forEach((part, index) => {
              if (str(get(part, 'type')) !== 'text') return;
              const messageId = `m${event.seq}-${index}`;
              const value = str(get(part, 'text')) || '';
              if (!value.trim() || emitted.has(messageId)) return;
              emitted.add(messageId);
              emitter.emit('item_completed', { item: { type: 'agentMessage', id: messageId, text: value, phase: 'commentary' } });
            });
          } else if (event.type === 'tool/call') {
            const callId = str(get(event.data, 'callId')), name = str(get(event.data, 'name')) || 'tool';
            if (!callId) continue;
            const raw = get(event.data, 'arguments');
            let input: unknown = raw;
            if (typeof raw === 'string') { try { input = JSON.parse(raw); } catch { input = raw; } }
            emitter.emit('delta', { type: 'tool_call', id: `c:${callId}`, name, input });
          } else if (event.type === 'tool/result') {
            const callId = str(get(event.data, 'toolCallId')) || str(get(event.data, 'message', 'toolCallId'));
            if (!callId) continue;
            emitter.emit('delta', { type: 'tool_result', id: `c:${callId}`, output: contentText(get(event.data, 'message', 'content')), isError: get(event.data, 'message', 'isError') === true });
          } else if (event.type === 'todo/write') {
            const plan = list(get(event.data, 'todos')).flatMap(item => {
              const content = str(get(item, 'content'));
              return content ? [{ content, status: str(get(item, 'status')) || 'pending' }] : [];
            });
            if (plan.length) emitter.emit('item_completed', { item: { type: 'tool_call', id: `plan-${event.seq}`, name: 'todo_write', plan } });
          } else if (event.type === 'turn/end') {
            const { status } = turnStatusOf(get(event.data, 'reason'));
            if (status === 'unknown') emitter.emit('warning', { message: '正在确认 DSH 执行结果', awaitingEnd: true });
            else emitter.emit('completed', { turn: { status } });
            stopped = true;
            break;
          }
        }
        if (seenPrompt && !stopped && Date.now() - questionsAt > 3000) { questionsAt = Date.now(); await this.emitQuestions(id, emitter, emitted); }
      }
      if (!stopped && !controller.signal.aborted) emitter.emit('warning', { message: '正在确认 DSH 执行结果', awaitingEnd: true });
    } finally {
      if (confirmTimer) clearTimeout(confirmTimer);
      emitter.off('interrupt', abort);
      this.watchers.delete(controller);
    }
  }

  /** The agent's own question card, as the app's session projection records it. */
  private async emitQuestions(id: string, emitter: EngineEvents, emitted: Set<string>): Promise<void> {
    try {
      const values = bag(await this.call('session', 'projections', { request: { sessionId: id } }));
      for (const pending of this.questionsOf(bag(get(values, 'values')))) {
        const key = `q:${pending.callId}`;
        if (emitted.has(key)) continue;
        emitted.add(key);
        emitter.emit('approval', this.card(id, pending));
      }
      for (const settled of list(get(values, 'values', 'userQuestions', 'settled'))) {
        const callId = str(get(settled, 'callId'));
        if (callId && emitted.delete('q:' + callId)) emitter.emit('approval_resolved', { id: `${id}:q-${callId}` });
      }
    } catch { /* the projection is best effort while a turn runs */ }
  }

  private card(id: string, pending: PendingQuestion): Approval {
    return { ...questionCard(id + ':q-' + pending.callId, pending.questions, APP), kind: 'input' };
  }

  async decide(sessionId: string, approvalId: string, decision: unknown): Promise<void> {
    const values = bag(await this.call('session', 'projections', { request: { sessionId } }));
    const pending = this.questionsOf(bag(get(values, 'values'))).find(item => this.card(sessionId, item).id === approvalId);
    if (!pending || typeof decision !== 'string' || !this.card(sessionId, pending).decisions.some(item => (typeof item === 'string' ? item : item.id) === decision)) {
      throw failure('这个选项已失效', { status: 409 });
    }
    const selected = decision === 'decline' ? [] : [decision.slice('option:'.length)];
    const accepted = await this.call('userQuestions', 'answer', { agentId: sessionId, callId: pending.callId,
      answer: { answers: [{ id: pending.ids[0], selected }] } });
    if (accepted !== true) throw failure('桌面版没有接受这个答案，请到桌面版里回答', { status: 409 });
  }

  // -------------------------------------------------------------------------------------------
  // Settings follow the message
  // -------------------------------------------------------------------------------------------

  private async row(sessionId: string, force = false): Promise<Row | undefined> {
    return (await this.rows(force)).find(item => item.id === sessionId);
  }

  /**
   * A model, effort or permission mode changed on the page is changed in the desktop app first.
   * If the app does not end up showing it, the message is not sent at all.
   */
  private async applySettings(id: string, input: SendInput): Promise<void> {
    const before = await this.row(id, true);
    if (!before) throw failure('这个会话不在我的桌面版的列表里，可能已经被归档：先在桌面版里打开它', { status: 409 });
    const current = before.settings;
    const target: { provider: string; model: string; effort?: string } | null = input.model ? (() => {
      const parsed = parseModelId(input.model);
      return parsed ? { ...parsed, ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}) } : null;
    })() : null;
    const modelChanged = target ? modelId(target.provider, target.model) !== current.model : false;
    const effortChanged = !!input.reasoningEffort && input.reasoningEffort !== current.effort;
    if (input.model && !target) throw failure('这个模型的名字看不懂，消息没有发出去', { status: 400 });
    if (modelChanged || effortChanged) {
      const base = target ?? (current.model ? parseModelId(current.model) : null);
      if (!base) throw failure('这个会话在桌面版里没有记录模型，先到桌面版里选一个再发', { status: 409 });
      const effort = input.reasoningEffort || (modelChanged ? target?.effort : current.effort);
      await this.call('session', 'selectModel', { request: { sessionId: id, provider: base.provider, model: base.model, ...(effort ? { reasoningEffort: effort } : {}) } });
    }
    const wantedPermission = input.permissionMode;
    if (wantedPermission && wantedPermission !== current.permissionMode) {
      await this.call('commands', 'execute', { agentId: id, line: `/permission ${wantedPermission}`, submittedAttachments: [] });
    }
    if (modelChanged || effortChanged || (wantedPermission && wantedPermission !== current.permissionMode)) {
      const after = (await this.row(id, true))?.settings;
      const modelOk = !target || !modelChanged || after?.model === modelId(target.provider, target.model);
      const effortOk = !effortChanged || after?.effort === input.reasoningEffort;
      const permissionOk = !wantedPermission || after?.permissionMode === wantedPermission;
      if (!modelOk || !effortOk || !permissionOk) {
        const missing = [!modelOk ? '模型' : '', !effortOk ? '推理强度' : '', !permissionOk ? '权限' : ''].filter(Boolean).join('、');
        throw failure(`我的桌面版没能把${missing}改过去，这条消息没有发出去：请到桌面版里改好再发`, { status: 502 });
      }
    }
  }
}
