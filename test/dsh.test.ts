import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { DshBridge } from '../src/server/dsh-bridge.js';
import { get } from '../src/shared/guards.js';

test('DSH companion and Frontdesk find each other under a custom DSH home', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-dsh-home-'));
  const userHome = path.join(dir, 'user-home'), dshHome = path.join(dir, 'dsh-home');
  const stateFile = path.join(dshHome, 'frontdesk-bridge.json');
  const companion = await import(pathToFileURL(path.resolve('integrations/dsh-frontdesk-bridge/index.js')).href);
  const variables = ['HOME', 'USERPROFILE', 'DSH_HOME', 'DSH_FRONTDESK_BRIDGE_FILE'] as const;
  const previous = variables.map(key => [key, process.env[key]] as const);
  let teardown: (() => Promise<void>) | undefined;
  const bridge = new DshBridge({ home: dshHome });
  t.after(async () => { bridge.dispose(); await teardown?.(); fs.rmSync(dir, { recursive: true, force: true }); });
  try {
    process.env.HOME = userHome;
    process.env.USERPROFILE = userHome;
    process.env.DSH_HOME = dshHome;
    delete process.env.DSH_FRONTDESK_BRIDGE_FILE;
    teardown = companion.apply({});
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  for (let i = 0; !fs.existsSync(stateFile) && i < 50; i++) await delay(10);
  assert.equal((await bridge.status()).connected, true);
  assert.equal(fs.existsSync(path.join(userHome, '.dsh', 'frontdesk-bridge.json')), false);
});

test('DSH uses the installed desktop bridge, searches without reading turns and tracks native outcomes', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-dsh-test-'));
  const stateFile = path.join(dir, 'bridge.json');
  const companion = await import(pathToFileURL(path.resolve('integrations/dsh-frontdesk-bridge/index.js')).href);
  const calls: string[] = [];
  const now = Date.now();
  let running = true;
  const events: Array<{ seq: number; type: string; data: unknown; time?: number }> = [
    { seq: 1, type: 'turn/start', time: now - 3000, data: { turn: 1 } },
    { seq: 2, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }] } },
    { seq: 3, type: 'assistant/message', time: now - 2000, data: { turn: 1, message: { content: [{ type: 'text', text: 'hello' }] } } },
  ];
  const teardown = companion.apply({
    connection: { createPeer: () => ({ dispose() {} }) },
    typertGateway: {
      async invoke({ namespace, method, args }: { namespace: string; method: string; args: unknown }) {
        calls.push(namespace + '/' + method);
        if (method === 'list') return { items: ['chat', 'archived'].map(sessionId => ({ sessionId, cwd: dir, running, updatedAt: now - 3000, projections: { values: { title: sessionId } } })) };
        if (method === 'prompt') {
          const rpcId = get(args, 'request', 'requestId');
          events.push({ seq: 5, type: 'agent/inbox/spliced', data: { target: 'next-step', inserted: [{ source: { kind: 'user', rpcId } }] } });
          return {};
        }
        if (method === 'projections') return { values: { userQuestions: { active: [{ callId: 'question', questions: [{ id: 'choice', question: 'Which?', options: [{ label: 'One' }] }] }] } } };
        if (method === 'answer') { assert.deepEqual(get(args, 'answer', 'answers'), [{ id: 'choice', selected: ['One'] }]); return true; }
        if (method === 'events') return { records: events.map(event => ({ event })), hasMore: false };
        if (method === 'create') { assert.equal(get(args, 'request', 'workspaceId'), 'project'); return { sessionId: 'new' }; }
        throw new Error('Unexpected operation ' + method);
      },
      async *stream() { yield { value: { items: [{ workspaceId: 'project', path: dir, title: 'Project', sessionIds: ['chat'] }], archivedSessionIds: ['archived'] } }; },
    },
  }, { stateFile });
  const bridge = new DshBridge({ bridgeFile: stateFile });
  t.after(async () => { bridge.dispose(); await teardown(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; !fs.existsSync(stateFile) && i < 50; i++) await delay(10);
  assert.equal((await bridge.status()).connected, true);
  assert.deepEqual((await bridge.catalog(dir)).map(item => item.id), ['chat']);
  assert.deepEqual(calls, ['session/list']);
  assert.deepEqual((await bridge.list())[0]?.metadata?.recentMessages,
    [{ id: 'm3-0', preview: 'hello', phase: 'commentary', at: now - 2000 }]);
  assert.equal((await bridge.read('chat')).turns[0]?.status, 'running');
  events.push({ seq: 4, type: 'turn/end', time: now - 1000, data: { turn: 1, reason: { kind: 'aborted' } } });
  const turn = (await bridge.read('chat')).turns[0];
  assert.equal(turn?.statusEvidence, 'turn/end:aborted');
  assert.equal(turn?.assistantReply, 'hello');
  running = false;
  assert.equal((await bridge.create({ cwd: dir })).id, 'new');
  assert.equal((await bridge.list())[0]?.metadata?.latestTurn?.completedAt, now - 1000, 'completion is noticed even when the last prompt timestamp is unchanged');
  assert.deepEqual(await bridge.steer('chat', { prompt: 'change direction', attachments: [] }), { shown: true });
  await assert.rejects(bridge.decide('chat', 'other:q-question', 'option:One'));
  await assert.rejects(bridge.decide('chat', 'chat:q-question', 'option:Missing'));
  await bridge.decide('chat', 'chat:q-question', 'option:One');
  await assert.rejects(bridge.call('commands', 'execute', { line: '/unrelated' }));
  assert.ok(!calls.includes('commands/execute'));
});
