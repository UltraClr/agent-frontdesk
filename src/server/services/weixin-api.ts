import { randomBytes } from 'node:crypto';
import { get, list, str } from '../../shared/guards.js';

// Tencent's iLink bot protocol, as described in Tencent/openclaw-weixin/docs/protocol_zh_CN.md.
const BASE = 'https://ilinkai.weixin.qq.com';
const BASE_INFO = { channel_version: '3.0.0/agent-frontdesk', bot_agent: 'AgentFrontdesk' };
const APP_HEADERS = { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(3 << 16) };

export interface WeixinAccount { token: string; botId: string; userId: string; base: string }
export interface WeixinMessage { key: string; context: string; text: string; at?: number }

export class WeixinError extends Error {
  constructor(message: string, readonly expired = false) { super(message); }
}

export function weixinBase(value = BASE): string {
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' ||
      url.search || url.hash || !/(^|\.)(weixin\.qq\.com|wechat\.com)$/.test(url.hostname)) {
    throw new WeixinError('微信返回了未知的服务地址');
  }
  return url.origin;
}

export function ownerMessage(raw: unknown, account: WeixinAccount): WeixinMessage | null {
  if (get(raw, 'message_type') !== 1 || get(raw, 'group_id') || get(raw, 'delete_time_ms') ||
      get(raw, 'from_user_id') !== account.userId) return null;
  const id = get(raw, 'message_id'), seq = get(raw, 'seq'), client = str(get(raw, 'client_id'));
  const key = typeof id === 'number' && id > 0 ? `message:${id}` : client ? `client:${client}` :
    typeof seq === 'number' && seq > 0 ? `seq:${seq}` : '';
  const context = str(get(raw, 'context_token'));
  if (!context || !key) return null;
  const text = list(get(raw, 'item_list')).filter(item => get(item, 'type') === 1)
    .map(item => str(get(item, 'text_item', 'text')) || '').join('\n').trim();
  const at = get(raw, 'create_time_ms');
  return { key, context, text, ...(typeof at === 'number' && at > 0 ? { at } : {}) };
}

export class WeixinApi {
  constructor(private fetcher: typeof fetch = fetch) {}

  private async request(endpoint: string, { base = BASE, token, body, timeout = 15000, signal }: {
    base?: string; token?: string; body?: object; timeout?: number; signal: AbortSignal;
  }): Promise<unknown> {
    const headers: Record<string, string> = { ...APP_HEADERS };
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers['AuthorizationType'] = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
    }
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const response = await this.fetcher(new URL(endpoint, weixinBase(base)), { method: body ? 'POST' : 'GET', headers,
      body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
    if (!response.ok) throw new WeixinError('微信服务暂时无法连接', response.status === 401);
    const data: unknown = await response.json();
    const codes = [get(data, 'ret'), get(data, 'errcode')].map(value => Number(value || 0));
    if (codes.some(Boolean)) throw new WeixinError('微信服务暂时无法连接', codes.includes(-14));
    return data;
  }

  async qr(signal: AbortSignal) {
    const result = await this.request('/ilink/bot/get_bot_qrcode?bot_type=3', { body: { local_token_list: [] }, signal });
    const code = str(get(result, 'qrcode')), content = str(get(result, 'qrcode_img_content'));
    if (!code || !content) throw new WeixinError('微信没有返回扫码凭证');
    return { code, content };
  }

  async check(code: string, base: string, pin: string | undefined, signal: AbortSignal) {
    const query = new URLSearchParams({ qrcode: code });
    if (pin) query.set('verify_code', pin);
    const result = await this.request(`/ilink/bot/get_qrcode_status?${query}`, { base, timeout: 40000, signal });
    const status = str(get(result, 'status')) || 'wait';
    if (status === 'scaned_but_redirect') {
      const host = str(get(result, 'redirect_host'));
      if (!host) throw new WeixinError('微信返回了未知的服务地址');
      return { status, base: weixinBase(host) };
    }
    if (status !== 'confirmed') return { status };
    const token = str(get(result, 'bot_token')), botId = str(get(result, 'ilink_bot_id')), userId = str(get(result, 'ilink_user_id'));
    if (!token || !botId || !userId) throw new WeixinError('微信没有返回完整的绑定信息');
    return { status, account: { token, botId, userId, base: weixinBase(str(get(result, 'baseurl')) || base) } };
  }

  async poll(account: WeixinAccount, cursor: string, signal: AbortSignal) {
    const result = await this.request('/ilink/bot/getupdates', { ...account, timeout: 45000, signal,
      body: { get_updates_buf: cursor, base_info: BASE_INFO } });
    return { cursor: str(get(result, 'get_updates_buf')) || cursor,
      messages: list(get(result, 'msgs')).map(item => ownerMessage(item, account)).filter(item => item !== null) };
  }

  async presence(account: WeixinAccount, state: 'start' | 'stop', signal: AbortSignal) {
    await this.request(`/ilink/bot/msg/notify${state}`, { ...account, signal, timeout: 2500, body: { base_info: BASE_INFO } });
  }

  async reply(account: WeixinAccount, context: string, id: string, text: string, signal: AbortSignal): Promise<void> {
    await this.request('/ilink/bot/sendmessage', { ...account, signal, body: { base_info: BASE_INFO, msg: {
      from_user_id: '', to_user_id: account.userId, client_id: id, message_type: 2, message_state: 2,
      context_token: context, item_list: [{ type: 1, text_item: { text } }],
    } } });
  }
}
