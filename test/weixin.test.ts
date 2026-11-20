import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get as httpGet, request } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { Engine, History } from '../src/shared/contract.js';
import { get } from '../src/shared/guards.js';
import { loadConfig } from '../src/server/config.js';
import { PluginHost } from '../src/server/core/plugin-host.js';
import { createApp } from '../src/server/server.js';
import { WeixinApi, weixinBase } from '../src/server/services/weixin-api.js';
import { EngineEvents, UnifiedSession, UnifiedTurn } from '../src/server/types.js';
import { must, required } from './support.js';

const account = 'scanner-user';
const bot = 'fixture@im.bot';
const token = 'fixture-token';
const headers = { 'Content-Type': 'application/json' };
const post = (body: object) => ({ method: 'POST', headers, body: JSON.stringify(body) });

function incoming(id: number, text: string, extras: object = {}) {
  return { from_user_id: account, to_user_id: bot, message_type: 1, message_id: id, context_token: `ctx-${id}`,
    create_time_ms: Date.now(), item_list: [{ type: 1, text_item: { text } }], ...extras };
}

async function checkSoon(condition: () => boolean | Promise<boolean>, message: string, timeout = 6500) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await condition()) return;
    await delay(20);
  }
  assert.fail(message);
}

function transport() {
  const incomingBatches: unknown[][] = [];
  const outgoing: unknown[] = [], cursors: unknown[] = [], requests: string[] = [];
  let supplied = 0, failReply = false, failPoll = false;
  const api = new WeixinApi(async (input, init) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    const auth = new Headers(init?.headers).get('Authorization');
    const json = (value: object) => Response.json(value);
    if (url.pathname.endsWith('/get_bot_qrcode')) {
      assert.equal(init?.method, 'POST');
      assert.equal(url.searchParams.get('bot_type'), '3');
      assert.deepEqual(get(body, 'local_token_list'), []);
      assert.equal(auth, null);
      return json({ qrcode: 'confirmation-fixture', qrcode_img_content: 'https://ilinkai.weixin.qq.com/fixture-scan' });
    }
    if (url.pathname.endsWith('/get_qrcode_status')) {
      assert.equal(auth, null);
      assert.equal(url.searchParams.get('qrcode'), 'confirmation-fixture');
      if (!url.searchParams.has('verify_code')) return json({ status: 'need_verifycode' });
      assert.equal(url.searchParams.get('verify_code'), '123456');
      return json({ status: 'confirmed', bot_token: token, ilink_bot_id: bot, ilink_user_id: account, baseurl: 'https://ilinkai.weixin.qq.com' });
    }
    assert.equal(auth, `Bearer ${token}`);
    assert.equal(get(body, 'base_info', 'bot_agent'), 'AgentFrontdesk');
    if (/\/notify(start|stop)$/.test(url.pathname)) return json({ ret: 0 });
    if (url.pathname.endsWith('/getupdates')) {
      const cursor = get(body, 'get_updates_buf');
      cursors.push(cursor);
      if (failPoll) { failPoll = false; return new Response(null, { status: 503 }); }
      const messages = incomingBatches.shift();
      return json({ ret: 0, msgs: messages || [], get_updates_buf: messages ? `cursor-${++supplied}` : cursor });
    }
    if (url.pathname.endsWith('/sendmessage')) {
      const message = get(body, 'msg');
      assert.equal(get(message, 'to_user_id'), account);
      assert.equal(get(message, 'message_type'), 2);
      outgoing.push(message);
      if (failReply) { failReply = false; return json({ ret: -2 }); }
      return json({ ret: 0 });
    }
    throw new Error('Unexpected fixture request');
  });
  const texts = () => outgoing.map(message => String(get(message, 'item_list', 0, 'text_item', 'text')));
  return { api, incomingBatches, outgoing, texts, cursors, requests, failPoll: () => { failPoll = true; }, failReply: () => { failReply = true; } };
}

test('WeChat blocks unknown credential hosts', () => {
  assert.throws(() => weixinBase('https://weixin.qq.com.evil.example'));
  assert.throws(() => weixinBase('https://secret@ilinkai.weixin.qq.com'));
  assert.equal(weixinBase('ilinkai.weixin.qq.com'), 'https://ilinkai.weixin.qq.com');
});

test('WeChat pairs locally, routes to the chosen coordinator, and recovers native results after restart', { timeout: 22000 }, async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-weixin-'));
  const file = path.join(folder, 'weixin', 'state.json'), bridge = transport();
  const histories = new Map<string, History>();
  const sends: { engine: string; session: string; prompt: string; model?: string; emitter: EngineEvents }[] = [];
  let current: Awaited<ReturnType<typeof createApp>> | undefined;
  let teardown: (() => Promise<void>) | undefined;
  t.after(async () => { await teardown?.(); fs.rmSync(folder, { recursive: true, force: true }); });
  function install(host: PluginHost, name: string, root?: string) {
    const read = (id: string) => must(histories.get(`${name}/${id}`));
    const engine: Engine = { ...required, id: name, label: name, capabilities: { send: true }, read,
      coordinator: {
        root, read, modelForSend: () => 'desktop-model',
        catalog: cwd => [...histories.values()].flatMap(({ session }) => session?.engine === name && (!cwd || session.cwd === cwd)
          ? [{ id: session.id, cwd: session.cwd, title: session.title, updatedAt: session.updatedAt }] : []),
      },
      create(input) {
        const id = 'control', session = new UnifiedSession({ id, engine: name, cwd: input.cwd, status: 'idle' });
        histories.set(`${name}/${id}`, { session, turns: [] });
        return { id, cwd: session.cwd };
      },
      send(session, input) {
        const emitter = new EngineEvents();
        sends.push({ engine: name, session, prompt: input.prompt, model: input.model, emitter });
        return emitter;
      },
    };
    host.register(engine);
  }
  async function boot() {
    const host = new PluginHost();
    install(host, 'codex', path.join(folder, 'codex'));
    install(host, 'antigravity', path.join(folder, 'antigravity'));
    install(host, 'worker');
    const app = current = await createApp({ host, config: { ...loadConfig(), settingsFile: path.join(folder, 'settings.json') },
      weixin: { file, api: bridge.api, interval: 20 } });
    const server = app.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}/api/coordinator`;
    const channel = `${base}/channels/weixin`;
    teardown = async () => { teardown = undefined; await app.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); };
    return { base, channel, view: async () => (await fetch(channel)).json() };
  }
  let http = await boot();
  assert.equal(get(await http.view(), 'state'), 'disconnected');
  assert.deepEqual(bridge.requests, []);
  assert.equal((await fetch(http.channel, post({ engine: 'codex', sessionId: 'ordinary-chat' }))).status, 409);
  const unsafeHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpGet(http.channel, { headers: { Host: 'not-local.example' } }, res => {
      res.resume(); resolve(res.statusCode);
    });
    req.on('error', reject);
  });
  assert.equal(unsafeHost, 403);
  for (const engine of ['codex', 'antigravity']) {
    assert.equal((await fetch(`${http.base}/${engine}/session`, post({ prompt: 'Set up' }))).status, 200);
  }
  const remote = { engine: 'codex', sessionId: 'control' };
  assert.equal((await fetch(http.channel, post(remote))).status, 202);
  await checkSoon(async () => get(await http.view(), 'state') === 'verify', 'WeChat asks for the phone PIN');
  assert.match(String(get(await http.view(), 'qr')), /^data:image\/png;base64,/);
  assert.equal((await fetch(`${http.channel}/verify`, post({ pin: 'no' }))).status, 400);
  assert.equal((await fetch(`${http.channel}/verify`, post({ pin: '123456' }))).status, 200);
  await checkSoon(async () => get(await http.view(), 'state') === 'connected', 'The private bot connected');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(await http.view()).includes(token));
  await fetch(`${http.base}/antigravity/open`, { method: 'POST' });
  assert.equal(get(await http.view(), 'engine'), 'codex', 'opening another coordinator keeps the explicit binding');
  bridge.failPoll();
  await checkSoon(async () => get(await http.view(), 'state') === 'reconnecting', 'A temporary transport error is visible');

  const valid = incoming(4, '问一下登录回调的进度');
  bridge.incomingBatches.push([
    incoming(1, 'unapproved sender', { from_user_id: 'someone-else' }),
    incoming(2, 'group chatter', { group_id: 'some-group' }),
    incoming(3, 'bot echo', { message_type: 2 }),
    valid, valid,
  ]);
  await checkSoon(() => sends.length === 1, 'Only the approved private message reached the coordinator');
  const first = must(sends[0]);
  assert.equal(first.engine, 'codex');
  assert.equal(first.model, 'desktop-model');
  assert.match(first.prompt, /^\[Frontdesk · weixin\/[a-f0-9-]+\]\n问一下登录回调的进度$/);
  const chat = must(histories.get('codex/control'));
  const initial = new UnifiedTurn({ id: 'root', userPrompt: first.prompt, status: 'running', statusEvidence: 'native_running',
    approvals: [{ id: 'ask', kind: 'input', title: 'Which login?', detail: '', decisions: ['desktop'] }] });
  chat.turns.push(initial);
  await checkSoon(() => bridge.texts().some(text => text.includes('等待你的回答')), 'The private chat receives the native waiting status');
  assert.equal(get(bridge.outgoing[0], 'context_token'), 'ctx-4');

  // Start a child while the source turn is still active. Using the included CLI side of
  // the socket exercises the exact tool path without contacting a real desktop agent.
  const worker: History = { session: new UnifiedSession({ id: 'login', engine: 'worker', cwd: path.join(folder, 'login'), title: 'Login callback', status: 'idle' }), turns: [] };
  histories.set('worker/login', worker);
  const config: { address: string; key: string } = JSON.parse(fs.readFileSync(path.join(folder, 'codex', 'agent-frontdesk', 'codex-controller', '.frontdesk-controller-tool.json'), 'utf8'));
  const command = (op: string, args: object) => new Promise<unknown>((resolve, reject) => {
    const payload = JSON.stringify({ controller: 'codex', key: config.key, op, args });
    const req = request({ socketPath: config.address, path: '/', method: 'POST', headers }, res => {
      let body = '';
      res.on('data', chunk => { body += String(chunk); });
      res.on('end', () => res.statusCode === 200 ? resolve(JSON.parse(body)) : reject(new Error(body)));
    });
    req.on('error', reject);
    req.end(payload);
  });
  await command('search', { engine: 'worker', query: 'Login' });
  await command('send', { engine: 'worker', id: 'login', prompt: '回复回调进度', key: 'login', followUp: true });
  await checkSoon(() => sends.length === 2, 'The coordinator dispatched to its worker');
  const child = must(sends[1]);
  assert.equal(child.engine, 'worker');
  initial.approvals = [];
  initial.status = 'completed'; initial.statusEvidence = 'completed_at'; initial.assistantReply = '已经派发。';
  first.emitter.emit('completed', {});
  await checkSoon(() => bridge.texts().includes('已经派发。'), 'The first native reply reached the same WeChat chat');
  assert.equal(must(current).runs.get('codex', 'control'), undefined);

  // Restart with the delegated result still outstanding; the connector must retain
  // the reply channel, reuse the polling cursor, and ignore a replay of the user task.
  await teardown?.();
  const pollsBeforeRestart = bridge.cursors.length;
  http = await boot();
  await checkSoon(() => bridge.cursors.length > pollsBeforeRestart, 'The bot resumed polling');
  assert.equal(bridge.cursors[pollsBeforeRestart], 'cursor-1');
  const childTurn = new UnifiedTurn({ id: 'child', userPrompt: child.prompt, status: 'running',
    approvals: [{ id: 'child-plan', kind: 'plan', title: 'Implement this plan?', detail: '', decisions: ['desktop'] }] });
  worker.turns.push(childTurn);
  bridge.incomingBatches.push([valid]);
  await checkSoon(() => bridge.texts().some(text => text.startsWith('Login callback') && text.includes('等待确认计划')),
    'The child approval reached the original WeChat request');
  Object.assign(childTurn, { status: 'completed', statusEvidence: 'completed_at', assistantReply: '回调测试通过。', approvals: [] });
  await checkSoon(() => sends.length === 3, 'The coordinator was resumed with the native child result', 8000);
  const returned = must(sends[2]);
  assert.equal(returned.engine, 'codex');
  assert.match(returned.prompt, /回调测试通过/);
  chat.turns.push(new UnifiedTurn({ id: 'return', userPrompt: returned.prompt, status: 'completed', statusEvidence: 'completed_at', assistantReply: '登录回调已经通过测试。' }));
  returned.emitter.emit('completed', {});
  await checkSoon(() => bridge.texts().includes('登录回调已经通过测试。'), 'The delegated final result went back to the original WeChat request');
  assert.ok(bridge.outgoing.every(out => get(out, 'context_token') === 'ctx-4'));
  assert.equal(bridge.texts().filter(text => text === '已经派发。').length, 1);

  // Business-level send failure on HTTP 200 must not be reported or replayed as success.
  bridge.failReply();
  bridge.incomingBatches.push([incoming(5, '', { item_list: [{ type: 2 }] })]);
  await checkSoon(async () => get(await http.view(), 'deliveryUncertain') === true, 'Uncertain outbound delivery is shown in Frontdesk');
  await delay(80);
  assert.equal(bridge.texts().filter(text => text.includes('接收文本')).length, 1);
  assert.equal((await fetch(http.channel, { method: 'DELETE' })).status, 200);
  assert.equal(get(await http.view(), 'state'), 'disconnected');
  assert.equal(fs.existsSync(file), false);
});
