import type { WeixinView } from '../../shared/contract.js';
import { messageOf } from '../../shared/guards.js';
import { request } from './api.js';
import { closest } from './dom.js';
import { t } from './i18n.js';
import { escape } from './renderers.js';

const url = '/api/coordinator/channels/weixin';
const states: Record<WeixinView['state'], string> = {
  disconnected: '未连接', pairing: '等待微信扫码', scanned: '已扫码，请在微信确认',
  verify: '等待微信验证码', connecting: '正在连接微信', connected: '微信已连接',
  reconnecting: '正在重连微信', expired: '微信连接已失效', unavailable: '微信连接不可用',
};

export function weixinDialog(dialog: HTMLDialogElement, labelOf: (id: string) => string) {
  const content = dialog.querySelector<HTMLElement>('.weixin-content')!;
  const status = dialog.querySelector<HTMLElement>('.weixin-status')!;
  let target = { engine: '', sessionId: '' };
  let view: WeixinView = { state: 'disconnected' }, pending = false, refreshing = false, confirmDisconnect = false;
  let generation = 0, timer: ReturnType<typeof setInterval> | undefined;

  function draw() {
    const { state, engine, qr, note } = view;
    const pairing = ['pairing', 'scanned', 'verify'].includes(state);
    const bound = !pairing && !!view.sessionId;
    const label = labelOf(engine || target.engine);
    const enabled = pending ? ' disabled' : '';
    const safeQr = qr && /^data:image\/png;base64,[a-zA-Z0-9+\/=]+$/.test(qr) ? qr : '';
    const intro = bound ? t('微信消息会发到 {name} 总控。', { name: label }) :
      target.sessionId ? t('用微信扫一扫，将私聊绑定到 {name} 总控。', { name: label }) : t('请先打开或恢复已有的总控会话');
    const display = `<div class="weixin-state" data-state="${state}"><span></span>${escape(t(states[state]))}</div>
      <p>${escape(intro)}</p>
      ${note ? `<p class="weixin-note">${escape(t(note))}</p>` : ''}
      ${view.deliveryUncertain ? `<p class="weixin-note">${escape(t('有微信回复尚未确认送达，可在总控会话里查看。'))}</p>` : ''}
      ${pairing && safeQr && state !== 'verify' ? `<img class="weixin-qr" src="${safeQr}" alt="${escape(t('微信绑定二维码'))}" width="220" height="220">` : ''}
      ${state === 'verify' ? `<form class="weixin-pin">
        <label>${escape(t('微信显示的数字验证码'))}<input name="pin" type="text" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4,8}" maxlength="8"></label>
        <button type="submit" class="primary-button"${enabled}>${escape(t('提交验证码'))}</button>
      </form>` : ''}
      ${confirmDisconnect ? `<p class="weixin-note">${escape(t('断开后，这个微信私聊将停止接收和转发总控消息。'))}</p>` : ''}
      <div class="dialog-actions">
        ${pairing ? `<button type="button" class="secondary-button" data-weixin="cancel"${enabled}>${escape(t('取消扫码'))}</button>` : ''}
        ${bound ? `<button type="button" class="secondary-button" data-weixin="disconnect"${enabled}>${escape(t(confirmDisconnect ? '确认断开' : '断开微信'))}</button>` : ''}
        ${!bound && !pairing && target.sessionId ? `<button type="button" class="primary-button" data-weixin="pair"${enabled}>${escape(t('生成绑定二维码'))}</button>` : ''}
      </div>`;
    if (content.dataset.html !== display) {
      // Keep a partially typed PIN when a status poll changes another part of the dialog.
      const pin = content.querySelector<HTMLInputElement>('input[name="pin"]');
      const value = pin?.value || '', focused = document.activeElement === pin;
      content.dataset.html = display;
      content.innerHTML = display;
      const input = content.querySelector<HTMLInputElement>('input[name="pin"]');
      if (input) { input.value = value; if (focused) input.focus(); }
    }
  }

  async function refresh() {
    if (!dialog.open || pending || refreshing) return;
    const current = generation;
    refreshing = true;
    try {
      const data = await request<WeixinView>(url);
      if (current === generation && !pending) { view = data; draw(); }
    } catch (error) {
      if (current === generation) status.textContent = messageOf(error);
    } finally { refreshing = false; }
  }

  async function change(method: 'POST' | 'DELETE', suffix = '', body?: object) {
    if (pending) return;
    const current = ++generation;
    pending = true; status.textContent = ''; draw();
    try {
      const data = await request<WeixinView>(url + suffix, { method, body: body && JSON.stringify(body) });
      if (current === generation) { view = data; confirmDisconnect = false; }
    } catch (error) {
      if (current === generation) status.textContent = messageOf(error);
    } finally { pending = false; if (dialog.open) draw(); }
  }

  dialog.querySelector('button[data-close]')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { ++generation; clearInterval(timer); });
  content.addEventListener('click', event => {
    const action = closest(event.target, 'button[data-weixin]', HTMLButtonElement)?.dataset.weixin;
    if (action === 'pair') void change('POST', '', target);
    if (action === 'cancel') void change('DELETE');
    if (action === 'disconnect') {
      if (confirmDisconnect) void change('DELETE');
      else { confirmDisconnect = true; draw(); }
    }
  });
  content.addEventListener('submit', event => {
    const form = closest(event.target, 'form.weixin-pin', HTMLFormElement);
    if (!form) return;
    event.preventDefault();
    void change('POST', '/verify', { pin: new FormData(form).get('pin') });
  });

  return (engine: string, sessionId: string) => {
    target = { engine, sessionId };
    confirmDisconnect = false; status.textContent = '';
    if (!dialog.open) dialog.showModal();
    draw();
    void refresh();
    clearInterval(timer);
    timer = setInterval(refresh, 1200);
  };
}
