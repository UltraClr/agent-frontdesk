import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { CreateInput, Engine, History, UnifiedTurn } from '../src/shared/contract.js';
import { loadConfig } from '../src/server/config.js';
import { EventHub } from '../src/server/core/event-hub.js';
import { PluginHost } from '../src/server/core/plugin-host.js';
import { RunService } from '../src/server/core/run-service.js';
import { createApp } from '../src/server/server.js';
import { Coordinator } from '../src/server/services/coordinator.js';
import { Groups } from '../src/server/services/groups.js';
import { EngineEvents, UnifiedSession, UnifiedTurn as NativeTurn } from '../src/server/types.js';
import { at, must, required, withStatus } from './support.js';

const exec = promisify(execFile);
const turn = (id: string, prompt: string, confirmed = false) => new NativeTurn({
  id, userPrompt: prompt, status: 'completed', statusEvidence: confirmed ? 'native' : null,
  assistantReply: 'Test result',
});

function setup(root: string) {
  const host = new PluginHost(), hub = new EventHub(), sends: Array<{ engine: string; id: string; prompt: string; emitter: EngineEvents }> = [];
  const histories = new Map<string, History>();
  const calls: string[] = [];
  const runs = new RunService(host, hub);
  const coordinator = new Coordinator(host, runs);
  function install(id: string, controller = true): Engine {
    const engineRoot = path.join(root, id);
    const workspace = path.join(engineRoot, 'agent-frontdesk', `${id}-controller`);
    const engine: Engine = {
      ...required, id, label: id, capabilities: { send: true }, projects: () => [{ id: 'p', name: 'Controller', cwd: workspace }],
      list: () => [...histories.values()].flatMap(({ session }) => session?.engine === id ? [session] : []),
      coordinator: {
        root: controller ? engineRoot : undefined,
        catalog: cwd => {
          calls.push(`catalog:${id}`);
          return [...histories.values()].flatMap(({ session }) => session?.engine === id && (!cwd || session.cwd === cwd)
            ? [{ id: session.id, title: session.title, cwd: session.cwd, updatedAt: session.updatedAt }] : []);
        },
        read: sessionId => {
          calls.push(`read:${id}:${sessionId}`);
          const history = histories.get(`${id}:${sessionId}`);
          if (!history) throw Object.assign(new Error('Chat missing'), { status: 404 });
          return history;
        },
      },
      create: (input: CreateInput) => {
        calls.push(`create:${id}`);
        const session = new UnifiedSession({ id: 'control', engine: id, cwd: input.cwd, status: 'idle' });
        histories.set(`${id}:control`, { session, turns: [] });
        return { id: 'control', cwd: input.cwd };
      },
      send(sessionId, input) {
        const emitter = new EngineEvents();
        sends.push({ engine: id, id: sessionId, prompt: input.prompt, emitter });
        return emitter;
      },
    };
    host.register(engine);
    return engine;
  }
  return { host, hub, runs, coordinator, histories, sends, calls, install };
}

test('opening controllers is lazy and restores each native session in its own project', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-test-'));
  const { host, coordinator, runs, histories, install, calls } = setup(root);
  t.after(async () => { await coordinator.dispose(); runs.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const a = install('first'), b = install('second'), c = install('third', false);
  const config = loadConfig();
  config.settingsFile = path.join(root, 'settings.json');
  const context = await createApp({ host, config });
  const server = context.app.listen(0, '127.0.0.1');
  t.after(async () => { await context.dispose(); server.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/coordinator`;
  const agents = await (await fetch(base)).json();
  assert.deepEqual(agents.map((item: { id: string; controller: boolean }) => [item.id, item.controller]), [[a.id, true], [b.id, true], [c.id, false]]);
  assert.deepEqual(calls, []);
  const view = await (await fetch(`${base}/first/open`, { method: 'POST' })).json();
  assert.equal(view.cwd, coordinator.directory(a));
  assert.equal(view.sessionId, null);
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(coordinator.directory(b)), false);
  for (const engine of [a, b]) {
    const created = await fetch(`${base}/${engine.id}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'Start' }) });
    assert.equal(created.status, 200);
  }
  const ordinary = await (await fetch(new URL('/api/sessions?engine=first', base))).json();
  assert.deepEqual(ordinary, { first: [] });
  const cold = new Coordinator(host, runs);
  t.after(() => cold.dispose());
  await assert.rejects(cold.open(a), withStatus(423));
  await context.dispose();
  calls.length = 0;
  assert.equal((await cold.open(a)).sessionId, 'control');
  assert.deepEqual(calls, ['read:first:control']);
  assert.notEqual(coordinator.directory(a), coordinator.directory(b));
  histories.delete('first:control');
  for (const id of ['candidate-a', 'candidate-b']) histories.set(`first:${id}`, {
    session: new UnifiedSession({ id, cwd: coordinator.directory(a), engine: 'first', title: id }), turns: [],
  });
  assert.deepEqual((await cold.open(a)).candidates, []);
  await assert.rejects(cold.bind(a, 'candidate-b'), withStatus(409));
  assert.equal((await cold.reset(a)).recovering, false);
  assert.equal((await cold.open(b)).sessionId, 'control');
});

test('CLI searches before it reads, deduplicates delivery, and returns a confirmed result after service restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-test-'));
  const { host, coordinator, runs, histories, sends, calls, install } = setup(root);
  const source = install('leader'), target = install('worker');
  t.after(async () => { await coordinator.dispose(); runs.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  await coordinator.create(source, { prompt: 'Coordinate' }, async input => source.create(input));
  await coordinator.create(target, { prompt: 'Another coordinator' }, async input => target.create(input));
  for (const [id, folder] of [['backend', 'server'], ['frontend', 'client']] as const) {
    histories.set(`worker:${id}`, { session: new UnifiedSession({ id, engine: 'worker', cwd: path.join(root, folder), title: 'Login callback', status: 'idle' }), turns: [] });
  }
  const cwd = coordinator.directory(source);
  const tool = path.resolve('src/server/services/controller-tool.mjs');
  const command = async (op: string, args = {}) => JSON.parse((await exec(process.execPath, [tool, op, JSON.stringify(args)], { cwd })).stdout);
  calls.length = 0;
  await assert.rejects(command('read', { engine: 'worker', id: 'backend' }));
  const found = await command('search', { engine: 'worker', query: 'Login', project: 'server' });
  assert.deepEqual(found.items.map((item: { id: string }) => item.id), ['backend']);
  assert.deepEqual(calls, ['catalog:worker']);
  const visible = await command('search', { engine: 'worker' });
  assert.equal(visible.items.length, 2);
  await command('read', { engine: 'worker', id: 'backend' });
  const entry = must(histories.get('worker:backend'));
  must(entry.session).status = 'busy';
  const request = { key: 'one', engine: 'worker', id: 'backend', prompt: 'Confirm the schema', followUp: true };
  const dispatch = turn('source-native', 'Ask the worker'); dispatch.status = 'running';
  must(histories.get('leader:control')).turns.push(dispatch);
  const sent = await command('send', request);
  assert.equal(sends.length, 0, 'a native busy turn delays the queued task');
  const summary = at(coordinator.tasks(source), 0);
  assert.equal(summary.title, 'Login callback');
  assert.equal(summary.target, 'backend');
  assert.equal(summary.prompt, request.prompt);
  assert.equal(summary.sourceTurn, 'source-native');
  assert.equal(summary.nativeTurn, undefined);
  assert.ok(summary.updatedAt);
  assert.equal((await command('send', request)).id, sent.id);
  await assert.rejects(command('send', { ...request, id: 'frontend' }));
  must(entry.session).status = 'idle';
  await coordinator.poll();
  const outgoing = at(sends, 0);
  assert.equal(outgoing.engine, 'worker');
  assert.equal(outgoing.id, 'backend');
  entry.turns.push(turn('native-task', outgoing.prompt));
  await coordinator.poll();
  assert.equal(at(coordinator.tasks(source), 0).nativeTurn, 'native-task');
  dispatch.status = 'completed';
  assert.equal(sends.length, 1, 'a completed label alone does not return a reply');
  await coordinator.dispose();

  // Restart with a fresh run service, keeping only workspace state and desktop history.
  const recoveredRuns = new RunService(host, new EventHub());
  const recovered = new Coordinator(host, recoveredRuns);
  t.after(async () => { await recovered.dispose(); recoveredRuns.dispose(); });
  entry.turns[0] = turn('native-task', outgoing.prompt, true);
  await recovered.poll();
  await recovered.poll();
  const returned = at(sends, 1);
  assert.equal(returned.engine, 'leader');
  assert.equal(returned.id, 'control');
  assert.match(returned.prompt, /Test result/);
  await recovered.poll();
  assert.equal(sends.length, 2, 'an unconfirmed callback is never retried');
  must(histories.get('leader:control')).turns.push(turn('return-turn', returned.prompt));
  await recovered.poll();
  assert.equal(at(recovered.tasks(source), 0).state, 'done');
  assert.equal(sends.length, 2);
});

test('one-off delivery records the native result and only a proven rejection ends an unacknowledged delivery', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-receipts-'));
  const { coordinator, runs, histories, sends, install } = setup(root);
  const source = install('leader'), target = install('worker', false);
  t.after(async () => { await coordinator.dispose(); runs.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  await coordinator.create(source, { prompt: 'Set up' }, input => Promise.resolve(source.create(input)));
  const { key } = JSON.parse(fs.readFileSync(path.join(coordinator.directory(source), '.frontdesk-controller-tool.json'), 'utf8'));
  const command = (op: string, args: object) => coordinator.command({ controller: source.id, key, op, args });
  const id = 'target';
  const history: History = { session: new UnifiedSession({ id, engine: target.id, cwd: root, status: 'idle' }), turns: [] };
  histories.set('worker:target', history);
  await command('search', { engine: target.id });
  const request = { engine: target.id, id, prompt: 'Check the spec' };
  await command('send', { ...request, key: 'quota' });
  await new Promise(resolve => setImmediate(resolve));
  const first = at(sends, 0);
  const quotaTurn = new NativeTurn({ id: 'quota', userPrompt: first.prompt, status: 'failed', statusEvidence: 'error_message' });
  quotaTurn.error = 'Quota reached';
  history.turns.push(quotaTurn);
  first.emitter.emit('completed', { turn: { status: 'failed', error: { message: 'Quota reached' } } });
  await coordinator.poll();
  await coordinator.poll();
  const receipt = at(coordinator.tasks(source), 0);
  assert.deepEqual([receipt.state, receipt.nativeTurn, receipt.outcome, receipt.error], ['done', 'quota', 'failed', 'Quota reached']);
  assert.deepEqual(sends.map(item => item.engine), ['worker']);
  await assert.rejects(command('send', { ...request, key: 'quota', followUp: true }), withStatus(409));

  await command('send', { ...request, key: 'rejected' });
  await new Promise(resolve => setImmediate(resolve));
  at(sends, 1).emitter.emit('error', Object.assign(new Error('Model unavailable'), { notSent: true }));
  const rejected = at(coordinator.tasks(source), 1);
  assert.deepEqual([rejected.state, rejected.nativeTurn, rejected.error], ['not-sent', undefined, 'Model unavailable']);

  await command('send', { ...request, key: 'unconfirmed' });
  await new Promise(resolve => setImmediate(resolve));
  at(sends, 2).emitter.emit('error', new Error('Connection lost'));
  await coordinator.poll();
  assert.equal(at(coordinator.tasks(source), 2).state, 'sent');
  assert.deepEqual(sends.map(item => item.engine), ['worker', 'worker', 'worker']);
});

test('an existing chat that becomes a group host is no longer an ordinary coordinator target', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-coordinator-roles-'));
  const { host, coordinator, runs, histories, sends, install } = setup(root);
  const source = install('leader'), target = install('worker', false);
  const groups = new Groups(path.join(root, 'groups.sqlite'), '', host, runs, async () => { throw new Error('Uses an existing host'); });
  coordinator.groups = groups;
  t.after(async () => { await coordinator.dispose(); await groups.dispose(); runs.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  await coordinator.create(source, { prompt: 'Set up' }, input => Promise.resolve(source.create(input)));
  const { key } = JSON.parse(fs.readFileSync(path.join(coordinator.directory(source), '.frontdesk-controller-tool.json'), 'utf8'));
  const command = (op: string, args: object = {}) => coordinator.command({ controller: source.id, key, op, args });
  for (const id of ['host', 'member']) {
    histories.set(`worker:${id}`, { session: new UnifiedSession({ id, title: id, engine: target.id, cwd: root, status: 'idle' }), turns: [] });
  }
  await command('search', { engine: target.id });
  await command('track', { engine: target.id, id: 'host', role: 'Review' });
  must(must(histories.get('worker:host')).session).status = 'busy';
  await command('send', { engine: target.id, id: 'host', key: 'queued-before', prompt: 'Review this' });
  await groups.create(target, { key: 'group', name: 'Review group', hostSession: 'host', members: [{ engine: target.id, id: 'member' }] });
  await coordinator.poll();
  assert.equal(at(coordinator.tasks(source), 0).state, 'not-sent');
  assert.deepEqual(await command('workers'), []);
  assert.deepEqual(await command('search', { engine: target.id, query: 'host' }), { items: [], nextOffset: null });
  await assert.rejects(command('read', { engine: target.id, id: 'host' }), withStatus(404));
  await assert.rejects(command('send', { role: 'Review', key: 'later', prompt: 'Review again' }), withStatus(404));
  assert.equal(sends.length, 0);
});

test('a coordinator cannot bind a worker in a different project', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-test-'));
  const { coordinator, runs, install, histories } = setup(root);
  t.after(async () => { await coordinator.dispose(); runs.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const source = install('leader');
  histories.set('leader:outside', { session: new UnifiedSession({ id: 'outside', cwd: root, engine: 'leader' }), turns: [] as UnifiedTurn[] });
  await assert.rejects(coordinator.bind(source, 'outside'), withStatus(409));
});

test('desktop setup keeps one marker and binds only the native first message in its own directory', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-test-'));
  const { coordinator, runs, histories, install, sends } = setup(root);
  t.after(async () => { await coordinator.dispose(); runs.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const source = install('leader'), cwd = coordinator.directory(source), opened: string[] = [];
  must(source.coordinator).prepare = (folder, prompt) => { assert.equal(folder, cwd); opened.push(prompt); };
  await assert.rejects(coordinator.create(source, { prompt: 'FIXTURE_WORKSPACE_PAYLOAD' }, () => { throw new Error('must not send'); }), withStatus(409));
  assert.equal((await coordinator.open(source)).desktopSetup, true);
  await coordinator.prepare(source);
  await coordinator.prepare(source);
  assert.equal(opened.length, 2);
  assert.equal(opened[0], opened[1]);
  assert.ok(!at(opened, 0).includes('FIXTURE_WORKSPACE_PAYLOAD'));
  assert.deepEqual(sends, []);
  function add(id: string, folder: string, prompts: string[]) {
    histories.set(`leader:${id}`, { session: new UnifiedSession({ id, engine: 'leader', cwd: folder }), turns: prompts.map(prompt => turn(id, prompt)) });
  }
  add('unrelated', cwd, ['Earlier chat', at(opened, 0)]);
  add('wrong-folder', root, [at(opened, 0)]);
  assert.equal((await coordinator.open(source)).sessionId, null);
  await assert.rejects(coordinator.bind(source, 'unrelated'), withStatus(409));
  await coordinator.reset(source);
  await coordinator.prepare(source);
  assert.notEqual(at(opened, 2), at(opened, 0));
  add('old-attempt', cwd, [at(opened, 0)]);
  add('confirmed', cwd, [at(opened, 2)]);
  assert.equal((await coordinator.open(source)).sessionId, 'confirmed');
  add('confirmed', root, [at(opened, 2)]);
  await assert.rejects(coordinator.messageInput(source, 'confirmed', { prompt: 'user task', attachments: [] }), withStatus(409));
  assert.deepEqual(sends, []);
});

test('an ambiguous send remains pending even on a 409 and an isolated profile cannot use its state', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-test-'));
  const { coordinator, host, runs, histories, install } = setup(root);
  const profile = new Coordinator(host, runs, { profile: 'preview' });
  const duplicate = new Coordinator(host, runs);
  t.after(async () => { await duplicate.dispose(); await profile.dispose(); await coordinator.dispose(); runs.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const source = install('leader'), cwd = coordinator.directory(source);
  let prompt = '';
  await assert.rejects(coordinator.create(source, { prompt: 'request' }, async input => {
    prompt = input.prompt || '';
    throw Object.assign(new Error('helper disconnected'), { status: 409 });
  }), withStatus(409));
  assert.equal((await coordinator.open(source)).canReset, true);
  await assert.rejects(duplicate.open(source), withStatus(423));
  assert.notEqual(profile.directory(source), cwd);
  assert.equal((await profile.open(source)).pending, false);
  assert.ok(profile.isProject(source, cwd));
  for (const id of ['first', 'second']) histories.set(`leader:${id}`, {
    session: new UnifiedSession({ id, cwd, engine: 'leader', title: id }), turns: [turn(id, prompt)],
  });
  await assert.rejects(coordinator.reset(source), withStatus(409));
  const view = await coordinator.open(source);
  assert.equal(view.sessionId, null);
  assert.deepEqual(view.candidates.map(item => item.id), ['first', 'second']);
  await coordinator.bind(source, 'second');
  assert.equal((await coordinator.open(source)).sessionId, 'second');
  assert.equal((await profile.open(source)).sessionId, null);
});

test('saved responsibilities route follow-ups to their original desktop chats after restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-workers-'));
  const { host, coordinator, runs, histories, sends, calls, install } = setup(root);
  const source = install('leader'), other = install('other-leader'), target = install('worker', false);
  t.after(async () => { await coordinator.dispose(); runs.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const leader of [source, other]) await coordinator.create(leader, { prompt: 'Set up' }, input => Promise.resolve(leader.create(input)));
  for (const [id, title] of [['ui', 'Interface'], ['api', 'Service API'], ['qa', 'Regression suite'], ['extra-api', 'Other API']] as const) {
    histories.set(`worker:${id}`, { session: new UnifiedSession({ id, title, engine: target.id, cwd: path.join(root, 'project'), status: 'idle' }), turns: [] });
  }
  const configPath = path.join(coordinator.directory(source), '.frontdesk-controller-tool.json');
  const key: string = JSON.parse(fs.readFileSync(configPath, 'utf8')).key;
  const command = (owner: Coordinator, op: string, args: object = {}) => owner.command({ controller: source.id, key, op, args });
  assert.deepEqual(await command(coordinator, 'workers'), []);
  await assert.rejects(command(coordinator, 'track', { engine: target.id, id: 'api', role: '后端' }), withStatus(400));
  await command(coordinator, 'search', { engine: target.id, project: 'project' });
  for (const [id, role, purpose] of [['ui', '前端', '界面与交互'], ['api', '后端', '接口参数和数据'], ['qa', '测试', '回归验收']]) {
    await command(coordinator, 'track', { engine: target.id, id, role, purpose });
  }
  assert.deepEqual(coordinator.tasks(source).map(row => [row.target, row.role, row.state]), [
    ['ui', '前端', 'linked'], ['api', '后端', 'linked'], ['qa', '测试', 'linked'],
  ]);
  assert.deepEqual(coordinator.tasks(other), []);
  assert.equal(sends.length, 0);
  await command(coordinator, 'track', { engine: target.id, id: 'ui', purpose: '展览现场动线' });
  await command(coordinator, 'track', { engine: target.id, id: 'qa' });
  await command(coordinator, 'track', { engine: target.id, id: 'extra-api', purpose: '访谈提纲' });
  await coordinator.dispose();

  const recoveredRuns = new RunService(host, new EventHub());
  const recovered = new Coordinator(host, recoveredRuns);
  t.after(async () => { await recovered.dispose(); recoveredRuns.dispose(); });
  await recovered.open(source);
  calls.length = 0;
  const workers = await command(recovered, 'workers');
  assert.ok(Array.isArray(workers));
  assert.deepEqual(workers.map(worker => [worker.id, 'role' in worker && worker.role]), [['api', '后端'], ['ui', '前端'], ['qa', '测试'], ['extra-api', undefined]]);
  assert.ok(workers.some(worker => worker.id === 'extra-api' && 'purpose' in worker && worker.purpose === '访谈提纲'));
  assert.deepEqual(calls, []);
  await assert.rejects(command(recovered, 'send', { engine: target.id, id: 'ui', role: '后端', key: 'mismatch', prompt: 'Wrong target' }), withStatus(404));
  const request = { role: '后端', key: 'update-api', prompt: 'Update the response fields' };
  const delivery = await command(recovered, 'send', { ...request, role: ' 后端 ' });
  assert.deepEqual(await command(recovered, 'send', request), delivery);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sends.map(item => [item.engine, item.id]), [['worker', 'api']]);
  assert.ok(calls.some(call => call === 'read:leader:control'));
  assert.ok(calls.every(call => ['read:worker:api', 'read:leader:control'].includes(call)));
  assert.equal(recovered.tasks(source).find(task => task.target === 'api')?.role, '后端');

  await command(recovered, 'search', { engine: target.id, query: 'Other API' });
  await command(recovered, 'track', { engine: target.id, id: 'extra-api', role: '后端' });
  await assert.rejects(command(recovered, 'send', { role: '后端', key: 'ambiguous', prompt: 'Check logs' }), withStatus(409));
  assert.equal(sends.length, 1);
  assert.deepEqual(await command(recovered, 'untrack', { engine: target.id, id: 'extra-api' }), { removed: true });
  assert.equal(recovered.tasks(source).some(task => task.target === 'extra-api'), false);
  await command(recovered, 'send', { engine: target.id, id: 'extra-api', key: 'interviews', prompt: '补上昨天的访谈记录' });
  const remembered = await command(recovered, 'workers');
  assert.ok(Array.isArray(remembered));
  assert.equal(remembered.filter(worker => worker.id === 'extra-api').length, 1);
  assert.ok(remembered.some(worker => worker.id === 'extra-api' && 'title' in worker && worker.title === 'Other API'
    && 'lastTask' in worker && worker.lastTask === '补上昨天的访谈记录'));
});
