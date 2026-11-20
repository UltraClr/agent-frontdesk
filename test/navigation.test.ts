import { test } from 'node:test';
import { EventHub } from '../src/server/core/event-hub.js';
import { ActivityFeed } from '../src/server/services/activity-feed.js';
import { UsageService } from '../src/server/services/usage-service.js';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { at, fake, hostOf, noRuns } from './support.js';
import type { ActivityEntry, ActivitySnapshot, RunTurn, SessionStatus, UnifiedSession, UsageWindow } from '../src/shared/contract.js';
import type { ActivityLike } from '../src/client/js/navigation.js';
const storage = () => { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) || null, setItem: (key: string, value: string) => data.set(key, value) }; };

test('coordinator sessions show the latest unfinished task per engine and session first', async () => {
  const { coordinatorTargets } = await import('../src/client/js/navigation.js');
  const tasks = [
    { id: 'old', engine: 'codex', target: 'target', state: 'queued', updatedAt: 10 },
    { id: 'running', engine: 'codex', target: 'target', state: 'sent', updatedAt: 20 },
    { id: 'finished', engine: 'codex', target: 'target', state: 'done', updatedAt: 30 },
    { id: 'distinct', engine: 'claude', target: 'target', state: 'done', updatedAt: 40 },
  ];
  assert.deepEqual(coordinatorTargets(tasks).map(task => task.id), ['running', 'distinct']);
});

test('drafts are isolated by engine and session and survive page reload', async () => {
  const { DraftBook, viewKey } = await import('../src/client/js/navigation.js'); const sessionStorage = storage();
  const drafts = new DraftBook(sessionStorage), codex = viewKey('codex', 'same-id'), claude = viewKey('claude', 'same-id');
  drafts.set(codex, { text: '未发送的架构需求', attachments: [{ filename: 'context.md' }], model: 'model', effort: 'high', selectionStart: 4 });
  drafts.set(claude, { text: '另一份未发送内容', attachments: [] });
  const restored = new DraftBook(sessionStorage);
  assert.equal(restored.get(codex).text, '未发送的架构需求'); assert.equal(restored.get(claude).text, '另一份未发送内容');
  assert.equal(at(restored.get(codex).attachments, 0).filename, 'context.md'); assert.equal(restored.get(codex).effort, 'high');
});
test('late uploads and late send success update their owning draft and keep subsequent typing', async () => {
  const { DraftBook } = await import('../src/client/js/navigation.js'); const drafts = new DraftBook(storage());
  drafts.set('a', { text: 'original', attachments: [{ filename: 'sent' }] });
  drafts.set('b', { text: 'other session', attachments: [] });
  drafts.set('a', { text: 'new draft typed while sending', attachments: [{ filename: 'sent' }] });
  drafts.append('a', [{ filename: 'late-upload' }]); drafts.clearSent('a', 'original', [{ filename: 'sent' }]);
  assert.equal(drafts.get('a').text, 'new draft typed while sending'); assert.deepEqual(drafts.get('a').attachments, [{ filename: 'late-upload' }]); assert.equal(drafts.get('b').text, 'other session');
});
test('unread completions select the relevant chat, clear only on reading and persist across reload', async () => {
  const { ReadMarkers, preferredSession } = await import('../src/client/js/navigation.js'); const local = storage(), markers = new ReadMarkers(local);
  const activity: [ActivityLike, ActivityLike] = [{ engine: 'codex', sessionId: 'completed', completedAt: 100, running: false }, { engine: 'claude', sessionId: 'other', completedAt: 90 }];
  assert.equal(preferredSession('codex', [], 'previous', activity, markers), 'completed');
  markers.mark('codex', 'completed', 100); assert.equal(markers.unread(activity[0]), false); assert.equal(markers.unread(activity[1]), true);
  assert.equal(new ReadMarkers(local).unread(activity[0]), false); assert.equal(preferredSession('codex', [], 'previous', activity, markers), 'previous');
});
test('read markers from another window merge without clearing newer replies', async () => {
  const { ReadMarkers, viewKey, visibleReplyTime } = await import('../src/client/js/navigation.js');
  const local = storage(), first = new ReadMarkers(local), second = new ReadMarkers(local);
  const time = 1_790_000_000_000;
  const visible = visibleReplyTime([{ messages: [{ at: time / 1000 }] }]);
  first.mark('dsh', 'a', visible);
  second.mark('dsh', 'b', visible);
  const restored = new ReadMarkers(local);
  restored.merge({ [viewKey('dsh', 'a')]: time - 1000 });
  assert.equal(restored.unread({ engine: 'dsh', sessionId: 'a', lastMessageAt: time }), false);
  assert.equal(restored.unread({ engine: 'dsh', sessionId: 'b', lastMessageAt: time }), false);
  assert.equal(restored.unread({ engine: 'dsh', sessionId: 'a', lastMessageAt: time + 2 }), true);
});
test('quota labels use remaining percentages and do not invent unavailable data', async () => {
  const { quotaLabel } = await import('../src/client/js/navigation.js');
  assert.equal(quotaLabel({ available: true, windows: [fake<UsageWindow>({ windowMinutes: 300, remainingPercent: 66 }), fake<UsageWindow>({ windowMinutes: 10080, remainingPercent: 50 })] }), '5h 66% · 7d 50%');
  assert.equal(quotaLabel({ available: false }), '额度未公开');
});
test('cross-engine activity keeps background completion state independent of the selected stream', async () => {
  const hub = new EventHub(), feed = new ActivityFeed(hostOf(), hub, noRuns());
  const snapshots: ActivitySnapshot[] = [], release = feed.subscribe(snapshot => snapshots.push(snapshot));
  hub.publish('codex', 'background', 'turn', 'run.started', { turn: fake<RunTurn>({ userPrompt: 'PRIVATE PROMPT' }) });
  assert.equal(at(feed.snapshot().sessions, 0).running, true);
  hub.publish('codex', 'background', 'turn', 'run.completed', {}); release();
  const entry = at(feed.snapshot().sessions, 0); assert.equal(entry.running, false); assert.ok((entry.completedAt || 0) > 0);
  assert.doesNotMatch(JSON.stringify(snapshots), /PRIVATE/); assert.equal(feed.clients, 0); assert.equal(feed.timer, null); feed.dispose();
});
test('native busy to idle does not invent completion without lifecycle evidence', async () => {
  const hub = new EventHub(); let status: SessionStatus = 'busy';
  const host = hostOf({ id: 'native', list: async () => [fake<UnifiedSession>({ id: 's', status, updatedAt: 'stable' })] });
  const feed = new ActivityFeed(host, hub, noRuns());
  await feed.poll(); assert.equal(at(feed.snapshot().sessions, 0).completedAt, 0);
  status = 'idle'; await feed.poll(); assert.equal(at(feed.snapshot().sessions, 0).completedAt, 0); feed.dispose();
});
test('late historical replies stay quiet and a new native reply keeps its own time', async () => {
  const hub = new EventHub(), now = Date.now(); let status: SessionStatus = 'idle', messages = [{ id: 'old', preview: 'yesterday', at: now - 86400000 }];
  const host = hostOf({ id: 'native', list: async () => [fake<UnifiedSession>({ id: 's', status, updatedAt: status, metadata: { turnStartedAt: now - 5000, recentMessages: messages } })] });
  const feed = new ActivityFeed(host, hub, noRuns());
  await feed.poll(); assert.equal(feed.snapshot().notices.length, 0, 'history at startup is not news');
  status = 'busy'; messages = [...messages, { id: 'late', preview: 'seen late', at: now - 7200000 }];
  await feed.poll();
  const entry = at(feed.snapshot().sessions, 0); assert.equal(entry.running, true); assert.equal(entry.startedAt, now - 5000);
  assert.equal(feed.snapshot().notices.length, 0, 'a second batch of old history is not news');
  assert.equal(entry.lastMessageAt, undefined);
  await delay(5);
  const sentAt = Date.now();
  messages = [...messages, { id: 'new', preview: 'new reply', at: sentAt }];
  await feed.poll();
  assert.equal(at(feed.snapshot().notices, 0).at, sentAt);
  assert.equal(at(feed.snapshot().sessions, 0).lastMessageAt, sentAt);
  feed.dispose();
});
test('quota requests share in-flight reads, cache results, and isolate unsupported providers', async () => {
  let calls = 0;
  const host = hostOf({ id: 'a', usage: async () => { calls++; return { available: true, windows: [] }; } }, { id: 'b' });
  const service = new UsageService(host);
  const [first, second] = await Promise.all([service.all(), service.all()]);
  await service.all(); assert.equal(calls, 1); assert.deepEqual(first, second); assert.equal(first['b']?.available, false);
});

test('native pending requests survive reading and clear on resolution or removal; idle history is never watched', async () => {
  let waiting: ActivityEntry['waitingFor'] = 'plan', listed = true, stopped = 0;
  const watched: string[] = [];
  const host = hostOf({ id: 'engine', list: async () => [
    fake<UnifiedSession>({ id: 'idle', status: 'idle' }),
    ...(listed ? [fake<UnifiedSession>({ id: 's', status: 'busy', metadata: { waitingFor: waiting } })] : []),
  ], watchSession: (id: string) => { watched.push(id); return () => { stopped++; }; } });
  const feed = new ActivityFeed(host, new EventHub(), noRuns());
  const release = feed.subscribe(() => {});
  await new Promise(resolve => setImmediate(resolve));
  const entry = () => feed.snapshot().sessions.find(s => s.sessionId === 's');
  assert.equal(entry()?.waitingFor, 'plan');
  const { ReadMarkers } = await import('../src/client/js/navigation.js');
  const markers = new ReadMarkers(storage()); markers.mark('engine', 's');
  assert.equal(entry()?.waitingFor, 'plan');
  waiting = undefined; await feed.poll(); assert.equal(entry()?.waitingFor, undefined);
  waiting = 'input'; await feed.poll(); assert.equal(entry()?.waitingFor, 'input');
  listed = false; await feed.poll(); assert.equal(entry()?.waitingFor, undefined);
  assert.deepEqual(watched, ['s']); assert.equal(stopped, 1);
  release(); feed.dispose();
});

test('dispatch receipts attach to exact source or marked return and keep unmatched deliveries separate', async () => {
  const { deliveryReceipts } = await import('../src/client/js/navigation.js');
  const task = { id: 'a', engine: 'engine', target: 'worker', state: 'sent', prompt: 'Do the work' };
  const receipts = deliveryReceipts([{ ...task, sourceTurn: 'native' }, { ...task, id: 'b' }, { ...task, id: 'c' }], [
    { id: 'web', nativeTurnId: 'native' }, { id: 'reply', userPrompt: '[Frontdesk · b/reply] returned' },
  ]);
  assert.equal(receipts.get('web')?.[0]?.id, 'a');
  assert.equal(receipts.get('reply')?.[0]?.id, 'b');
  assert.equal(receipts.get('')?.[0]?.id, 'c');
});
