import type { GroupResults, GroupTemplateInput, GroupTemplatePreview } from '../../shared/group-workflow.js';
import type { GroupMessage, GroupView } from '../../shared/groups.js';
import { messageOf } from '../../shared/guards.js';
import { request } from './api.js';
import { language, t } from './i18n.js';
import { escape, hydrateIcons, icon, markdown } from './renderers.js';

const api = (room: string) => '/api/groups/' + encodeURIComponent(room);
const submit = (body: unknown, method = 'POST') => ({ method, body: JSON.stringify(body) });
const sourceLink = (room: string, message: string) => '#group/' + encodeURIComponent(room) + '/' + encodeURIComponent(message);
const nativeLink = (message: NonNullable<GroupMessage['native']>) => '#' + [message.engine, message.id, message.turn].map(encodeURIComponent).join('/');
const hasOutput = (entry: GroupResults['entries'][number]) => entry.delivery?.outcome === 'completed' &&
  (entry.message?.kind === 'member' || entry.message?.decision === true);
const outcomes = { completed: '原生轮次已结束', failed: '原会话任务失败', interrupted: '原会话任务已停止', cancelled: '已撤销待投递消息' } as const;
const pending = { queued: '等待投递', sent: '等待目标回复', blocked: '未投递', waiting: '等待用户操作', done: '投递记录已结束' } as const;
const planned = { planned: '等待上一步结果', paused: '群任务已暂停', cancelled: '已停止后续派发',
  'previous-failed': '前一步未完成', removed: '已移出群聊', 'not-sent': '未投递' } as const;

export class GroupWorkflowDialog {
  private readonly dialog = document.createElement('dialog');
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly label: (id: string) => string, private readonly navigate: (hash: string) => void) {
    this.dialog.className = 'group-dialog group-workflow-dialog';
    this.dialog.addEventListener('close', () => { clearInterval(this.timer); this.timer = undefined; });
    document.body.append(this.dialog);
  }

  close() { if (this.dialog.open) this.dialog.close(); }

  private header(title: string, subtitle: string) {
    this.dialog.setAttribute('aria-labelledby', 'group-workflow-title');
    return `<header class="group-dialog-head"><div><h2 id="group-workflow-title">${t(title)}</h2><p>${escape(subtitle)}</p></div>
      <button type="button" class="icon-button" data-workflow-close aria-label="${t('关闭')}">${icon('x')}</button></header>`;
  }

  template(room: GroupView, messages: GroupMessage[], quoted: string, onStart: (view: GroupView) => void) {
    const dialog = this.dialog;
    const key = 'frontdesk:group:template:' + room.id;
    type Confirm = GroupTemplateInput & { version: number; key: string };
    let preview: GroupTemplatePreview | undefined, confirmation: Confirm | undefined;
    try {
      const saved = JSON.parse(localStorage.getItem(key) || 'null') as { preview: GroupTemplatePreview; confirmation: Confirm } | null;
      preview = saved?.preview;
      confirmation = saved?.confirmation;
    } catch { /* Storage is optional. */ }
    const membership = (member: GroupView['members'][number]) => member.enrollmentId || JSON.stringify([member.engine, member.id]);
    const members = room.members.map(member => `<option value="${escape(membership(member))}">${escape(member.alias)} · ${escape(this.label(member.engine))}</option>`).join('');
    const available = messages.filter(message => message.text).slice(-12);
    const cited = messages.find(message => message.id === quoted);
    if (cited && !available.includes(cited)) available.unshift(cited);
    const sources = available.map(message => `<label class="group-workflow-checkbox"><input type="checkbox" name="source" value="${escape(message.id)}"${message.id === quoted ? ' checked' : ''}>
      <span>${escape(message.text.replace(/\s+/g, ' ').slice(0, 130))}</span></label>`).join('');
    dialog.innerHTML = this.header('使用模板', room.name) + `<form class="group-create-form group-workflow-form">
      <div data-template-edit>
        <label>${t('任务模板')}<select name="template"><option value="proposals">${t('双案提案')}</option><option value="evidence">${t('证据复核')}</option></select></label>
        <p class="field-help" data-template-mode></p>
        <div class="group-workflow-two">${[0, 1].map(index => `<div><label>${t('成员 {n}', { n: index + 1 })}<select name="member${index}" required><option value="">${t('选择成员')}</option>${members}</select></label>
          <label>${t('分工说明')}<input name="role${index}" placeholder="${t('选填')}" maxlength="600"></label></div>`).join('')}</div>
        <label>${t('任务材料')}<textarea name="material" required maxlength="6000"></textarea></label>
        <label>${t('验收条件')}<textarea name="criteria" required maxlength="2000"></textarea></label>
        ${sources ? `<details><summary>${t('引用群发言（最多 3 条）')}</summary>${sources}</details>` : ''}
        <label class="group-workflow-checkbox"><input type="checkbox" name="summarize">${t('收齐结果后请群主汇总')}</label>
      </div>
      <div data-template-preview hidden></div>
      <div class="group-dialog-foot"><p role="status"></p><button type="button" data-template-back hidden>${t('返回编辑')}</button>
        <button type="submit" class="primary-button">${t('预览派发')}</button></div>
    </form>`;
    const form = dialog.querySelector('form')!;
    const edit = form.querySelector<HTMLElement>('[data-template-edit]')!;
    const previewBox = form.querySelector<HTMLElement>('[data-template-preview]')!;
    const status = form.querySelector<HTMLElement>('[role=status]')!;
    const button = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
    const back = form.querySelector<HTMLButtonElement>('[data-template-back]')!;
    const text = (name: string) => String(new FormData(form).get(name) || '');
    if (confirmation) {
      const fields: Record<string, string> = { template: confirmation.template, material: confirmation.material,
        criteria: confirmation.criteria, member0: confirmation.members[0], member1: confirmation.members[1],
        role0: confirmation.roles[0], role1: confirmation.roles[1] };
      for (const [name, value] of Object.entries(fields)) (form.elements.namedItem(name) as HTMLInputElement).value = value;
      for (const checkbox of form.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
        checkbox.checked = checkbox.name === 'summarize' ? confirmation.summarize : confirmation.sources.includes(checkbox.value);
      }
    }
    const paint = () => {
      const evidence = text('template') === 'evidence';
      form.querySelector('[data-template-mode]')!.textContent = t(evidence ? '第一位提交主张后，第二位复核。' : '两位成员收到同一份材料，各自给出方案。');
      edit.hidden = !!preview; previewBox.hidden = !preview; back.hidden = !preview;
      form.noValidate = !!preview;
      button.textContent = t(preview ? '确认派发' : '预览派发');
      previewBox.innerHTML = preview ? preview.steps.map(step => `<section class="group-workflow-step"><strong>${escape(step.member)} · ${escape(this.label(step.engine))}</strong>
        <pre>${escape(step.prompt)}</pre>${step.followsPrevious ? `<p>${t('附上第一位成员本次的原生结果摘录（最多 2500 字）。')}</p>` : ''}</section>`).join('')
        + (preview.sources.length ? `<details><summary>${t('随任务发送的引用')}</summary>${preview.sources.map(item => `<blockquote>${escape(item.text)}${item.truncated ? '…' : ''}</blockquote>`).join('')}</details>` : '')
        + (confirmation?.summarize ? `<p class="field-help">${t('收齐结果后请群主汇总')}</p>` : '') : '';
    };
    const remember = (save: boolean) => {
      try { if (save) localStorage.setItem(key, JSON.stringify({ preview, confirmation })); else localStorage.removeItem(key); } catch { /* Storage is optional. */ }
    };
    let busy = false;
    form.onchange = paint;
    dialog.onclick = event => {
      const target = event.target as Element;
      if (busy) return;
      if (target.closest('[data-workflow-close]')) dialog.close();
      if (target.closest('[data-template-back]')) { preview = confirmation = undefined; remember(false); status.textContent = ''; paint(); }
    };
    dialog.oncancel = event => { if (busy) event.preventDefault(); };
    form.onsubmit = async event => {
      event.preventDefault();
      if (busy) return;
      busy = button.disabled = back.disabled = true;
      const closing = dialog.querySelector<HTMLButtonElement>('[data-workflow-close]')!;
      closing.disabled = true;
      status.textContent = '';
      try {
        if (preview && confirmation) {
          remember(true);
          const updated = await request<GroupView>(api(room.id) + '/templates', submit(confirmation));
          remember(false);
          dialog.close();
          onStart(updated);
        } else {
          const data = new FormData(form);
          const input: GroupTemplateInput = { template: text('template') === 'evidence' ? 'evidence' : 'proposals',
            members: [text('member0'), text('member1')], roles: [text('role0'), text('role1')],
            material: text('material'), criteria: text('criteria'), sources: data.getAll('source').map(String),
            summarize: data.has('summarize'), language };
          preview = await request<GroupTemplatePreview>(api(room.id) + '/templates/preview', submit(input));
          confirmation = { ...input, version: preview.version, key: crypto.randomUUID() };
          paint();
        }
      } catch (error) { status.textContent = messageOf(error); }
      finally { busy = button.disabled = back.disabled = closing.disabled = false; }
    };
    paint();
    hydrateIcons(dialog);
    dialog.showModal();
  }

  results(room: GroupView, taskId: string, revision: number, revise: (entry: GroupResults['entries'][number]) => void) {
    const dialog = this.dialog;
    dialog.innerHTML = this.header('任务结果', room.name + ' · ' + t('第 {n} 版', { n: revision })) + `<section class="group-create-form">
      <p data-result-status role="status">${t('正在读取结果…')}</p><div class="group-result-cards"></div>
      <footer class="group-dialog-foot"><button type="button" class="secondary-button" data-result-copy disabled>${icon('copy')}${t('复制选中的 Markdown')}</button></footer>
      <textarea data-result-export aria-label="${t('Markdown')}" readonly hidden></textarea></section>`;
    const status = dialog.querySelector<HTMLElement>('[data-result-status]')!;
    const cards = dialog.querySelector<HTMLElement>('.group-result-cards')!;
    const copy = dialog.querySelector<HTMLButtonElement>('[data-result-copy]')!;
    const selected = new Map<string, boolean>();
    let data: GroupResults | undefined, busy = false;
    const labelOf = (item: GroupResults['entries'][number]) => [item.label || t('群主'), item.engine && this.label(item.engine)].filter(Boolean).join(' · ');
    const selectedEntries = () => (data?.entries || []).filter(item => hasOutput(item) && (selected.get(item.id) ?? item.adopted));
    const paint = (view: GroupResults) => {
      if (!dialog.open || !cards.isConnected) return;
      data = view;
      status.textContent = view.entries.length ? '' : t('等待本次任务的结果');
      const markup = view.entries.map(item => {
        const message = item.message, delivery = item.delivery;
        const state = item.pending ? planned[item.pending] : delivery?.outcome ? outcomes[delivery.outcome]
          : delivery?.awaitingOutcome ? '正在确认原生轮次结果'
            : delivery?.state === 'sent' && !delivery.nativeTurn ? '正在确认桌面记录'
              : delivery?.state === 'queued' && delivery.note ? '群任务受阻' : delivery ? pending[delivery.state] : '';
        const usable = hasOutput(item);
        return `<article class="group-result-card"><header><strong>${escape(labelOf(item))}</strong>
          <span class="group-state-pill" data-tone="${usable ? 'positive' : 'neutral'}">${t(state)}</span>
          ${item.adopted ? `<span class="group-state-pill" data-tone="positive">${t('已采纳')}</span>` : ''}</header>
          ${message ? `<div class="markdown">${markdown(message.text)}</div>` : ''}
          ${delivery?.note ? `<p class="field-help">${escape(delivery.note)}</p>` : ''}
          <footer>${message ? `<a href="${escape(sourceLink(room.id, message.id))}">${t('查看群发言')}</a>` : ''}
          ${message?.native ? `<a href="${escape(nativeLink(message.native))}">${t('查看原会话')}</a>`
            : delivery?.target && !delivery.creatingMember ? `<a href="${escape(nativeLink({ engine: delivery.engine, id: delivery.target, turn: delivery.nativeTurn || '' }))}">${t('查看原会话')}</a>` : ''}
          ${message?.sources?.map((id, index) => `<a href="${escape(sourceLink(room.id, id))}">${t('依据')} ${index + 1}</a>`).join('') || ''}
          ${usable ? `<button type="button" data-result-adopt="${escape(item.id)}">${t(item.adopted ? '取消采纳' : '采纳')}</button>
          ${room.paused ? '' : `<button type="button" data-result-revise="${escape(item.id)}">${t('退回修改')}</button>`}
          <label class="group-workflow-checkbox"><input type="checkbox" data-result-select="${escape(item.id)}"${(selected.get(item.id) ?? item.adopted) ? ' checked' : ''}>${t('选中以复制')}</label>` : ''}</footer></article>`;
      }).join('');
      if (cards.dataset.markup !== markup) { cards.dataset.markup = markup; cards.innerHTML = markup; }
      copy.disabled = !selectedEntries().length;
    };
    const load = async () => {
      if (busy || !dialog.open) return;
      busy = true;
      try { paint(await request<GroupResults>(api(room.id) + '/results?' + new URLSearchParams({ task: taskId, revision: String(revision) }))); }
      catch (error) { if (dialog.open) status.textContent = messageOf(error); }
      finally { busy = false; }
    };
    cards.onchange = event => {
      const input = event.target as HTMLInputElement;
      if (input.dataset.resultSelect) selected.set(input.dataset.resultSelect, input.checked);
      copy.disabled = !selectedEntries().length;
    };
    dialog.oncancel = null;
    dialog.onclick = async event => {
      const target = event.target as Element;
      if (target.closest('[data-workflow-close]')) { dialog.close(); return; }
      const anchor = target.closest<HTMLAnchorElement>('a[href^="#"]');
      if (anchor && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        event.preventDefault(); dialog.close(); this.navigate(anchor.hash); return;
      }
      const action = target.closest('button');
      if (!action) return;
      const entry = data?.entries.find(item => item.id === (action.dataset.resultAdopt || action.dataset.resultRevise));
      if (entry?.message && action.dataset.resultRevise) { dialog.close(); revise(entry); return; }
      if (entry?.message && action.dataset.resultAdopt && !busy) {
        busy = action.disabled = true;
        try { paint(await request<GroupResults>(api(room.id) + '/results', submit({ taskId, revision, messageId: entry.message.id, adopted: !entry.adopted }, 'PUT'))); }
        catch (error) { status.textContent = messageOf(error); }
        finally { busy = action.disabled = false; }
      } else if (action === copy) {
        const full = (hash: string) => new URL(hash, location.href).href;
        const text = selectedEntries().map(item => {
          const message = item.message!;
          const links = [`[${t('查看群发言')}](${full(sourceLink(room.id, message.id))})`];
          if (message.native) links.push(`[${t('查看原会话')}](${full(nativeLink(message.native))})`);
          return `## ${labelOf(item)}\n\n${message.text}\n\n${links.join(' · ')}`;
        }).join('\n\n');
        try { await navigator.clipboard.writeText(text); status.textContent = t('已复制'); }
        catch {
          const field = dialog.querySelector<HTMLTextAreaElement>('[data-result-export]')!;
          field.hidden = false; field.value = text; field.select();
        }
      }
    };
    hydrateIcons(dialog);
    dialog.showModal();
    void load();
    this.timer = setInterval(() => { if (!document.hidden) void load(); }, 3000);
  }
}
