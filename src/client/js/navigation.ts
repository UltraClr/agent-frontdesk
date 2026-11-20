import { promptStarts, type TurnMark } from '../../shared/turn-match.js';
import { t, say } from './i18n.js';
import type { ActivityEntry, CoordinatorTaskSummary, TimeValue, Usage } from '../../shared/contract.js';

export const viewKey = (engine: string, sessionId: string | null = null): string => JSON.stringify([engine, sessionId]);
/** Whether a key (as viewKey writes it) is one of this engine's views. */
export const isViewOf = (engine: string, key: string): boolean => key.startsWith(`${JSON.stringify([engine]).slice(0, -1)},`);
/** The part of Web Storage these books use (tests pass a Map-backed stand-in). */
export interface StoreLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
// What this page wrote under its own key earlier. Trust boundary: the page is the only writer of
// these keys, so the caller names the shape; JSON.parse returns any. A broken value reads as empty.
function read<T>(storage: StoreLike | null | undefined, key: string, fallback: T): T { try { return JSON.parse(storage?.getItem(key) || 'null') || fallback; } catch { return fallback; } }

/** A file the composer holds (an upload's answer), kept with the draft. */
/** An uploaded file (POST /api/upload answers with these: no local path, the server finds it by `filename`), or the part of one a test gives. */
/** `reference`: the attachment is another chat the console wrote out (the composer's "+"), drawn as a card naming it. */
export interface DraftAttachment { filename: string; originalname?: string; mimetype?: string; size?: number; url?: string; reference?: { agent: string; title: string; turns: number; tokens: number } }
export interface Draft { text: string; attachments: DraftAttachment[]; model?: string; effort?: string; picks?: { model?: string; effort?: string }; selectionStart?: number | null; selectionEnd?: number | null }

export class DraftBook {
  storage: StoreLike | null | undefined; key = 'desktop-bridge:drafts:v1'; entries: Map<string, Draft>;
  constructor(storage?: StoreLike | null) { this.storage = storage; this.entries = new Map(Object.entries(read<Record<string, Draft>>(storage, this.key, {}))); }
  get(key: string): Draft { return structuredClone(this.entries.get(key) || { text: '', attachments: [], model: '', effort: '' }); }
  set(key: string, value: Draft): void { this.entries.set(key, structuredClone(value)); this.persist(); }
  persist(): void { try { this.storage?.setItem(this.key, JSON.stringify(Object.fromEntries(this.entries))); } catch { /* In-memory drafts still survive switching if browser storage is full. */ } }
  append(key: string, files: DraftAttachment[]): void { const draft = this.get(key); draft.attachments = [...(draft.attachments || []), ...files]; this.set(key, draft); }
  clearSent(key: string, text: string, attachments: DraftAttachment[]): Draft {
    const draft = this.get(key), sent = new Set(attachments.map(item => item.filename));
    if (draft.text === text) draft.text = '';
    draft.attachments = (draft.attachments || []).filter(item => !sent.has(item.filename));
    this.set(key, draft); return draft;
  }
}
/** What decides whether a chat has news: its activity entry (or the same fields from elsewhere). */
export type ActivityLike = Pick<ActivityEntry, 'engine' | 'sessionId'> & Partial<Pick<ActivityEntry, 'completedAt' | 'lastMessageAt' | 'running'>>;
export const activityTime = (entry: { completedAt?: number; lastMessageAt?: number }) => Math.max(entry.completedAt || 0, entry.lastMessageAt || 0);
export const readTime = (value?: TimeValue | null) => typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value || '') || 0;
export function visibleReplyTime(turns: readonly { completedAt?: TimeValue | null; messages: readonly { at?: TimeValue | null }[] }[]) {
  return turns.reduce((at, turn) => turn.messages.reduce((latest, message) => Math.max(latest, readTime(message.at)),
    Math.max(at, readTime(turn.completedAt))), 0);
}
export class ReadMarkers {
  readonly key = 'desktop-bridge:read:v1';
  private readonly entries = new Map<string, number>();
  constructor(private readonly storage?: StoreLike | null) { this.reload(); }
  unread(entry: ActivityLike): boolean { return activityTime(entry) > (this.entries.get(viewKey(entry.engine, entry.sessionId)) || 0); }
  reload(): void { this.add(read<Record<string, number>>(this.storage, this.key, {})); }
  private add(entries: Record<string, number>): boolean {
    let changed = false;
    for (const [key, at] of Object.entries(entries)) {
      if (!Number.isFinite(at) || at <= (this.entries.get(key) || 0)) continue;
      this.entries.set(key, at);
      changed = true;
    }
    return changed;
  }
  merge(entries: Record<string, number>): boolean {
    this.reload();
    if (!this.add(entries)) return false;
    try { this.storage?.setItem(this.key, JSON.stringify(Object.fromEntries(this.entries))); } catch {}
    return true;
  }
  mark(engine: string, sessionId: string, timestamp = Date.now()): boolean {
    return this.merge({ [viewKey(engine, sessionId)]: timestamp });
  }
}
export function preferredSession(engine: string, sessions: ReadonlyArray<{ id: string }>, remembered: string | null | undefined, activity: ActivityLike[], markers: ReadMarkers): string | null {
  const unread = activity.filter(item => item.engine === engine && markers.unread(item)).sort((a, b) => activityTime(b) - activityTime(a));
  return unread[0]?.sessionId || remembered || activity.find(item => item.engine === engine && item.running)?.sessionId || sessions[0]?.id || null;
}
/** Attach each delivery to its dispatching turn, or to its marked return when restoring older records. */
export function deliveryReceipts(tasks: CoordinatorTaskSummary[], turns: TurnMark[]) {
  const byTurn = new Map<string, string>();
  const returns = new Map<string, string>();
  for (const turn of turns) {
    if (!turn.id) continue;
    byTurn.set(turn.id, turn.id);
    if (turn.nativeTurnId) byTurn.set(turn.nativeTurnId, turn.id);
    const match = turn.userPrompt?.replaceAll('\\', '').match(/^\[Frontdesk · ([a-zA-Z0-9-]+)\/reply\]/);
    if (match && promptStarts(turn.userPrompt, match[0])) returns.set(match[1]!, turn.id);
  }
  const receipts = new Map<string, CoordinatorTaskSummary[]>();
  for (const task of tasks) {
    if (!task.prompt) continue;
    const id = (task.sourceTurn && byTurn.get(task.sourceTurn)) || returns.get(task.id) || '';
    const group = receipts.get(id) || [];
    group.push(task); receipts.set(id, group);
  }
  return receipts;
}

/** Each target appears once, using its most recent unresolved task if it has one. */
export function coordinatorTargets(tasks: readonly CoordinatorTaskSummary[]): CoordinatorTaskSummary[] {
  const inactive = (state: string) => ['done', 'linked', 'not-sent', 'return-failed'].includes(state);
  const ordered = [...tasks].reverse().sort((a, b) =>
    Number(inactive(a.state)) - Number(inactive(b.state)) || (b.updatedAt || 0) - (a.updatedAt || 0));
  const seen = new Set<string>();
  return ordered.filter(task => {
    const key = viewKey(task.engine, task.target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
export function quotaLabel(usage: Usage | null | undefined): string {
  if (!usage?.available || !usage.windows?.length) return say(usage?.short) || (usage?.reason?.startsWith('暂时') ? t('额度暂不可用') : t('额度未公开'));
  // Without a time window (per-model quotas), the tightest model is what matters.
  const first = usage.windows[0];
  if (first && !first.windowMinutes) return `${first.label} ${Math.round(Number(first.remainingPercent))}%`;
  return usage.windows.slice(0, 2).map(window => {
    const minutes = window.windowMinutes ?? 0; // null and 0 both read as no window (—), as before
    const period = minutes >= 1440 ? `${Math.round(minutes / 1440)}d` : minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes || '—'}m`;
    return `${period} ${Math.round(Number(window.remainingPercent))}%`;
  }).join(' · ');
}
