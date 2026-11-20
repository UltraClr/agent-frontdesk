import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import type { Approval, UnifiedTurn, WeixinView } from '../../shared/contract.js';
import type { PluginHost } from '../core/plugin-host.js';
import { sessionBusy, type RunService } from '../core/run-service.js';
import { Coordinator, coordinatorMarker } from './coordinator.js';
import { WeixinApi, WeixinError, weixinBase, type WeixinAccount, type WeixinMessage } from './weixin-api.js';

interface Target { engine: string; sessionId: string }
interface Outgoing {
  key: string;
  id: string;
  text?: string;
  state: 'ready' | 'sending' | 'sent' | 'uncertain';
}
interface Job {
  id: string;
  key: string;
  context: string;
  prompt?: string;
  submittedAt?: number;
  resolved?: boolean;
  outbox: Outgoing[];
}
interface Saved extends Target { account: WeixinAccount; after: number; cursor: string; jobs: Job[] }
interface Connection { data: Saved; abort: AbortController; state: WeixinView['state']; note?: string }
interface Pairing extends Target {
  abort: AbortController;
  after: number;
  qr?: string;
  pin?: string;
  state: 'pairing' | 'scanned' | 'verify';
}

const issue = (message: string, status = 409) => Object.assign(new Error(message), { status });
const paused = '总控会话暂不可用，微信消息会保留';
const retry = '微信连接暂时中断，正在重连';
const turnRef = /^\[Frontdesk · ([^\]\r\n]+)\]/;
const finished = (turn: UnifiedTurn) => !!turn.statusEvidence && ['completed', 'failed', 'interrupted'].includes(turn.status);

export function weixinFile(settingsFile: string, profile = ''): string {
  const key = createHash('sha256').update(JSON.stringify([path.resolve(settingsFile), profile])).digest('hex').slice(0, 24);
  return path.join(os.homedir(), '.config', 'agent-frontdesk', 'weixin', key, 'state.json');
}

function put(job: Job, key: string, message: string) {
  if (job.outbox.some(item => item.key === key)) return;
  const units = Array.from(message);
  for (let start = 0; start < units.length; start += 1500) {
    job.outbox.push({ key, id: randomUUID(), text: units.slice(start, start + 1500).join(''), state: 'ready' });
  }
}

function waitText(approval: Pick<Approval, 'kind'> | undefined, name: string): string {
  const reason = approval?.kind === 'plan' ? '等待确认计划' :
    approval?.kind === 'input' ? '等待你的回答' : '等待你的操作';
  return `${name} · ${reason}。请在 Frontdesk 或桌面端处理。`;
}

/** One private WeChat channel, attached to one explicitly chosen native coordinator chat. */
export class Weixin {
  private lease?: DatabaseSync;
  private connection?: Connection;
  private pairing?: Pairing;
  private note?: string;
  private watches = new Map<string, () => void>();
  private working = false;
  private disconnecting = false;
  private closed = false;
  private timer: ReturnType<typeof setInterval>;

  constructor(private host: PluginHost, private coordinator: Coordinator, private runs: RunService,
    private file: string, private api = new WeixinApi(), interval = 3000) {
    if (fs.existsSync(file)) {
      try {
        this.claim();
        const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Saved;
        if (!data.account?.token || !data.account.userId || !data.engine || !data.sessionId || !Array.isArray(data.jobs)) throw new Error('Invalid binding');
        weixinBase(data.account.base);
        this.connect(data);
      } catch { this.note = '微信连接无法恢复，请在本机检查绑定'; }
    }
    this.timer = setInterval(() => void this.tick(), interval);
    this.timer.unref();
  }

  groupReport(engine: string, sessionId: string, origin: string, delivery: string, report: string): void {
    const connection = this.connection;
    if (!connection || connection.abort.signal.aborted || connection.data.engine !== engine || connection.data.sessionId !== sessionId) return;
    if (!connection.data.jobs.some(job => job.id === origin)) return;
    this.edit(connection, data => {
      const job = data.jobs.find(item => item.id === origin);
      if (job) put(job, 'group/' + delivery, report);
    });
  }

  private claim() {
    if (this.lease) return;
    const folder = path.dirname(this.file);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const lease = new DatabaseSync(path.join(folder, 'owner.sqlite'), { timeout: 0 });
    try { lease.exec('BEGIN IMMEDIATE'); }
    catch { lease.close(); throw issue('另一个 Frontdesk 实例正在管理微信连接', 423); }
    this.lease = lease;
  }

  private write(data: Saved) {
    const draft = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(draft, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
      fs.renameSync(draft, this.file);
    } finally { fs.rmSync(draft, { force: true }); }
  }

  private edit(connection: Connection, change: (data: Saved) => void) {
    if (this.connection !== connection || this.closed) return;
    const next = structuredClone(connection.data);
    change(next);
    this.write(next);
    connection.data = next;
  }

  view(): WeixinView {
    const pairing = this.pairing, connection = this.connection;
    if (pairing) return { state: pairing.state, engine: pairing.engine, sessionId: pairing.sessionId, qr: pairing.qr, note: this.note };
    if (!connection) return { state: this.note ? 'unavailable' : 'disconnected', note: this.note };
    const { engine, sessionId, jobs } = connection.data;
    return { state: connection.state, engine, sessionId, note: connection.note,
      deliveryUncertain: jobs.some(job => job.outbox.some(item => item.state === 'uncertain')) };
  }

  startPairing(target: Target): WeixinView {
    if (this.disconnecting) throw issue('微信正在断开，请稍后重试');
    if (this.connection) throw issue('请先断开当前微信连接');
    if (this.pairing) {
      if (target.engine === this.pairing.engine && target.sessionId === this.pairing.sessionId) return this.view();
      throw issue('请先取消当前微信扫码');
    }
    this.claim();
    const pairing: Pairing = { ...target, abort: new AbortController(), after: Date.now(), state: 'pairing' };
    this.note = undefined;
    this.pairing = pairing;
    void this.pair(pairing);
    return this.view();
  }

  verify(pin: string) {
    if (!this.pairing || this.pairing.state !== 'verify') throw issue('当前没有待验证的微信扫码');
    if (!/^\d{4,8}$/.test(pin)) throw issue('请输入微信显示的数字验证码', 400);
    this.pairing.pin = pin;
    this.pairing.state = 'scanned';
    return this.view();
  }

  private async pair(pair: Pairing) {
    const signal = AbortSignal.any([pair.abort.signal, AbortSignal.timeout(8 * 60 * 1000)]);
    try {
      await this.coordinator.channelSession(pair.engine, pair.sessionId);
      signal.throwIfAborted();
      const { code, content } = await this.api.qr(signal);
      pair.qr = await QRCode.toDataURL(content, { width: 256, margin: 3 });
      let base = weixinBase();
      while (!signal.aborted) {
        if (pair.state === 'verify') { await delay(250, undefined, { signal, ref: false }); continue; }
        const pin = pair.pin;
        const result = await this.api.check(code, base, pin, signal).catch(error => {
          if (error instanceof WeixinError || signal.aborted) throw error;
          return { status: 'wait' } as Awaited<ReturnType<WeixinApi['check']>>;
        });
        signal.throwIfAborted();
        if (result.account) {
          await this.coordinator.channelSession(pair.engine, pair.sessionId);
          signal.throwIfAborted();
          const data: Saved = { engine: pair.engine, sessionId: pair.sessionId, account: result.account, after: pair.after, cursor: '', jobs: [] };
          this.write(data);
          this.pairing = undefined;
          this.connect(data);
          return;
        }
        if (result.status === 'binded_redirect') throw issue('微信已绑定过此机器人，请在微信中解绑后重试');
        if (['expired', 'verify_code_blocked'].includes(result.status)) throw issue('微信二维码已失效，请重新扫码');
        if (result.status.includes('need_verifycode')) {
          pair.pin = undefined;
          pair.state = 'verify';
        } else if (result.status === 'scaned' || result.base) {
          pair.pin = undefined;
          pair.state = 'scanned';
          if (result.base) base = result.base;
        }
        await delay(700, undefined, { signal, ref: false });
      }
    } catch (error) {
      if (this.pairing !== pair || this.closed) return;
      this.pairing = undefined;
      this.note = signal.aborted ? '微信二维码已失效，请重新扫码' :
        error instanceof WeixinError || (error instanceof Error && 'status' in error) ? error.message : '无法连接微信，请重试';
      this.lease?.close();
      this.lease = undefined;
    }
  }

  private connect(data: Saved) {
    const connection: Connection = { data, abort: new AbortController(), state: 'connecting' };
    this.connection = connection;
    this.note = undefined;
    if (data.jobs.some(job => job.outbox.some(item => item.state === 'sending'))) this.edit(connection, next => {
      for (const job of next.jobs) for (const item of job.outbox) if (item.state === 'sending') item.state = 'uncertain';
    });
    void this.listen(connection);
  }

  private async listen(connection: Connection) {
    const signal = connection.abort.signal;
    await this.api.presence(connection.data.account, 'start', signal).catch(() => {});
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        const result = await this.api.poll(connection.data.account, connection.data.cursor, signal);
        if (signal.aborted) return;
        if (result.messages.length || result.cursor !== connection.data.cursor) this.edit(connection, data => {
          data.cursor = result.cursor;
          for (const message of result.messages) this.accept(data, message);
        });
        connection.state = 'connected';
        if (connection.note === retry) connection.note = undefined;
        backoff = 1000;
        if (result.messages.length) void this.tick();
        else await delay(300, undefined, { signal, ref: false });
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof WeixinError && error.expired) {
          connection.state = 'expired';
          connection.note = '微信连接已失效，请断开后重新扫码';
          connection.abort.abort();
          this.releaseWatches();
          return;
        }
        connection.state = 'reconnecting';
        connection.note = retry;
        await delay(backoff, undefined, { signal, ref: false }).catch(() => {});
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  }

  private accept(data: Saved, message: WeixinMessage) {
    if ((message.at !== undefined && message.at < data.after) || data.jobs.some(job => job.key === message.key)) return;
    const job: Job = { id: `weixin/${randomUUID()}`, key: message.key, context: message.context, outbox: [] };
    data.jobs.push(job);
    if (message.text && message.text.length <= 12000) job.prompt = message.text;
    else {
      job.resolved = true;
      put(job, 'invalid', message.text ? '这条消息太长，请分成几条发送。' : '微信入口目前接收文本消息。');
    }
  }

  private follow(engineId: string, sessionId: string, wanted: Set<string>) {
    const key = JSON.stringify([engineId, sessionId]);
    wanted.add(key);
    if (this.watches.has(key)) return;
    const release = this.host.engines.get(engineId)?.watchSession?.(sessionId, () => void this.tick());
    if (release) this.watches.set(key, release);
  }

  private releaseWatches(keep = new Set<string>()) {
    for (const [key, release] of this.watches) if (!keep.has(key)) { release(); this.watches.delete(key); }
  }

  private async collect(connection: Connection) {
    const { engine, sessionId } = connection.data;
    const bound = await this.coordinator.channelSession(engine, sessionId);
    if (this.connection !== connection || connection.abort.signal.aborted || connection.state === 'expired') return;
    if (connection.note === paused) connection.note = undefined;
    const active = this.runs.get(engine, sessionId);
    const before = connection.data;
    const next = structuredClone(before);
    const jobs = new Map(next.jobs.map(job => [job.id, job]));
    const turns = new Map<string, UnifiedTurn>();
    for (const turn of bound.history.turns) {
      const ref = turn.userPrompt.match(turnRef)?.[1];
      if (ref && !turns.has(ref)) turns.set(ref, turn);
    }
    const wanted = new Set<string>();
    this.follow(engine, sessionId, wanted);
    for (const task of bound.tasks) {
      const job = jobs.get(task.origin || '');
      if (!job) continue;
      if (task.phase === 'sent' || task.phase === 'waiting-user') this.follow(task.engine, task.target, wanted);
      const name = task.title || this.host.engines.get(task.engine)?.label || task.engine;
      const attention = task.attention;
      if (attention || task.phase === 'waiting-user') put(job, `task/${task.id}/wait/${attention?.id || ''}`, waitText(attention, name));
      const followup = turns.get(`${task.id}/reply`);
      if (followup) this.result(job, followup, `task/${task.id}`, bound.engine.label);
    }
    this.releaseWatches(wanted);
    for (const job of next.jobs) {
      const turn = turns.get(job.id);
      if (turn) {
        delete job.prompt;
        this.result(job, turn, 'direct', bound.engine.label);
      } else if (job.submittedAt && !job.resolved && active?.origin !== job.id && Date.now() - job.submittedAt > 90000) {
        put(job, 'unconfirmed', '桌面端尚未确认收到这条任务。可以在 Frontdesk 的总控会话里查看。');
      }
      if (active?.origin === job.id && active.run.approvals.length) {
        for (const approval of active.run.approvals) put(job, `wait/${approval.id}`, waitText(approval, bound.engine.label));
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(before)) { this.write(next); connection.data = next; }

    const job = next.jobs.find(job => job.prompt && !job.submittedAt && !job.resolved);
    if (!job?.prompt) return;
    if (active || sessionBusy(bound.history) || this.runs.queued(engine, sessionId).length) {
      if (!job.outbox.some(item => item.key === 'queued')) this.edit(connection, data => {
        put(data.jobs.find(item => item.id === job.id)!, 'queued', '已收到。总控正在处理上一轮，这条消息会排队。');
      });
      return;
    }
    const blocked = bound.history.session?.sendBlocked || bound.engine.capabilities.send === false || await bound.engine.blocked?.(sessionId);
    if (this.connection !== connection || connection.abort.signal.aborted) return;
    if (blocked) {
      this.edit(connection, data => put(data.jobs.find(item => item.id === job.id)!, 'blocked', '桌面暂时无法接收消息，任务已保留。'));
      return;
    }
    if (this.runs.get(engine, sessionId) || this.runs.queued(engine, sessionId).length || !this.coordinator.isSession(engine, sessionId)) return;
    // Journal before the call. A restart between the call and its receipt must not send it twice.
    this.edit(connection, data => { data.jobs.find(item => item.id === job.id)!.submittedAt = Date.now(); });
    this.runs.start(engine, sessionId, { prompt: `${coordinatorMarker(job.id)}\n${job.prompt}`, model: bound.model, attachments: [] }, { origin: job.id });
  }

  private result(job: Job, turn: UnifiedTurn, key: string, name: string) {
    for (const approval of turn.approvals || []) put(job, `wait/${approval.id}`, waitText(approval, name));
    if (!finished(turn)) return;
    if (key === 'direct') job.resolved = true;
    const reply = turn.assistantReply.trim() || turn.messages.filter(item => ['final_answer', 'final', 'plan'].includes(item.phase || '')).map(item => item.text).join('\n');
    const fallback = turn.status === 'interrupted' ? '桌面记录显示这一轮已停止。' :
      turn.status === 'failed' ? '桌面记录显示这一轮执行失败，请打开总控会话查看。' : '这一轮已结束。可以打开总控会话查看。';
    put(job, `${key}/result`, reply || fallback);
  }

  private async flush(connection: Connection) {
    for (const job of connection.data.jobs) {
      for (const item of job.outbox) {
        if (connection.abort.signal.aborted || connection.state !== 'connected') return;
        if (item.state !== 'ready' || !item.text) continue;
        const update = (state: Outgoing['state']) => this.edit(connection, data => {
          const outgoing = data.jobs.find(entry => entry.id === job.id)?.outbox.find(entry => entry.id === item.id);
          if (outgoing) { outgoing.state = state; if (state === 'sent') delete outgoing.text; }
        });
        update('sending');
        try { await this.api.reply(connection.data.account, job.context, item.id, item.text, connection.abort.signal); update('sent'); }
        catch (error) {
          update('uncertain');
          if (error instanceof WeixinError && error.expired) {
            connection.state = 'expired';
            connection.note = '微信连接已失效，请断开后重新扫码';
            connection.abort.abort();
            this.releaseWatches();
          }
          return;
        }
      }
    }
  }

  private async tick() {
    const connection = this.connection;
    if (!connection || !connection.data.jobs.length || this.closed || this.working || connection.state === 'expired') return;
    this.working = true;
    try {
      if (connection.data.jobs.some(job => job.submittedAt || job.prompt)) {
        try { await this.collect(connection); }
        catch {
          if (this.connection === connection && connection.state === 'connected') {
            connection.note = paused;
            if (connection.data.jobs.some(job => job.prompt && !job.submittedAt && !job.outbox.some(item => item.key === 'blocked'))) {
              this.edit(connection, data => {
                for (const job of data.jobs) if (job.prompt && !job.submittedAt) {
                  put(job, 'blocked', '总控会话暂不可用，消息已保留。请检查 Mac 上的总控会话。');
                }
              });
            }
          }
        }
      }
      if (this.connection === connection) await this.flush(connection);
    } catch { if (this.connection === connection) connection.note = '微信消息状态暂时无法保存'; }
    finally { this.working = false; }
  }

  async disconnect() {
    if (this.disconnecting) return this.view();
    this.claim();
    fs.rmSync(this.file, { force: true });
    this.pairing?.abort.abort();
    this.pairing = undefined;
    const connection = this.connection;
    connection?.abort.abort();
    this.connection = undefined;
    this.note = undefined;
    this.releaseWatches();
    this.disconnecting = true;
    try { if (connection) await this.stopPresence(connection); }
    finally {
      this.disconnecting = false;
      this.lease?.close();
      this.lease = undefined;
    }
    return this.view();
  }

  private async stopPresence(connection: Connection) {
    if (connection.state !== 'expired') await this.api.presence(connection.data.account, 'stop', AbortSignal.timeout(2500)).catch(() => {});
  }

  async dispose() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.pairing?.abort.abort();
    this.connection?.abort.abort();
    this.releaseWatches();
    if (this.connection) await this.stopPresence(this.connection);
    this.lease?.close();
    this.lease = undefined;
  }
}
