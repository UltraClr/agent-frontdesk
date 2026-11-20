import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NativePendingRequest } from '../src/shared/inbox.js';
import { PluginHost } from '../src/server/core/plugin-host.js';
import { Inbox } from '../src/server/services/inbox.js';
import { required } from './support.js';

test('inbox discovers lazily, merges native requests across sources and keeps last evidence on disconnect', async () => {
  const host = new PluginHost();
  let native: NativePendingRequest[] = [{ sessionId: 'one', requestId: 'ask', kind: 'plan', sessionTitle: 'A plan' }];
  let offline = false, discovery = 0;
  host.register({ ...required, id: 'codex', label: 'Codex', capabilities: {}, list: () => { throw new Error('Unexpected history scan'); },
    listWaiting: () => { discovery++; if (offline) throw new Error('Offline'); return native; } });
  host.register({ ...required, id: 'claude', label: 'Claude', capabilities: {}, list: () => { throw new Error('Unexpected history scan'); } });
  const inbox = new Inbox(host, () => [
    { engine: 'codex', sessionId: 'one', kind: 'input' },
    { engine: 'codex', sessionId: 'one', requestId: 'ask', kind: 'approval', source: { href: '#group/one', title: 'Group' } },
    { engine: 'codex', sessionId: 'one', requestId: 'ask', kind: 'plan', source: { href: '#coordinator/codex', title: 'Codex' } },
    { engine: 'claude', sessionId: 'two', requestId: 'ask', kind: 'approval' },
    { engine: 'claude', sessionId: 'two', kind: 'delivery', operationId: 'work-one', title: 'Lost receipt' },
  ]);
  assert.equal(discovery, 0);
  const [first, again] = await Promise.all([inbox.read(), inbox.read()]);
  assert.equal(discovery, 1);
  assert.equal(first, again);
  assert.equal(first.items.length, 3);
  const plan = first.items.find(item => item.engine === 'codex');
  assert.equal(plan?.kind, 'plan');
  assert.equal(plan?.sources.length, 2);
  assert.equal(first.coverage.find(item => item.engine === 'claude')?.mode, 'tracked');
  offline = true;
  const cached = await inbox.read();
  assert.equal(cached.coverage.find(item => item.engine === 'codex')?.checkedAt, first.coverage.find(item => item.engine === 'codex')?.checkedAt);
  assert.equal(cached.coverage.find(item => item.engine === 'codex')?.offline, true);
  assert.equal(cached.items.find(item => item.engine === 'codex')?.requestId, 'ask');
  offline = false;
  native = [];
  const resolved = await inbox.read();
  assert.equal(resolved.items.some(item => item.engine === 'codex'), false);
});

test('a newer exact request supersedes a stale request in the same native session', async t => {
  for (const coarse of [false, true]) await t.test(coarse ? 'after a session-level flag' : 'from one exact request to the next', async () => {
    const host = new PluginHost();
    const a = { sessionId: 'one', kind: 'approval' as const, requestId: 'A' };
    const b = { sessionId: 'one', kind: 'approval' as const, requestId: 'B' };
    let native: NativePendingRequest[] = [a];
    let offline = false;
    host.register({ ...required, id: 'dsh', label: 'DSH', capabilities: {}, list: () => [],
      listWaiting: () => { if (offline) throw new Error('Offline'); return native; } });
    const inbox = new Inbox(host, () => [{ ...a, engine: 'dsh', source: { href: '#group/one', title: 'Group' } }]);
    assert.deepEqual((await inbox.read()).items.map(item => item.requestId), ['A']);
    if (coarse) {
      native = [{ sessionId: a.sessionId, kind: a.kind }];
      assert.deepEqual((await inbox.read()).items.map(item => item.requestId), ['A'], 'a coarse flag is not a resolution');
    }
    native = [b];
    assert.deepEqual((await inbox.read()).items.map(item => item.requestId), ['B']);
    offline = true;
    assert.deepEqual((await inbox.read()).items.map(item => item.requestId), ['B'], 'disconnect does not resurface the resolved request');
    offline = false;
    native = [];
    assert.deepEqual((await inbox.read()).items, []);
  });
});
