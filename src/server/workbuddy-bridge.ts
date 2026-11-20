import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import type { CreateInput, History, SendInput } from '../shared/contract.js';
import { failure, get, list, parseJson, str } from '../shared/guards.js';
import { openLink } from './services/desktop-places.js';
import { readSqlite } from './services/sqlite-reader.js';
import { EngineEvents, UnifiedSession, UnifiedStep, UnifiedTurn, assignPhases } from './types.js';

type Row = Record<string, unknown>;
const validId = (id: string) => /^[\w-]{1,128}$/.test(id);
const safeStatus = new Map([['completed', 'completed'], ['error', 'failed'], ['terminated', 'interrupted']]);
const now = (value: unknown) => typeof value === 'number' || typeof value === 'string' ? value : null;
const textContent = (record: unknown, type: 'input_text' | 'output_text') => list(get(record, 'content'))
  .filter(part => get(part, 'type') === type).map(part => str(get(part, 'text')) || '').filter(Boolean).join('\n');
function userText(record: unknown) {
  const raw = textContent(record, 'input_text');
  if (/^\s*<cb_summary\b/.test(raw)) return '';
  // The desktop wraps a person's input with private runtime context. Only its visible
  // user query belongs in the console or in a coordinator search result.
  const prompt = raw.replace(/^(?:\s*<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>)+\s*/, '');
  return prompt.match(/^<user_query>([\s\S]*)<\/user_query>\s*$/)?.[1] ?? prompt;
}
const assistantText = (record: unknown) => textContent(record, 'output_text').replace(/\s*\[wbs-reply-done\]:\s*#\s*$/, '');
const output = (value: unknown) => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
export const workBuddySendBlocked = '请在 WorkBuddy 桌面端发送消息';
const unavailable = (message: string, status = 409) => failure(message, { status, notSent: true });

export class WorkBuddyBridge {
  private index?: { until: number; files: Map<string, string> };
  readonly database: string;

  constructor(readonly home = path.join(os.homedir(), '.workbuddy')) {
    this.database = path.join(home, 'workbuddy.db');
  }

  private rows(where = '', values: string[] = []) {
    if (!fs.existsSync(this.database)) return [];
    return readSqlite(this.database, `SELECT id,cwd,title,custom_title,status,created_at,updated_at,last_activity_at,model,permission_mode,
      EXISTS (SELECT 1 FROM workspaces WHERE path = sessions.cwd) AS in_workspace
      FROM sessions WHERE deleted_at IS NULL AND transport = 'local' ${where} ORDER BY COALESCE(last_activity_at,updated_at,created_at) DESC`, values);
  }

  get available() { return fs.existsSync(this.database); }

  private session(row: Row): UnifiedSession {
    const desktop = { model: str(row.model) || undefined, permissionMode: str(row.permission_mode) || undefined };
    const cwd = str(row.cwd) || '', running = row.status === 'running';
    const group = cwd && row.in_workspace ? { id: cwd, cwd, name: path.basename(cwd) || cwd } : null;
    return new UnifiedSession({ id: String(row.id), engine: 'workbuddy', cwd,
      title: str(row.custom_title) || str(row.title) || '新建聊天',
      updatedAt: now(row.last_activity_at ?? row.updated_at ?? row.created_at) ?? '',
      status: running ? 'busy' : 'idle', isDesktopActive: running, metadata: { desktop, group } });
  }

  catalog(cwd?: string) {
    return this.rows(cwd ? 'AND cwd = ?' : '', cwd ? [cwd] : []).filter(row => validId(String(row.id))).map(row => {
      const { id, title, cwd, updatedAt } = this.session(row);
      return { id, title, cwd, updatedAt };
    });
  }

  list() { return this.rows().filter(row => validId(String(row.id))).map(row => this.session(row)); }

  projects() {
    if (!this.available) return [];
    return readSqlite(this.database, 'SELECT path FROM workspaces ORDER BY last_opened_at DESC')
      .map(row => str(row.path)).filter((cwd): cwd is string => !!cwd)
      .map(cwd => ({ id: cwd, cwd, name: path.basename(cwd) || cwd }));
  }

  private transcript(id: string) {
    if (!this.index || this.index.until < Date.now() || !this.index.files.has(id)) {
      const files = new Map<string, string>(), root = path.join(this.home, 'projects');
      const duplicates = new Set<string>();
      if (fs.existsSync(root)) for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const project = path.join(root, entry.name);
        for (const file of fs.readdirSync(project, { withFileTypes: true })) {
          if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
          const native = file.name.slice(0, -6);
          if (files.has(native)) duplicates.add(native);
          files.set(native, path.join(project, file.name));
        }
      }
      for (const native of duplicates) files.delete(native);
      this.index = { until: Date.now() + 8000, files };
    }
    return this.index.files.get(id);
  }

  async read(id: string): Promise<History> {
    const row = validId(id) && this.rows('AND id = ?', [id])[0];
    if (!row) throw unavailable('找不到这个 WorkBuddy 会话', 404);
    const session = this.session(row), turns: UnifiedTurn[] = [];
    const file = this.transcript(id);
    if (!file) return { session, turns };
    const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    let turn: UnifiedTurn | undefined;
    let tools = new Map<string, UnifiedStep>();
    for await (const line of lines) {
      let record: unknown;
      try { record = parseJson(line); } catch { continue; }
      if (get(record, 'sessionId') !== id) continue;
      const kind = get(record, 'type'), role = get(record, 'role');
      const native = str(get(record, 'id')), at = now(get(record, 'timestamp'));
      if (!native) continue;
      if (kind === 'message' && role === 'user') {
        const prompt = userText(record);
        const hasImages = list(get(record, 'content')).some(part => ['input_image', 'image_blob_ref'].includes(String(get(part, 'type'))));
        if (!prompt && !hasImages) continue;
        turn = new UnifiedTurn({ id: native, userPrompt: prompt, timestamp: at || '', status: 'unknown' });
        turns.push(turn);
        tools = new Map();
      } else if (turn && kind === 'message' && role === 'assistant') {
        const text = assistantText(record);
        if (text && get(record, 'status') !== 'incomplete') {
          turn.messages.push({ id: native, text, at: at || '' });
          turn.timeline.push({ kind: 'message', id: native });
        }
      } else if (turn && kind === 'function_call') {
        const name = str(get(record, 'name')) || '';
        const raw = get(record, 'arguments');
        let input = raw;
        if (typeof raw === 'string') try { input = parseJson(raw); } catch { /* The tool may use plain text. */ }
        const step = new UnifiedStep({ id: native, type: 'tool_call', name, input, status: 'unknown' });
        const callId = str(get(record, 'callId'));
        if (callId) tools.set(callId, step);
        turn.steps.push(step);
        turn.timeline.push({ kind: 'activity', id: native });
      } else if (turn && kind === 'function_call_result') {
        const step = tools.get(str(get(record, 'callId')) || '');
        if (step) {
          step.output = output(get(record, 'output'));
          const status = str(get(record, 'status')) || '';
          step.status = status === 'completed' ? 'completed' : status === 'error' || status === 'failed' ? 'failed' : 'unknown';
        }
      }
    }
    if (turn) {
      // The database describes the latest run. Earlier messages can end after a tool or
      // fail before the next user message, so a new user message is not completion evidence.
      const native = str(row.status) || '';
      const end = safeStatus.get(native);
      if (end) {
        turn.status = end;
        turn.statusEvidence = 'workbuddy_session_status';
        turn.completedAt = now(row.last_activity_at ?? row.updated_at);
      } else if (native === 'running') turn.status = 'running';
    }
    for (const item of turns) assignPhases(item);
    return { session, turns };
  }

  async show(id: string) {
    if (!validId(id) || !this.rows('AND id = ?', [id])[0]) throw unavailable('找不到这个 WorkBuddy 会话', 404);
    await openLink('workbuddy://chat/' + encodeURIComponent(id), { foreground: true });
    return { pressed: true };
  }

  create(_input: CreateInput): never {
    throw unavailable('请在 WorkBuddy 桌面端新建会话');
  }

  send(_id: string, _input: SendInput) {
    const events = new EngineEvents();
    queueMicrotask(() => events.emit('error', unavailable(workBuddySendBlocked)));
    return events;
  }
}
