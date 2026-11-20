import type { InboxItem, InboxView } from '../../shared/inbox.js';
import { messageOf } from '../../shared/guards.js';
import { request, sessionUrl } from './api.js';
import { say, t, locale } from './i18n.js';
import { escape, hydrateIcons, icon } from './renderers.js';

const labels = { approval: '需要审批', input: '等待你的输入', plan: '等待计划确认', delivery: '投递待核实' } as const;
const nativeHref = (item: InboxItem) => '#' + [item.engine, item.sessionId || '', item.turnId || '', item.requestId || ''].map(encodeURIComponent).join('/');

export class InboxDialog {
  private readonly dialog = document.createElement('dialog');
  private timer?: ReturnType<typeof setInterval>;
  private loading = false;
  private view?: InboxView;

  constructor(private readonly agent: (id: string) => { label?: string; capabilities?: { showInDesktop?: boolean } } | undefined,
    private readonly navigate: (hash: string) => void) {
    this.dialog.className = 'inbox-dialog';
    this.dialog.addEventListener('close', () => { clearInterval(this.timer); this.timer = undefined; });
    this.dialog.addEventListener('click', event => {
      const target = event.target as Element;
      if (target.closest('[data-inbox-close]')) this.dialog.close();
      if (target.closest('[data-inbox-refresh]')) void this.refresh();
      const link = target.closest<HTMLAnchorElement>('a[href^="#"]');
      if (link && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        this.dialog.close();
        this.navigate(link.hash);
      }
      const desktop = target.closest<HTMLButtonElement>('[data-inbox-desktop]');
      if (desktop) void this.showDesktop(desktop);
    });
    document.body.append(this.dialog);
  }

  open() {
    if (this.dialog.open) return;
    this.dialog.innerHTML = `<header class="dialog-heading"><h2 id="inbox-title">${t('待你处理')}</h2>
      <div class="inbox-controls"><button type="button" class="icon-button" data-inbox-refresh aria-label="${t('刷新待办')}">${icon('refresh-cw')}</button>
      <button type="button" class="icon-button" data-inbox-close aria-label="${t('关闭')}">${icon('x')}</button></div></header>
      <p class="inbox-status" role="status"></p><div class="inbox-content"></div>`;
    this.dialog.setAttribute('aria-labelledby', 'inbox-title');
    hydrateIcons(this.dialog);
    this.dialog.showModal();
    this.render();
    void this.refresh();
    this.timer = setInterval(() => { if (!document.hidden) void this.refresh(); }, 5000);
  }

  private row(item: InboxItem) {
    const provider = this.agent(item.engine);
    const title = item.sessionTitle || item.sources[0]?.title || item.sessionId || provider?.label || item.engine;
    const minutes = Math.max(0, Math.floor((Date.now() - item.since) / 60000));
    const age = minutes < 1 ? t('刚刚') : t('已等待 {n} 分钟', { n: minutes });
    const desktop = item.sessionId && item.desktopOnly && provider?.capabilities?.showInDesktop;
    const action = (item.kind === 'delivery' && item.sources[0]?.href) || (item.sessionId ? nativeHref(item) : item.sources[0]?.href);
    const project = item.project?.split(/[\\/]/).filter(Boolean).at(-1);
    return `<li class="inbox-item"><div class="inbox-item-heading"><strong>${escape(title)}</strong>
      <span class="group-state-pill" data-tone="warning">${t(labels[item.kind])}</span></div>
      <small>${escape([provider?.label || item.engine, project, age].filter(Boolean).join(' · '))}</small>
      ${item.title ? `<p>${escape(say(item.title))}</p>` : ''}
      <div class="inbox-links">${desktop ? `<button type="button" class="secondary-button" data-inbox-desktop data-engine="${escape(item.engine)}" data-session="${escape(item.sessionId)}">${t('在桌面处理')}</button>` : ''}
      ${item.desktopOnly && !desktop ? `<span>${t('请在桌面处理')}</span>` : ''}
      ${action ? `<a href="${escape(action)}">${t(item.kind === 'delivery' ? '查看投递进度' : '打开原会话处理')}${icon('arrow-up-right')}</a>` : ''}
      ${item.sources.filter(source => source.href !== action).map(source => `<a href="${escape(source.href)}">${escape(source.title)}${icon('arrow-up-right')}</a>`).join('')}</div></li>`;
  }

  private render() {
    const content = this.dialog.querySelector<HTMLElement>('.inbox-content')!;
    const view = this.view;
    const section = (title: string, items: InboxItem[]) => `<section><h3>${t(title)}</h3>${items.length
      ? `<ul>${items.map(item => this.row(item)).join('')}</ul>` : `<p class="inbox-empty">${t('暂无事项')}</p>`}</section>`;
    const markup = view ? section('需要你处理', view.items.filter(item => item.kind !== 'delivery')) +
      section('投递待核实', view.items.filter(item => item.kind === 'delivery')) +
      `<details class="inbox-coverage"><summary>${t('核对范围')}</summary><ul>${view.coverage.map(item => {
        const time = item.checkedAt && new Date(item.checkedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
        const state = item.offline ? '连接暂时中断' : item.mode === 'tracked' ? '仅已跟踪会话' : '原生请求与已跟踪会话';
        return `<li><strong>${escape(this.agent(item.engine)?.label || item.engine)}</strong><span>${t(state)}${time ? ' · ' + escape(time) : ''}</span></li>`;
      }).join('')}</ul></details>` : '';
    if (content.dataset.markup === markup) return;
    const focusedHref = document.activeElement instanceof HTMLAnchorElement && content.contains(document.activeElement) ? document.activeElement.hash : '';
    const expanded = content.querySelector('details')?.open;
    content.dataset.markup = markup;
    content.innerHTML = markup;
    if (expanded) content.querySelector('details')?.setAttribute('open', '');
    hydrateIcons(content);
    if (focusedHref) [...content.querySelectorAll('a')].find(link => link.hash === focusedHref)?.focus({ preventScroll: true });
  }

  private async refresh() {
    if (this.loading) return;
    this.loading = true;
    const status = this.dialog.querySelector<HTMLElement>('.inbox-status')!;
    if (!this.view) status.textContent = t('正在核对待办…');
    try {
      this.view = await request<InboxView>('/api/inbox');
      if (this.dialog.open) this.render();
      status.textContent = '';
    } catch (error) { status.textContent = t('待办刷新失败') + ' · ' + messageOf(error); }
    finally { this.loading = false; }
  }

  private async showDesktop(button: HTMLButtonElement) {
    button.disabled = true;
    try { await request(sessionUrl(button.dataset.engine!, button.dataset.session!) + '/show', { method: 'POST' }); }
    catch (error) { this.dialog.querySelector<HTMLElement>('.inbox-status')!.textContent = messageOf(error); }
    finally { button.disabled = false; }
  }
}
