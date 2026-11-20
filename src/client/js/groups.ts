import type { GroupDelivery, GroupEngine, GroupMember, GroupMemberOptions, GroupMemberSetup, GroupMessage, GroupSummary, GroupView } from '../../shared/groups.js';
import { messageOf } from '../../shared/guards.js';
import { request } from './api.js';
import { say, t } from './i18n.js';
import { character, escape, hydrateIcons, icon, markdown } from './renderers.js';

type Page = { items: GroupSummary[]; nextOffset: number | null };
type Agent = { id: string; label: string };
type TaskAction = 'start' | 'supplement' | 'replace';
type Draft = { text: string; member: string; replyTo: string; key?: string; taskAction?: TaskAction; taskId?: string; taskRevision?: number };
const activeTaskStates = new Set(['queued', 'confirming', 'running', 'waiting', 'blocked', 'paused']);
const taskLabels = {
  queued: '等待投递', confirming: '正在确认桌面记录', running: '正在推进', waiting: '等待用户操作', blocked: '群任务受阻',
  paused: '群任务已暂停', completed: '群任务已完成', cancelled: '已停止后续派发', failed: '群任务未完成',
} as const;
const receiptOutcomes = { completed: '原生轮次已结束', failed: '原会话任务失败', interrupted: '原会话任务已停止', cancelled: '已撤销待投递消息' } as const;
const taskTone = (state: string) => state === 'completed' ? 'positive'
  : ['waiting', 'confirming', 'paused'].includes(state) ? 'warning'
    : ['failed', 'blocked', 'interrupted'].includes(state) ? 'negative'
      : ['running', 'sent'].includes(state) ? 'active' : 'neutral';
type HostChoice = { engine: string; hostSession?: string };
const enc = encodeURIComponent;
const api = '/api/groups';
const url = (id: string) => api + '/' + enc(id);
const memberKey = (member: GroupMember) => JSON.stringify([member.engine, member.id]);
const nativeId = (member: GroupMember) => member.dedicated ? member.sessionId : member.id;
const nativeLink = (engine: string, id: string, turn?: string) => '#' + [engine, id, ...(turn ? [turn] : [])].map(enc).join('/');
const post = (body: unknown, method = 'POST') => ({ method, body: JSON.stringify(body) });
const getLocal = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const setLocal = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* A private browser can refuse storage. */ } };
const memberOptions = (engine: string) => request<GroupMemberOptions>('/api/group-member-options/' + enc(engine));
const projectSuggestions = (projects: GroupMemberOptions['projects']) => projects.map(({ cwd, name }) =>
  `<option value="${escape(cwd)}">${escape(name)}</option>`).join('');

function modelChoices(models: GroupMemberOptions['models'], model?: string) {
  return `<option value="">${t('跟随桌面新会话')}</option>` +
    (model && !models.some(option => option.id === model) ? `<option value="${escape(model)}" selected>${escape(model)}</option>` : '') +
    models.map(option => `<option value="${escape(option.id)}" ${option.id === model ? 'selected' : ''}>${escape(option.name)}</option>`).join('');
}

function setupFields(member: GroupMember, options?: GroupMemberOptions) {
  const workspace = member.setup?.workspace;
  const listId = 'group-projects-' + member.id;
  return `<div class="group-member-setup" data-group-member-setup>
    <label>${t('工作目录')}
      ${member.sessionId ? `<code>${escape(member.nativeSettings?.cwd || '')}</code>` : `
      <select data-group-workspace-mode>
        <option value="inherit" ${workspace === undefined ? 'selected' : ''}>${t('继承群默认项目')}</option>
        <option value="none" ${workspace === null ? 'selected' : ''}>${t(options?.discussionFolder ? '专用讨论目录' : '不绑定项目')}</option>
        <option value="project" ${workspace ? 'selected' : ''}>${t('指定项目')}</option>
      </select>
      <input data-group-workspace list="${escape(listId)}" value="${escape(workspace || '')}" placeholder="${t('项目绝对路径')}"
        aria-label="${t('项目绝对路径')}" ${workspace ? 'required' : 'hidden disabled'}>
      <datalist id="${escape(listId)}">${projectSuggestions(options?.projects || [])}</datalist>`}
    </label>
    <label>${t('模型')}
      <select data-group-model>${modelChoices(options?.models || [], member.setup?.model)}</select>
    </label>
    ${!member.sessionId ? `<small data-group-project-hint ${options?.registeredProject ? '' : 'hidden'}>${t('指定项目需要先在桌面版登记。')}</small>` : ''}
  </div>`;
}

function showMemberOptions(fields: Element, options: GroupMemberOptions) {
  const projectList = fields.querySelector('datalist');
  if (projectList) projectList.innerHTML = projectSuggestions(options.projects);
  const hint = fields.querySelector<HTMLElement>('[data-group-project-hint]');
  if (hint) hint.hidden = !options.registeredProject;
  const noProject = fields.querySelector<HTMLOptionElement>('[data-group-workspace-mode] option[value=none]');
  if (noProject) noProject.textContent = t(options.discussionFolder ? '专用讨论目录' : '不绑定项目');
  const model = fields.querySelector<HTMLSelectElement>('[data-group-model]');
  if (model) model.innerHTML = modelChoices(options.models, model.value);
}

function readSetup(fields: HTMLElement, previous?: GroupMemberSetup): GroupMemberSetup {
  const mode = fields.querySelector<HTMLSelectElement>('[data-group-workspace-mode]');
  const input = fields.querySelector<HTMLInputElement>('[data-group-workspace]');
  if (input) {
    const custom = mode?.value === 'project';
    input.disabled = input.hidden = !custom;
    input.required = custom;
  }
  const workspace = mode ? mode.value === 'project' ? input?.value.trim() || '' : mode.value === 'none' ? null : undefined : previous?.workspace;
  return { workspace, model: fields.querySelector<HTMLSelectElement>('[data-group-model]')?.value || undefined };
}

function hostPickerFields() {
  return `<fieldset class="group-host-picker" data-host-picker>
    <legend>${t('群主')}</legend>
    <div class="group-host-fields">
      <label>${t('会话来源')}<select data-host-mode>
        <option value="new">${t('新建群主会话')}</option>
        <option value="existing">${t('选择已有会话')}</option>
      </select></label>
      <label>Agent<select data-host-engine required><option value="">${t('正在读取…')}</option></select></label>
      <div class="group-host-existing" data-host-existing hidden>
        <label>${t('搜索会话')}<input type="search" data-host-query placeholder="${t('搜索会话')}"></label>
        <label>${t('群主会话')}<select data-host-session disabled><option value="">${t('请选择会话')}</option></select></label>
      </div>
    </div>
    <p data-host-status aria-live="polite"></p>
  </fieldset>`;
}

function hostPicker(form: HTMLFormElement, defaultEngine: string, changed: () => void) {
  const mode = form.querySelector<HTMLSelectElement>('[data-host-mode]')!;
  const engine = form.querySelector<HTMLSelectElement>('[data-host-engine]')!;
  const session = form.querySelector<HTMLSelectElement>('[data-host-session]')!;
  const existing = form.querySelector<HTMLElement>('[data-host-existing]')!;
  const query = form.querySelector<HTMLInputElement>('[data-host-query]')!;
  const status = form.querySelector<HTMLElement>('[data-host-status]')!;
  let agents: GroupEngine[] = [], version = 0, timer: number | undefined;
  const value = (): HostChoice | undefined => engine.value && (mode.value === 'new' || session.value)
    ? { engine: engine.value, hostSession: mode.value === 'existing' ? session.value : undefined } : undefined;
  const loadSessions = async () => {
    if (mode.value !== 'existing' || !engine.value) return;
    const requestVersion = ++version;
    session.replaceChildren(new Option(t('正在读取…'), ''));
    status.textContent = '';
    changed();
    try {
      const params = new URLSearchParams({ engine: engine.value, q: query.value.trim() });
      const items = await request<GroupMember[]>('/api/group-members?' + params);
      if (!form.isConnected || version !== requestVersion) return;
      session.replaceChildren(new Option(t(items.length ? '请选择会话' : '没有匹配的会话'), ''),
        ...items.map(item => {
          const duplicate = items.some(other => other.id !== item.id && other.title === item.title);
          const detail = duplicate ? [item.cwd, item.id.slice(-8)].filter(Boolean).join(' · ') : '';
          return new Option(detail ? item.title + ' · ' + detail : item.title, item.id);
        }));
      status.textContent = t('选中的会话将使用原有上下文。如果它已在本群，会改任群主。');
    } catch (error) {
      if (!form.isConnected || version !== requestVersion) return;
      session.replaceChildren(new Option(t('请选择会话'), ''));
      status.textContent = messageOf(error);
    }
    changed();
  };
  const sync = () => {
    version++;
    clearTimeout(timer);
    const isExisting = mode.value === 'existing';
    existing.hidden = !isExisting;
    session.disabled = !isExisting;
    session.required = isExisting;
    session.replaceChildren(new Option(t('请选择会话'), ''));
    const choices = agents.filter(agent => isExisting || agent.canHost);
    const previous = engine.value || defaultEngine;
    engine.replaceChildren(...choices.map(agent => new Option(agent.label, agent.id)));
    if (choices.some(agent => agent.id === previous)) engine.value = previous;
    status.textContent = choices.length ? '' : t('没有可创建群主会话的 Agent');
    changed();
    if (isExisting) void loadSessions();
  };
  mode.onchange = sync;
  engine.onchange = () => { clearTimeout(timer); void loadSessions(); changed(); };
  session.onchange = changed;
  query.oninput = () => {
    clearTimeout(timer);
    version++;
    session.replaceChildren(new Option(t('正在读取…'), ''));
    changed();
    timer = window.setTimeout(() => void loadSessions(), 180);
  };
  query.onkeydown = event => {
    if (event.key === 'Enter') { event.preventDefault(); clearTimeout(timer); void loadSessions(); }
  };
  return { value, setAgents(items: GroupEngine[]) { agents = items; sync(); } };
}

export class GroupPanel {
  private id = '';
  private room?: GroupView;
  private page: Page = { items: [], nextOffset: null };
  private query = '';
  private offset = 0;
  private loaded = false;
  private loading = false;
  private loadingRoom = false;
  private sending = false;
  private roomGeneration = 0;
  private writingRoom = '';
  private target = '';
  private directoryMarkup = '';
  private older: GroupMessage[] = [];
  private before: number | null | undefined;
  private draft: Draft = { text: '', member: '', replyTo: '' };
  private readonly list: HTMLElement;
  private readonly title: HTMLElement;
  private readonly topic: HTMLElement;
  private readonly members: HTMLElement;
  private readonly status: HTMLElement;
  private readonly taskPanel: HTMLElement;
  private taskMarkup = '';
  private readonly timeline: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly input: HTMLTextAreaElement;
  private readonly receiver: HTMLSelectElement;
  private readonly taskAction: HTMLSelectElement;
  private readonly dialog: HTMLDialogElement;

  constructor(readonly panel: HTMLElement, private sidebar: HTMLElement, private currentEngine: () => string,
    private agents: () => Agent[], private show: (id: string) => void, private back: () => void, private openSidebar: () => void, private followLink: (hash: string) => void) {
    panel.innerHTML = `
      <header class="chat-header group-header">
        <button class="icon-button" data-group-sidebar aria-label="${t('切换会话列表')}">${icon('panel-left')}</button>
        <button type="button" class="group-back" data-group-back aria-label="${t('返回总控')}" title="${t('返回总控')}">${icon('arrow-left')}</button>
        <span class="group-emblem" aria-hidden="true">${icon('users-round')}</span>
        <div class="group-heading"><h1></h1><p class="group-topic"></p></div>
        <div class="group-tools">
          <button type="button" class="group-manage" data-group-manage>${icon('users-round')}<span>${t('管理成员')}</span></button>
          <details class="group-more">
            <summary aria-label="${t('更多群聊操作')}" title="${t('更多群聊操作')}">${icon('ellipsis')}</summary>
            <div class="group-more-actions">
              <button type="button" data-group-rename>${icon('pencil')}<span>${t('重命名')}</span></button>
              <button type="button" data-group-pin></button>
              <button type="button" data-group-pause></button>
            </div>
          </details>
        </div>
      </header>
      <div class="group-members"></div><div class="group-status" role="status"></div>
      <div class="group-task-panel" hidden></div>
      <section class="group-messages" aria-label="${t('群聊')}" tabindex="0"></section>
      <form class="group-composer">
        <div class="group-quote" hidden></div>
        <textarea required maxlength="12000" aria-label="${t('发送群消息')}" placeholder="${t('发送群消息')}"></textarea>
        <div class="group-composer-toolbar">
          <label><span>${t('发送给')}</span><span class="group-select">${icon('at-sign')}<select aria-label="${t('收件人')}"></select>${icon('chevron-down')}</span></label>
          <label data-group-task-action hidden><span>${t('任务操作')}</span><span class="group-select"><select aria-label="${t('任务操作')}"></select>${icon('chevron-down')}</span></label>
          <button class="primary-button group-send" type="submit">${icon('arrow-up')}<span>${t('发送')}</span></button>
        </div>
      </form>
      <dialog class="group-dialog"></dialog>`;
    this.title = panel.querySelector('h1')!;
    this.topic = panel.querySelector('.group-topic')!;
    this.members = panel.querySelector('.group-members')!;
    this.status = panel.querySelector('.group-status')!;
    this.taskPanel = panel.querySelector('.group-task-panel')!;
    this.timeline = panel.querySelector('.group-messages')!;
    this.form = panel.querySelector('form')!;
    this.input = panel.querySelector('textarea')!;
    this.receiver = panel.querySelector('select')!;
    this.taskAction = panel.querySelector('[data-group-task-action] select')!;
    this.dialog = panel.querySelector('dialog')!;
    document.body.append(this.dialog);
    this.list = document.createElement('div');
    this.list.className = 'group-list';
    this.sidebar.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLElement>('[data-room],[data-group-create],[data-group-next],[data-group-previous]');
      if (!button) return;
      if (button.hasAttribute('data-group-create')) this.createDialog();
      else if (button.dataset['room']) this.show(button.dataset['room']);
      else if (button.hasAttribute('data-group-previous')) { this.offset = Math.max(0, this.offset - 30); void this.refreshDirectory(); }
      else if (this.page.nextOffset !== null) { this.offset = this.page.nextOffset; void this.refreshDirectory(); }
    });
    this.sidebar.addEventListener('submit', event => {
      if (!(event.target instanceof HTMLFormElement) || !event.target.matches('.group-search')) return;
      event.preventDefault();
      this.query = String(new FormData(event.target).get('query') || '');
      this.offset = 0;
      void this.refreshDirectory();
    });
    panel.addEventListener('click', event => void this.action(event));
    panel.addEventListener('keydown', event => {
      const menu = (event.target as Element | null)?.closest<HTMLDetailsElement>('.group-more[open]');
      if (event.key !== 'Escape' || !menu) return;
      menu.open = false;
      menu.querySelector('summary')?.focus();
    });
    this.input.addEventListener('input', () => { this.draft.key = undefined; this.save(); });
    this.receiver.addEventListener('change', () => this.changeRecipient());
    this.taskAction.addEventListener('change', () => {
      const action = this.taskAction.value as TaskAction | '';
      const task = this.room?.task;
      this.draft.taskAction = action || undefined;
      this.draft.taskId = action && action !== 'start' ? task?.id : undefined;
      this.draft.taskRevision = action && action !== 'start' ? task?.revision : undefined;
      this.draft.key = undefined;
      this.save();
    });
    this.form.addEventListener('submit', event => { event.preventDefault(); void this.send(); });
    hydrateIcons(panel);
    setInterval(() => {
      if (document.hidden || this.sidebar.hidden) return;
      void this.refreshDirectory();
      if (this.id) void this.refresh();
    }, 3000);
  }

  mount() {
    this.sidebar.querySelector('[data-group-directory]')?.append(this.list);
    if (!this.loaded) { this.drawDirectory(); void this.refreshDirectory(); }
  }

  private async refreshDirectory() {
    if (!this.list.isConnected || this.loading) return;
    this.loading = true;
    try {
      const page = await request<Page>(api + '?' + new URLSearchParams({ query: this.query, offset: String(this.offset) }));
      this.page = page; this.loaded = true; this.drawDirectory();
    } catch (err) { if (!this.loaded) this.list.textContent = messageOf(err); }
    finally { this.loading = false; }
  }

  private drawDirectory() {
    const filter = document.createElement('form');
    filter.className = 'group-search';
    filter.innerHTML = `<input name="query" type="search" aria-label="${t('搜索群聊')}" placeholder="${t('搜索群聊')}" value="${escape(this.query)}"><button type="submit" aria-label="${t('搜索')}" title="${t('搜索')}">${icon('search')}</button>`;
    const rows = this.page.items.map(room => {
      const unread = room.latest > Number(getLocal('frontdesk:group:read:' + room.id) || 0);
      const faces = room.members.slice(0, 3).map(member => this.face(member.engine)).join('');
      return `<button class="group-row" type="button" data-room="${escape(room.id)}" aria-current="${room.id === this.id}" title="${escape(room.name)}">
        <span class="group-row-icon">${icon('messages-square')}</span>
        <span class="group-row-copy"><strong>${escape(room.name)}</strong><small>${escape(room.topic || t('{n} 位成员', { n: room.members.length }))}</small></span>
        <span class="group-row-meta">${room.pending ? `<span class="group-pending" aria-label="${t('{n} 项进行中', { n: room.pending })}">${room.pending}</span>`
          : faces ? `<span class="group-face-stack" aria-hidden="true">${faces}</span>` : ''}
          ${unread ? `<span class="group-unread" title="${t('未读')}"></span>` : ''}</span></button>`;
    }).join('');
    const block = document.createElement('div');
    block.innerHTML = (rows || (this.loaded ? `<p class="group-directory-empty">${t(this.query ? '没有匹配的群聊' : '还没有群聊')}</p>` : '')) + (this.page.nextOffset !== null ? `<button type="button" data-group-next>${t('更多群聊')}</button>` : '');
    if (!this.list.querySelector('form')) this.list.append(filter);
    if (this.offset) block.insertAdjacentHTML('afterbegin', `<button type="button" data-group-previous>${t('上一页')}</button>`);
    if (block.innerHTML !== this.directoryMarkup || !this.list.querySelector('div')) {
      const focused = this.list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset['room'] : undefined;
      this.list.querySelector('div')?.remove();
      this.list.append(block);
      this.directoryMarkup = block.innerHTML;
      if (focused) block.querySelector<HTMLButtonElement>(`[data-room="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    }
    hydrateIcons(this.list);
  }

  get active() { return !!this.id; }

  close() {
    if (!this.active) return;
    this.save();
    if (this.room) {
      const edge = this.timeline.getBoundingClientRect().top;
      const visible = Array.from(this.timeline.querySelectorAll<HTMLElement>('[data-message-id]')).find(message => message.getBoundingClientRect().bottom > edge);
      setLocal('frontdesk:group:anchor:' + this.id, visible?.dataset['messageId'] || '');
    }
    this.id = '';
    this.panel.querySelector('.group-more')?.removeAttribute('open');
    this.roomGeneration++;
    this.room = undefined;
    this.panel.hidden = true;
    this.panel.parentElement?.removeAttribute('data-group');
    this.drawDirectory();
  }

  async open(id: string, message = '') {
    if (this.id !== id) {
      this.close();
      this.id = id;
      this.room = undefined;
      this.target = message || getLocal('frontdesk:group:anchor:' + id) || '';
      this.older = [];
      this.before = undefined;
      this.timeline.replaceChildren();
      this.input.value = '';
      this.receiver.value = '';
      this.title.textContent = t('群聊');
      this.topic.textContent = '';
      this.members.replaceChildren();
      this.taskPanel.replaceChildren();
      this.taskPanel.hidden = true;
      this.taskMarkup = '';
      this.status.textContent = t('正在读取群聊');
      this.form.hidden = true;
      try { this.draft = JSON.parse(getLocal('frontdesk:group:draft:' + id) || '{"text":"","member":"","replyTo":""}'); }
      catch { this.draft = { text: '', member: '', replyTo: '' }; }
      this.panel.hidden = false;
      this.panel.parentElement?.setAttribute('data-group', '');
      this.drawDirectory();
    } else if (message) this.target = message;
    await this.refresh();
  }

  private async refresh() {
    const id = this.id;
    if (!id || this.writingRoom === id || (this.loadingRoom && this.room)) return;
    const generation = this.roomGeneration;
    const current = () => this.id === id && this.roomGeneration === generation;
    this.loadingRoom = true;
    try {
      const room = await request<GroupView>(url(id));
      if (!current()) return;
      if (this.target && !room.messages.some(message => message.id === this.target)) {
        let before = room.before;
        const accumulated: GroupMessage[] = [];
        while (before && !accumulated.some(message => message.id === this.target)) {
          const page = await request<GroupView>(url(id) + '?before=' + before);
          if (!current()) return;
          accumulated.unshift(...page.messages); before = page.before;
        }
        this.older = accumulated;
        this.before = before;
      }
      if (!this.room || this.target || JSON.stringify(this.room) !== JSON.stringify(room)) this.render(room);
    } catch (err) { if (current()) this.status.textContent = messageOf(err); }
    finally { this.loadingRoom = false; }
  }

  private label(engine: string) { return this.agents().find(agent => agent.id === engine)?.label || engine; }
  private face(engine: string) { return character(this.agents().find(agent => agent.id === engine)); }

  private render(room: GroupView) {
    const first = !this.room;
    const hostChanged = room.engine !== this.room?.engine || room.sessionId !== this.room?.sessionId || room.hostTitle !== this.room?.hostTitle;
    const membersChanged = room.members.length !== this.room?.members.length || room.members.some((member, index) => {
      const previous = this.room?.members[index];
      return !previous || memberKey(previous) !== memberKey(member) || previous.alias !== member.alias;
    });
    const follow = first || this.timeline.scrollHeight - this.timeline.scrollTop - this.timeline.clientHeight < 60;
    this.room = room;
    this.title.textContent = room.name;
    this.topic.textContent = room.topic || t('{n} 位成员', { n: room.members.length });
    const hostLabel = room.hostTitle || this.label(room.engine);
    this.members.innerHTML = (room.sessionId ? `<a data-group-link class="group-member is-host" href="${escape(nativeLink(room.engine, room.sessionId))}">${this.face(room.engine)}<span>${t('群主')} · ${escape(hostLabel)}</span></a>` : '') +
      room.members.map(member => {
        const id = nativeId(member);
        const body = `${this.face(member.engine)}<span>${escape(member.alias)}</span>${member.dedicated ? icon(id ? 'sparkles' : 'plus') : ''}`;
        const description = member.dedicated ? t(id ? '群聊专用会话' : '首次收到消息时新建会话') : member.title;
        const detail = [description, member.nativeSettings?.cwd, member.nativeSettings?.model].filter(Boolean).join(' · ');
        const chip = id ? `<a data-group-link class="group-member" title="${escape(detail)}" href="${escape(nativeLink(member.engine, id))}">${body}</a>`
          : `<button type="button" data-group-recipient="${escape(memberKey(member))}" class="group-member" title="${escape(description)}">${body}</button>`;
        const model = member.nativeSettings?.model ? `<small title="${escape(detail)}">${escape(member.nativeSettings.model)}</small>` : '';
        const edit = member.canEditSetup ? `<button type="button" class="icon-button" data-group-member-config="${escape(member.id)}"
          title="${t('成员创建设置')}" aria-label="${t('成员创建设置')}">${icon('settings')}</button>` : '';
        return model || edit ? `<div class="group-member-detail">${chip}${model}${edit}</div>` : chip;
      }).join('');
    const draftHost = room.canOpenHostDraft ? `<button type="button" data-group-prepare>${t('打开群主草稿')}</button>` : '';
    const chooseHost = `<button type="button" data-group-choose-host>${t('改选群主')}</button>`;
    this.status.innerHTML = room.state === 'project'
      ? `<span>${t('请在桌面版登记群主项目')}</span><code>${escape(room.directory)}</code>${draftHost}${chooseHost}`
      : room.state === 'blocked' ? `<span>${escape(say(room.issue || ''))}</span><button type="button" data-group-retry>${t('重试创建群主')}</button>${draftHost}${chooseHost}`
      : room.state !== 'ready' ? `${t('正在确认群主')}${room.issue ? ' · ' + escape(say(room.issue)) : ''}` : room.paused ? t('群聊已暂停') : '';
    this.panel.querySelector<HTMLButtonElement>('[data-group-pin]')!.textContent = t(room.pinned ? '取消置顶' : '置顶');
    const pause = this.panel.querySelector<HTMLButtonElement>('[data-group-pause]')!;
    pause.textContent = t(room.paused ? '继续群聊' : '暂停群聊');
    this.form.hidden = room.state !== 'ready' || room.paused;
    const options = `<option value="">${t('群主')} · ${escape(hostLabel)}</option>` + room.members.map(member => `<option value="${escape(memberKey(member))}">${escape(member.alias)}</option>`).join('');
    if (hostChanged || membersChanged) {
      const selected = this.receiver.selectedIndex === -1 ? this.draft.member : this.receiver.value;
      this.receiver.innerHTML = options;
      this.receiver.value = selected;
      if (!first && this.receiver.selectedIndex === -1) this.draft.key = undefined;
    }
    if (first) { this.receiver.value = this.draft.member; this.input.value = this.draft.text; }
    const before = this.before === undefined ? room.before : this.before;
    const messages = [...this.older, ...room.messages];
    const distinct = new Map(messages.map(message => [message.id, message]));
    const rows = [...distinct.values()].map(message => this.renderMessage(message, distinct)).join('');
    const waiting = room.deliveries.filter(item => !room.task || item.taskId !== room.task.id).map(item => this.renderDelivery(room, item)).join('');
    const empty = !rows && !waiting && room.state === 'ready' ? `<div class="group-empty">${icon('messages-square')}<h2>${t('开始讨论')}</h2><p>${t('可以请群主组织讨论，也可以直接给某个成员发消息。')}</p></div>` : '';
    this.timeline.innerHTML = (before ? `<button class="group-older" data-group-older type="button">${icon('history')}${t('查看更早发言')}</button>` : '') + rows + waiting + empty;
    this.renderTask(room);
    this.updateTaskAction();
    this.updateQuote();
    hydrateIcons(this.panel);
    const anchor = this.target && this.timeline.querySelector(`[data-message-id="${CSS.escape(this.target)}"]`);
    if (anchor) anchor.scrollIntoView({ block: 'center' });
    else if (follow) this.timeline.scrollTop = this.timeline.scrollHeight;
    this.target = '';
    setLocal('frontdesk:group:read:' + room.id, String(room.latest));
    this.drawDirectory();
  }

  private renderDelivery(room: GroupView, item: GroupDelivery, showRevision = false) {
    const label = item.kind === 'host' ? t('群主') : item.removedMember || room.members.find(member => member.engine === item.engine && member.id === (item.memberId || item.target))?.alias || this.label(item.engine);
    const state = item.outcome ? receiptOutcomes[item.outcome] : item.state === 'done' ? '投递记录已结束'
      : item.state === 'blocked' ? '未投递' : item.creatingMember ? item.state === 'queued' ? '等待新建成员会话' : '正在确认新会话'
        : item.state === 'queued' ? '等待投递' : item.state === 'waiting' ? '等待用户操作' : item.nativeTurn ? '等待目标回复' : '正在确认桌面记录';
    const href = item.creatingMember || !item.target ? '' : escape(nativeLink(item.engine, item.target, item.nativeTurn || undefined));
    const target = href ? `<a data-group-link href="${href}">${escape(label)}${icon('arrow-up-right')}</a>` : escape(label);
    const retry = item.state === 'blocked' && !room.paused ? `<button type="button" data-group-delivery-retry="${escape(item.id)}">${t('重试投递')}</button>` : '';
    const revision = showRevision && item.taskRevision !== undefined ? t('第 {n} 版', { n: item.taskRevision }) : '';
    const meta = [revision, item.removedMember ? t('已移出群聊') : ''].filter(Boolean).join(' · ');
    const tone = taskTone(item.outcome || (item.state === 'sent' && !item.nativeTurn ? 'confirming' : item.state));
    return `<div class="group-delivery">
      <span class="group-delivery-face" aria-hidden="true">${this.face(item.engine)}</span>
      <div class="group-delivery-copy"><strong>${target}</strong>${meta ? `<small>${meta}</small>` : ''}</div>
      <span class="group-state-pill" data-tone="${tone}">${t(state)}</span>
      ${item.attention || item.note || retry ? `<div class="group-delivery-detail">
        ${item.attention ? `<span>${escape(say(item.attention.title))}</span>${href ? `<a data-group-link href="${href}">${t('打开原会话处理')}</a>` : ''}` : ''}
        ${item.note ? `<span>${escape(say(item.note))}</span>` : ''}${retry}
      </div>` : ''}</div>`;
  }

  private renderTask(room: GroupView) {
    const task = room.task;
    this.taskPanel.hidden = !task;
    const markup = task ? `<details><summary>
      <span class="group-task-icon" aria-hidden="true">${icon('list-checks')}</span>
      <span class="group-task-copy"><strong>${t('查看任务进度')}</strong>${task.request ? `<span class="group-task-request" title="${escape(task.request)}">${escape(task.request)}</span>` : ''}</span>
      <span class="group-state-pill" data-tone="${taskTone(task.state)}">${t(taskLabels[task.state])}</span>
      <span class="group-task-chevron" aria-hidden="true">${icon('chevron-down')}</span>
      </summary><div class="group-task-body" tabindex="0">
      ${task.request ? `<p class="group-task-full-request">${escape(task.request)}</p>` : ''}
      ${task.deliveries.map(item => this.renderDelivery(room, item, true)).join('')}
      ${activeTaskStates.has(task.state) ? `<button type="button" data-group-task-cancel>${icon('circle-stop')}${t('停止后续派发')}</button>` : ''}
      </div></details>` : '';
    if (this.taskMarkup === markup) return;
    const previous = this.taskPanel.querySelector('details');
    const open = previous?.open || false;
    const scroll = previous?.querySelector('.group-task-body')?.scrollTop || 0;
    const focused = previous?.querySelector('summary') === document.activeElement;
    this.taskMarkup = markup;
    this.taskPanel.innerHTML = markup;
    if (!task) return;
    const details = this.taskPanel.querySelector('details')!;
    if (open) {
      details.open = true;
      details.querySelector<HTMLElement>('.group-task-body')!.scrollTop = scroll;
    }
    if (focused) details.querySelector('summary')?.focus({ preventScroll: true });
  }

  private updateTaskAction() {
    const task = this.room?.task;
    const active = !!task && activeTaskStates.has(task.state);
    const action = this.draft.taskAction;
    const failed = task?.state === 'failed';
    const shown = !this.receiver.value && (active || failed || !!action);
    this.taskAction.closest('label')!.hidden = !shown;
    if (!shown) return;
    const options = [new Option(t('选择任务操作'), '')];
    if (!active) options.push(new Option(t('开始新任务'), 'start'));
    if (active || failed) options.push(new Option(t('补充当前任务'), 'supplement'));
    if (active) options.push(new Option(t('替换当前任务'), 'replace'));
    const matches = this.draft.taskId === task?.id && this.draft.taskRevision === task?.revision;
    if (Array.from(this.taskAction.options).map(item => item.value).join(',') !== options.map(item => item.value).join(',')) {
      this.taskAction.replaceChildren(...options);
    }
    this.taskAction.value = action && (action === 'start' || matches) && options.some(item => item.value === action) ? action : '';
  }

  private changeRecipient() {
    this.draft.key = undefined;
    this.draft.taskAction = undefined;
    this.draft.taskId = undefined;
    this.draft.taskRevision = undefined;
    this.save();
    this.updateTaskAction();
  }

  private renderMessage(message: GroupMessage, messages: Map<string, GroupMessage>) {
    const reply = message.replyTo && messages.get(message.replyTo);
    const author = message.kind === 'user' ? t('你') + ' → ' + (message.author || t('群主'))
      : message.kind === 'host' ? t('群主') : message.author;
    const face = message.native?.engine && message.kind !== 'notice' ? this.face(message.native.engine)
      : message.kind === 'host' && this.room ? this.face(this.room.engine) : '';
    const sources = (message.sources || []).map((id, index) => `<a data-group-link href="#group/${enc(this.id)}/${enc(id)}">${t('依据')} ${index + 1}</a>`).join('');
    return `<article class="group-message" data-kind="${message.kind}" data-message-id="${escape(message.id)}">
      <header>${face ? `<span class="group-message-face" aria-hidden="true">${face}</span>` : ''}<strong>${escape(author || t('群聊'))}</strong>${message.taskRevision && message.taskRevision > 1 ? `<span class="group-message-tag">${t('第 {n} 版', { n: message.taskRevision })}</span>` : ''}${message.decision ? `<span class="group-message-tag is-decision">${t('结论')}</span>` : ''}</header>
      ${reply ? `<blockquote>${escape(reply.text.slice(0, 150))}</blockquote>` : ''}
      <div class="markdown">${markdown(message.kind === 'notice' || !message.native && message.kind === 'member' ? say(message.text) : message.text)}</div>
      <footer>${sources}${message.replaces ? `<a data-group-link href="#group/${enc(this.id)}/${enc(message.replaces)}">${t('查看被取代的结论')}</a>` : ''}
        ${message.native ? `<a data-group-link href="${escape(nativeLink(message.native.engine, message.native.id, message.native.turn))}">${t('查看原会话')}</a>` : ''}
        <button type="button" data-group-quote="${escape(message.id)}">${t('回复这条')}</button>
        ${message.decision ? `<button type="button" data-group-report="${escape(message.id)}">${t('汇报给总控')}</button>` : ''}
      </footer>
    </article>`;
  }

  private save() {
    if (!this.id || !this.room) return;
    this.draft.text = this.input.value;
    if (this.receiver.selectedIndex !== -1) this.draft.member = this.receiver.value;
    setLocal('frontdesk:group:draft:' + this.id, JSON.stringify(this.draft));
  }

  private updateQuote() {
    const quote = this.form.querySelector<HTMLElement>('.group-quote')!;
    quote.hidden = !this.draft.replyTo;
    if (!quote.hidden) {
      const message = [...this.older, ...(this.room?.messages || [])].find(item => item.id === this.draft.replyTo);
      quote.innerHTML = `${icon('message-square-quote')}<span>${escape(message?.text.slice(0, 130) || t('引用发言'))}</span><button type="button" data-group-unquote title="${t('移除引用')}" aria-label="${t('移除引用')}">${icon('x')}</button>`;
      hydrateIcons(quote);
    }
  }

  private async send() {
    if (!this.id || this.sending || this.writingRoom || !this.input.value.trim()) return;
    if (this.receiver.selectedIndex === -1) {
      this.status.textContent = t('请选择收件人后再发送');
      this.receiver.focus();
      return;
    }
    if (!this.taskAction.closest('label')!.hidden && !this.taskAction.value) {
      this.status.textContent = t('可直接查看任务进度，或选择任务操作后发送');
      this.taskAction.focus();
      return;
    }
    const id = this.id;
    const generation = ++this.roomGeneration;
    this.sending = true;
    this.writingRoom = id;
    const submit = this.form.querySelector<HTMLButtonElement>('button[type=submit]')!;
    submit.disabled = true;
    this.draft.key ||= crypto.randomUUID();
    this.save();
    try {
      const updated = await request<GroupView>(url(id) + '/messages', post(this.draft));
      if (this.id !== id) {
        setLocal('frontdesk:group:draft:' + id, JSON.stringify({ text: '', member: '', replyTo: '' }));
        return;
      }
      if (generation !== this.roomGeneration) return;
      this.draft = { text: '', member: this.receiver.value, replyTo: '' }; this.input.value = ''; this.save();
      this.render(updated);
    } catch (err) { if (this.id === id && generation === this.roomGeneration) this.status.textContent = messageOf(err); }
    finally { this.sending = false; this.writingRoom = ''; submit.disabled = false; }
  }

  private async action(event: MouseEvent) {
    const menu = this.panel.querySelector<HTMLDetailsElement>('.group-more');
    if (menu?.open && !(event.target as Element | null)?.closest('.group-more > summary')) {
      const restoreFocus = menu.contains(document.activeElement);
      menu.open = false;
      if (restoreFocus) menu.querySelector('summary')?.focus({ preventScroll: true });
    }
    const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[data-group-link]');
    if (link && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      this.followLink(link.hash);
      return;
    }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!button || this.dialog.contains(button)) return;
    if (button.hasAttribute('data-group-back')) return this.back();
    if (button.hasAttribute('data-group-sidebar')) return this.openSidebar();
    if (!this.room) return;
    const room = this.room, base = url(room.id);
    try {
      if (button.dataset['groupMemberConfig']) {
        const member = room.members.find(item => item.id === button.dataset['groupMemberConfig']);
        if (member?.canEditSetup) this.editMember(room, member);
        return;
      }
      if (button.dataset['groupRecipient']) {
        if (this.form.hidden) return;
        this.receiver.value = button.dataset['groupRecipient'];
        this.changeRecipient(); this.input.focus(); return;
      }
      if (button.dataset['groupQuote']) {
        this.draft.replyTo = button.dataset['groupQuote']; this.draft.key = undefined;
        this.save(); this.updateQuote(); this.input.focus(); return;
      }
      if (button.hasAttribute('data-group-unquote')) {
        this.draft.replyTo = ''; this.draft.key = undefined; this.save(); this.updateQuote(); return;
      }
      if (button.hasAttribute('data-group-older')) {
        const before = this.before === undefined ? room.before : this.before;
        if (!before) return;
        const page = await request<GroupView>(base + '?before=' + before);
        if (this.id !== room.id) return;
        this.target = ([...this.older, ...room.messages][0]?.id || '');
        this.older.unshift(...page.messages); this.before = page.before; this.render(room); return;
      }
      if (button.hasAttribute('data-group-manage')) {
        this.createDialog(room);
      } else if (button.hasAttribute('data-group-rename')) {
        const name = window.prompt(t('群名'), room.name)?.trim();
        if (name) this.render(await request<GroupView>(base + '/name', post({ name }, 'PUT')));
      } else if (button.hasAttribute('data-group-pin')) {
        const updated = await request<GroupView>(base + '/pin', post({ pinned: !room.pinned }, 'PUT'));
        if (this.id === room.id) this.render(updated);
      } else if (button.hasAttribute('data-group-pause')) {
        this.render(await request<GroupView>(base + '/pause', post({ paused: !room.paused }, 'PUT')));
      } else if (button.hasAttribute('data-group-task-cancel')) {
        const task = room.task;
        if (!task || this.writingRoom || !window.confirm(t('停止后续派发？已发出的桌面轮次会继续执行。'))) return;
        const generation = ++this.roomGeneration;
        this.writingRoom = room.id;
        try {
          const updated = await request<GroupView>(base + '/task/cancel', post({ taskId: task.id, taskRevision: task.revision }));
          if (this.id === room.id && generation === this.roomGeneration) this.render(updated);
        } finally { this.writingRoom = ''; }
      } else if (button.hasAttribute('data-group-prepare')) {
        this.render(await request<GroupView>(base + '/prepare', { method: 'POST' }));
      } else if (button.hasAttribute('data-group-retry')) {
        const updated = await request<GroupView>(base + '/retry', { method: 'POST' });
        if (this.id === room.id) this.render(updated);
      } else if (button.hasAttribute('data-group-choose-host')) {
        this.changeHostDialog(room);
      } else if (button.dataset['groupDeliveryRetry']) {
        const updated = await request<GroupView>(base + '/deliveries/' + enc(button.dataset['groupDeliveryRetry']) + '/retry', { method: 'POST' });
        if (this.id === room.id) this.render(updated);
      } else if (button.dataset['groupReport']) {
        await request(base + '/report/' + enc(this.currentEngine()), post({ message: button.dataset['groupReport'], key: crypto.randomUUID() }));
        await this.refresh();
      }
    } catch (err) { if (this.id === room.id) this.status.textContent = messageOf(err); }
  }

  private changeHostDialog(room: GroupView) {
    const dialog = this.dialog;
    dialog.setAttribute('aria-labelledby', 'group-change-host-title');
    dialog.innerHTML = `<div class="group-dialog-head"><div><h2 id="group-change-host-title">${t('改选群主')}</h2>
      <p>${escape(room.name)}</p></div><button type="button" class="icon-button" data-group-dialog-close aria-label="${t('关闭')}">${icon('x')}</button></div>
      <form class="group-create-form">${hostPickerFields()}
        <div class="group-dialog-foot"><p role="status"></p><button type="button" data-group-dialog-close>${t('取消')}</button>
          <button type="submit" class="primary-button" disabled>${t('保存')}</button></div>
      </form>`;
    const form = dialog.querySelector('form')!;
    const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
    const status = form.querySelector<HTMLElement>('[role=status]')!;
    let saving = false;
    const picker = hostPicker(form, room.engine, () => { submit.disabled = saving || !picker.value(); });
    dialog.onclick = event => {
      if (!saving && (event.target as Element).closest('[data-group-dialog-close]')) dialog.close();
    };
    dialog.oncancel = event => { if (saving) event.preventDefault(); };
    form.onsubmit = async event => {
      event.preventDefault();
      const choice = picker.value();
      if (!choice || saving) return;
      saving = submit.disabled = true;
      try {
        const updated = await request<GroupView>(url(room.id) + '/host/' + enc(choice.engine), post(choice, 'PUT'));
        dialog.close();
        if (this.id === room.id) this.render(updated);
        await this.refreshDirectory();
      } catch (error) { status.textContent = messageOf(error); }
      finally { saving = false; submit.disabled = !picker.value(); }
    };
    hydrateIcons(dialog);
    dialog.showModal();
    void request<GroupEngine[]>('/api/group-engines').then(items => {
      if (dialog.open && form.isConnected) picker.setAgents(items);
    }).catch(error => { if (dialog.open && form.isConnected) status.textContent = messageOf(error); });
  }

  private editMember(room: GroupView, member: GroupMember) {
    const dialog = this.dialog;
    dialog.setAttribute('aria-labelledby', 'group-config-title');
    dialog.innerHTML = `<div class="group-dialog-head"><span class="group-emblem">${this.face(member.engine)}</span>
      <div><h2 id="group-config-title">${t('成员创建设置')}</h2><p>${escape(member.alias)} · ${escape(this.label(member.engine))}</p></div>
      <button type="button" class="icon-button" data-group-dialog-close aria-label="${t('关闭')}">${icon('x')}</button></div>
      <form class="group-create-form">
        ${room.workspace ? `<small class="group-project-context">${t('群默认项目')} · ${escape(room.workspace)}</small>` : ''}
        <div data-edit-setup></div>
        <div class="group-dialog-foot"><p role="status"></p><button type="button" data-group-dialog-close>${t('取消')}</button>
          <button type="submit" class="primary-button">${t('保存')}</button></div>
      </form>`;
    const form = dialog.querySelector('form')!;
    const fields = form.querySelector<HTMLElement>('[data-edit-setup]')!;
    const status = form.querySelector<HTMLElement>('[role=status]')!;
    const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
    let setup = member.setup;
    fields.innerHTML = setupFields(member);
    form.oninput = () => { setup = readSetup(fields, setup); };
    dialog.onclick = event => {
      if (!submit.disabled && (event.target as Element).closest('[data-group-dialog-close]')) dialog.close();
    };
    dialog.oncancel = event => { if (submit.disabled) event.preventDefault(); };
    form.onsubmit = async event => {
      event.preventDefault();
      submit.disabled = true;
      try {
        const updated = await request<GroupView>(url(room.id) + '/members/' + enc(member.id) + '/setup', post(readSetup(fields, setup), 'PUT'));
        dialog.close();
        if (this.id === room.id) this.render(updated);
      } catch (error) { status.textContent = messageOf(error); }
      finally { submit.disabled = false; }
    };
    hydrateIcons(dialog);
    dialog.showModal();
    void memberOptions(member.engine).then(options => {
      if (fields.isConnected && dialog.open && !submit.disabled) showMemberOptions(fields, options);
    }).catch(error => { if (fields.isConnected && dialog.open) status.textContent = messageOf(error); });
  }

  private createDialog(editing?: GroupView) {
    const dialog = this.dialog;
    const defaultHost = this.currentEngine();
    dialog.setAttribute('aria-labelledby', 'group-create-title');
    dialog.innerHTML = `
      <div class="group-dialog-head">
        <span class="group-emblem" aria-hidden="true">${icon('users-round')}</span>
        <div><h2 id="group-create-title">${t(editing ? '管理成员' : '新建群聊')}</h2>${editing ? `<p>${escape(editing.name)}</p>` : ''}</div>
        <button type="button" class="icon-button" data-group-dialog-close aria-label="${t('关闭')}">${icon('x')}</button>
      </div>
      <form class="group-create-form">
        ${editing ? '' : `<div class="group-setup-fields">
          <label>${t('群名')}<input name="name" required maxlength="120" autocomplete="off" autofocus></label>
          <label>${t('讨论主题')}<input name="topic" maxlength="1000" autocomplete="off" placeholder="${t('选填')}"></label>
          <label class="group-default-project">${t('群默认项目')}
            <input name="workspace" list="new-group-projects" placeholder="${t('选择项目或留空用于讨论')}" maxlength="4096" autocomplete="off">
            <datalist id="new-group-projects"></datalist>
          </label>
        </div>
        ${hostPickerFields()}`}
        <div class="group-picker">
          <div class="group-picker-main">
            <div class="group-mode-tabs" role="group" aria-label="${t('添加成员')}">
              <button type="button" data-group-mode="new" aria-pressed="true">${icon('sparkles')}${t('新建专用会话')}</button>
              <button type="button" data-group-mode="existing" aria-pressed="false">${icon('history')}${t('选择已有会话')}</button>
            </div>
            <p class="group-picker-hint"></p>
            <div class="group-member-search" hidden>
              <select aria-label="${t('引擎')}"></select>
              <input type="search" aria-label="${t('搜索会话')}" placeholder="${t('搜索会话')}">
            </div>
            <div class="group-candidates" aria-live="polite"></div>
          </div>
          <div class="group-selection">
            <h3>${t(editing ? '群成员' : '已选成员')} <span>0</span></h3>
            <div class="group-selected"></div>
          </div>
        </div>
        ${editing ? `<p class="group-picker-hint">${t('移除成员会撤销尚未发送的任务。已发出或待确认的任务会保留投递记录。')}</p>` : ''}
        <div class="group-dialog-foot">
          <p role="status"></p>
          <button type="button" data-group-dialog-close>${t('取消')}</button>
          <button class="primary-button" type="submit" disabled>${t(editing ? '保存' : '创建群聊')}${icon('arrow-right')}</button>
        </div>
      </form>`;
    const form = dialog.querySelector<HTMLFormElement>('form')!;
    const candidates = form.querySelector<HTMLElement>('.group-candidates')!;
    const selection = form.querySelector<HTMLElement>('.group-selected')!;
    const status = form.querySelector<HTMLElement>('[role=status]')!;
    const count = form.querySelector<HTMLElement>('.group-selection h3 span')!;
    const filters = form.querySelector<HTMLElement>('.group-member-search')!;
    const hint = form.querySelector<HTMLElement>('.group-picker-hint')!;
    const select = filters.querySelector<HTMLSelectElement>('select')!;
    const query = filters.querySelector<HTMLInputElement>('input')!;
    const submit = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
    const key = crypto.randomUUID(), selected = new Map<string, GroupMember>();
    const current = new Set(editing?.members.map(memberKey));
    const removed = new Set<string>();
    const optionsByEngine = new Map<string, GroupMemberOptions>();
    const loadingOptions = new Set<string>();
    let agents: GroupEngine[] = [], results: GroupMember[] = [], mode = 'new', creating = false, ready = false, searching = false;
    let searchError = '', searchVersion = 0, searchTimer: number | undefined;
    const changed = () => selected.size + removed.size > 0;
    const updateSubmit = () => { submit.disabled = creating || (editing ? !changed() : !picker?.value()); };
    const picker = editing ? undefined : hostPicker(form, defaultHost, updateSubmit);

    const drawCandidates = () => {
      filters.hidden = mode === 'new';
      hint.textContent = t(mode === 'new' ? '成员首次收到消息时，才会创建专用会话。' : '可以跨 Agent 多选，已有会话会保留原来的上下文。');
      const empty = !ready || searching ? t('正在读取…') : t(mode === 'new' ? '没有可新建专用会话的 Agent' : '没有匹配的会话');
      const rows = mode === 'new'
        ? agents.filter(agent => agent.canCreate).map(agent =>
          `<button type="button" class="group-option" data-group-new="${escape(agent.id)}">${this.face(agent.id)}
            <span><strong>${escape(this.label(agent.id))}</strong><small>${t('群聊专用会话')}</small></span><i aria-hidden="true">${icon('plus')}</i></button>`)
        : results.map((member, index) => {
          const picked = selected.has(memberKey(member));
          const present = current.has(memberKey(member));
          return `<button type="button" class="group-option" data-group-add="${index}" aria-pressed="${picked || present}" ${present ? 'disabled' : ''}>${this.face(member.engine)}
            <span><strong>${escape(member.title)}</strong><small>${escape(this.label(member.engine))}${member.groups?.length
              ? ' · ' + t('也在这些群聊中') + ' ' + escape(member.groups.join('、')) : ''}</small></span>
            <i aria-hidden="true">${icon(picked || present ? 'check' : 'plus')}</i></button>`;
        });
      candidates.innerHTML = searchError && mode === 'existing' ? `<p class="group-picker-empty">${escape(searchError)}</p>`
        : rows.join('') || `<p class="group-picker-empty">${empty}</p>`;
      hydrateIcons(candidates);
    };
    const drawSelection = () => {
      count.textContent = String(current.size - removed.size + selected.size);
      const roster = (editing?.members || []).map(member => {
        const marked = removed.has(memberKey(member));
        return `<div class="group-selection-row group-roster-row" data-removed="${marked}">
          ${this.face(member.engine)}
          <span><strong>${escape(member.alias)}</strong><small>${escape(this.label(member.engine))}</small></span>
          <button type="button" data-group-toggle-removal="${escape(memberKey(member))}">${t(marked ? '撤销移除' : '移出群聊')}</button>
        </div>`;
      }).join('');
      selection.innerHTML = roster + [...selected.values()].map(member => `<div class="group-selection-row" data-group-selection-key="${escape(memberKey(member))}">
        ${this.face(member.engine)}
        <label><small>${escape(this.label(member.engine))} · ${t(member.dedicated ? '新会话' : '已有会话')}</small>
          <input data-member-key="${escape(memberKey(member))}" value="${escape(member.alias)}" aria-label="${t('成员别名')}" maxlength="80" required></label>
        <button type="button" class="icon-button" data-group-remove="${escape(memberKey(member))}" aria-label="${t('移除')}">${icon('x')}</button>
        ${member.dedicated ? setupFields(member, optionsByEngine.get(member.engine)) : ''}
      </div>`).join('') || `<p class="group-picker-empty">${t('从左侧添加讨论成员')}</p>`;
      updateSubmit();
      hydrateIcons(selection);
    };
    const find = async () => {
      if (!ready || mode !== 'existing') return;
      const version = ++searchVersion;
      searching = true;
      searchError = '';
      results = [];
      drawCandidates();
      try {
        const params = new URLSearchParams({ engine: select.value, q: query.value.trim() });
        const found = await request<GroupMember[]>('/api/group-members?' + params);
        if (version === searchVersion) results = found;
      } catch (err) { if (version === searchVersion) searchError = messageOf(err); }
      finally { if (version === searchVersion) { searching = false; drawCandidates(); } }
    };
    const uniqueAlias = (base: string) => {
      const retained = (editing?.members || []).filter(item => !removed.has(memberKey(item)));
      const aliases = new Set([...retained, ...selected.values()].map(item => item.alias.normalize('NFKC').trim().toLowerCase()));
      let alias = base.slice(0, 72), suffix = 1;
      while (aliases.has(alias.normalize('NFKC').trim().toLowerCase())) alias = base.slice(0, 72) + ' ' + ++suffix;
      return alias;
    };
    const add = (member: GroupMember) => {
      if (current.size - removed.size + selected.size >= 20) { status.textContent = t('一个群最多可添加 20 位成员'); return; }
      selected.set(memberKey(member), { ...member, alias: uniqueAlias(member.alias.trim() || this.label(member.engine)) });
      status.textContent = '';
      drawSelection();
      if (member.dedicated && !optionsByEngine.has(member.engine) && !loadingOptions.has(member.engine)) {
        loadingOptions.add(member.engine);
        void memberOptions(member.engine).then(options => {
          optionsByEngine.set(member.engine, options);
          if (!form.isConnected || !dialog.open) return;
          const projects = new Map([...optionsByEngine.values()].flatMap(item => item.projects).map(project => [project.cwd, project]));
          const groupProjects = form.querySelector('datalist#new-group-projects');
          if (groupProjects) groupProjects.innerHTML = projectSuggestions([...projects.values()]);
          for (const row of selection.querySelectorAll<HTMLElement>('[data-group-selection-key]')) {
            const picked = selected.get(row.dataset['groupSelectionKey'] || '');
            if (picked?.dedicated && picked.engine === member.engine) showMemberOptions(row, options);
          }
        }).catch(error => { if (form.isConnected && dialog.open) status.textContent = messageOf(error); })
          .finally(() => loadingOptions.delete(member.engine));
      }
      if (mode === 'existing') drawCandidates();
    };
    dialog.onclick = event => {
      const button = (event.target as HTMLElement).closest('button');
      if (!button || creating) return;
      if (button.hasAttribute('data-group-dialog-close')) { dialog.close(); return; }
      const removal = button.dataset['groupToggleRemoval'];
      if (removal) {
        if (!removed.delete(removal)) removed.add(removal);
        status.textContent = '';
        drawSelection();
        return;
      }
      const next = button.dataset['groupMode'];
      if (next && next !== mode) {
        mode = next; searchVersion++; searching = false;
        for (const tab of form.querySelectorAll<HTMLButtonElement>('[data-group-mode]')) tab.setAttribute('aria-pressed', String(tab.dataset['groupMode'] === mode));
        drawCandidates();
        if (mode === 'existing') void find();
      }
      const engine = agents.find(agent => agent.canCreate && agent.id === button.dataset['groupNew']);
      if (engine) add({ id: crypto.randomUUID(), engine: engine.id, title: this.label(engine.id), alias: this.label(engine.id), dedicated: true });
      const member = results[Number(button.dataset['groupAdd'])];
      const removing = button.dataset['groupRemove'] || (member && selected.has(memberKey(member)) ? memberKey(member) : '');
      if (removing) { selected.delete(removing); status.textContent = ''; drawSelection(); drawCandidates(); }
      else if (member) add(member);
    };
    form.oninput = event => {
      if (event.target instanceof Element) {
        const row = event.target.closest<HTMLElement>('[data-group-selection-key]');
        const member = row && selected.get(row.dataset['groupSelectionKey'] || '');
        if (row && member?.dedicated && event.target.closest('[data-group-member-setup]')) member.setup = readSetup(row);
      }
      if (!(event.target instanceof HTMLInputElement)) return;
      const member = selected.get(event.target.dataset['memberKey'] || '');
      if (member) member.alias = event.target.value;
      if (event.target === query) {
        clearTimeout(searchTimer);
        searchVersion++;
        searchTimer = window.setTimeout(() => void find(), 180);
      }
    };
    select.onchange = () => void find();
    query.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); clearTimeout(searchTimer); void find(); } };
    form.onsubmit = async event => {
      event.preventDefault();
      const host = picker?.value();
      if (creating || (editing ? !changed() : !host)) return;
      const fields = new FormData(form);
      creating = true;
      submit.disabled = true;
      status.textContent = t(editing ? '正在保存…' : '正在创建群聊…');
      const members = [...selected.values()].map(({ engine, id, alias, dedicated, setup }) =>
        dedicated ? { engine, alias, newSession: true, setup } : { engine, id, alias });
      try {
        if (editing) {
          const remove = editing.members.filter(member => removed.has(memberKey(member))).map(({ engine, id }) => ({ engine, id }));
          const updated = await request<GroupView>(url(editing.id) + '/members', post({ add: members, remove }, 'PATCH'));
          dialog.close();
          if (this.id === updated.id) this.render(updated);
        } else if (host) {
          const room = await request<GroupView>(api + '/' + enc(host.engine) + '/create', post({
            name: fields.get('name'), topic: fields.get('topic'), workspace: fields.get('workspace'), key, hostSession: host.hostSession, members,
          }));
          dialog.close();
          this.show(room.id);
        }
        await this.refreshDirectory();
      } catch (err) { status.textContent = messageOf(err); }
      finally { creating = false; updateSubmit(); }
    };
    dialog.oncancel = event => { if (creating) event.preventDefault(); };
    hydrateIcons(dialog);
    drawCandidates();
    drawSelection();
    dialog.showModal();
    void request<GroupEngine[]>('/api/group-engines').then(items => {
      if (!dialog.open || !form.isConnected) return;
      agents = items; ready = true;
      picker?.setAgents(items);
      select.innerHTML = `<option value="">${t('所有 Agent')}</option>` + agents.map(agent => `<option value="${escape(agent.id)}">${escape(this.label(agent.id))}</option>`).join('');
      drawCandidates();
      if (mode === 'existing') void find();
    }).catch(err => { ready = true; drawCandidates(); status.textContent = messageOf(err); });
  }
}
