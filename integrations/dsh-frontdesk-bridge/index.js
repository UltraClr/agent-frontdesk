// Loaded by the desktop profile. Only the documented Frontdesk operations are accepted.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'dsh-frontdesk-bridge';
export const inject = ['typertGateway', 'connection'];

const methods = new Set([
  'session/list', 'session/events', 'session/projections', 'session/modelCatalog',
  'session/selectModel', 'session/create', 'session/prompt', 'session/cancel',
  'userQuestions/answer', 'account/getState', 'account/getBalance',
]);

function permitted(route, namespace, method, args) {
  if (route === '/stream') return namespace === 'workspace' && method === 'follow';
  if (namespace === 'commands' && method === 'execute') {
    return typeof args.agentId === 'string' && /^\/permission (?:read-only|workspace-write|danger-full-access|auto)$/.test(args.line)
      && Array.isArray(args.submittedAttachments) && !args.submittedAttachments.length && Object.keys(args).every(k => ['agentId', 'line', 'submittedAttachments'].includes(k));
  }
  return methods.has(namespace + '/' + method);
}

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const file = config.stateFile || process.env.DSH_FRONTDESK_BRIDGE_FILE || join(home, 'frontdesk-bridge.json');
  const secret = randomBytes(32).toString('hex'), expected = Buffer.from(secret);
  const streams = new Set();
  let peer;
  const server = createServer(async (req, res) => {
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    try {
      const key = Buffer.from(String(req.headers['x-dsh-bridge'] || ''));
      if (key.length !== expected.length || !timingSafeEqual(key, expected)) return json(401, { ok: false });
      if (req.method === 'GET' && req.url === '/health') return json(200, { ok: true, pid: process.pid, version: 2 });
      if (req.method !== 'POST' || !['/invoke', '/stream'].includes(req.url)) return json(404, { ok: false });
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        if ((size += chunk.length) > 2 * 1024 * 1024) return json(413, { ok: false });
        chunks.push(chunk);
      }
      const { namespace, method, args } = JSON.parse(Buffer.concat(chunks).toString());
      if (typeof namespace !== 'string' || typeof method !== 'string' || !args || !permitted(req.url, namespace, method, args)) return json(403, { ok: false });
      peer ??= ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'answer' });
      const request = { namespace, method, args, peer };
      if (req.url === '/invoke') {
        const value = await ctx.typertGateway.invoke(request);
        return json(200, { ok: true, value: namespace === 'account' && method === 'getState' ? { status: value?.status } : value });
      }
      const controller = new AbortController();
      streams.add(res);
      res.on('close', () => { streams.delete(res); controller.abort(); });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.flushHeaders();
      for await (const frame of await ctx.typertGateway.stream({ ...request, signal: controller.signal })) {
        if (res.destroyed) break;
        res.write('data: ' + JSON.stringify(frame) + '\n\n');
      }
      res.end();
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) return res.end();
      json(400, { ok: false, error: { code: error.code, message: error.message } });
    }
  });
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = file + '.' + randomBytes(8).toString('hex');
        writeFileSync(tmp, JSON.stringify({ version: 2, pid: process.pid, port: server.address().port, secret }), { flag: 'wx', mode: 0o600 });
        renameSync(tmp, file);
        resolve();
      } catch (e) { server.close(); reject(e); }
    });
  });
  ready.catch(e => ctx.logger?.(name)?.warn?.(e.message));
  return async () => {
    await ready.catch(() => {});
    for (const res of streams) res.destroy();
    try { if (JSON.parse(readFileSync(file, 'utf8')).secret === secret) unlinkSync(file); } catch {}
    await new Promise(done => server.close(done));
    await peer?.dispose();
  };
}
