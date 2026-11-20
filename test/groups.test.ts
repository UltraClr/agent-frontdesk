import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { CreateInput, Engine, History } from '../src/shared/contract.js';
import type { GroupTask, GroupView } from '../src/shared/groups.js';
import { loadConfig } from '../src/server/config.js';
import { EventHub } from '../src/server/core/event-hub.js';
import { PluginHost } from '../src/server/core/plugin-host.js';
import { RunService } from '../src/server/core/run-service.js';
import { createApp } from '../src/server/server.js';
import { Groups } from '../src/server/services/groups.js';
import { EngineEvents, UnifiedSession, UnifiedTurn } from '../src/server/types.js';
import { must, required } from './support.js';

const turn = (id: string, prompt: string, reply: string) => new UnifiedTurn({
  id, userPrompt: prompt, assistantReply: reply, status: 'completed', statusEvidence: 'native', completedAt: Date.now(),
});

function setup(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-groups-'));
  const file = path.join(directory, 'groups.sqlite'), host = new PluginHost();
  let runs = new RunService(host, new EventHub());
  const histories = new Map<string, History>(), reads: string[] = [], catalogs: string[] = [];
  const sent: Array<{ target: string; prompt: string; emitter: EngineEvents }> = [];
  const reports: string[] = [], created: Array<{ engine: string; input: CreateInput }> = [];
  let groups: Groups;
  let count = 0;
  function install(id: string, controller = false) {
    const read = (target: string) => { reads.push(id + ':' + target); return must(histories.get(id + ':' + target)); };
    const catalog = (cwd?: string) => {
      catalogs.push(id);
      return [...histories.values()].flatMap(({ session }) => session?.engine === id && (!cwd || session.cwd === cwd)
        ? [{ id: session.id, title: session.title, cwd: session.cwd, updatedAt: session.updatedAt }] : []);
    };
    const engine: Engine = {
      ...required, id, label: id, capabilities: { send: true, createRequiresPrompt: controller },
      list: () => [...histories.values()].flatMap(({ session }) => session?.engine === id ? [session] : []),
      read,
      coordinator: {
        root: controller ? path.join(directory, id) : undefined,
        groupMember: controller ? id === 'codex' ? {} : { root: path.join(directory, id) } : { root: path.join(directory, id), catalog },
        catalog,
        read,
      },
      create(input) {
        created.push({ engine: id, input });
        const sessionId = 'new' + (++count);
        const session = new UnifiedSession({ engine: id, id: sessionId, title: input.title, cwd: input.cwd, status: 'idle', metadata: { model: input.model } });
        histories.set(id + ':' + sessionId, { session, turns: input.prompt ? [turn('init', input.prompt, 'READY')] : [] });
        return { id: sessionId };
      },
      send(target, input) {
        const emitter = new EngineEvents();
        sent.push({ target: id + ':' + target, prompt: input.prompt, emitter });
        return emitter;
      },
    };
    host.register(engine);
    return engine;
  }
  const codex = install('codex', true), agy = install('antigravity', true), dsh = install('dsh');
  for (const id of ['A', 'B', 'C']) {
    const session = new UnifiedSession({ engine: dsh.id, id, title: { A: 'Frontend', B: 'Metrics', C: 'Artifacts' }[id], status: 'idle', cwd: directory });
    histories.set('dsh:' + id, { session, turns: [] });
  }
  const create = (engine: Engine, key: string) => groups.create(engine, {
    name: 'Experiment', topic: 'ablation', key, members: ['A', 'B', 'C'].map(id => ({ engine: dsh.id, id, alias: id })),
  });
  const reopen = async (restartRuntime = false) => {
    await groups?.dispose();
    if (restartRuntime) {
      runs.dispose();
      runs = new RunService(host, new EventHub());
    }
    return groups = new Groups(file, '', host, runs, async (engine, input) => engine.create(input), (binding, id) => reports.push(String(binding.origin) + id));
  };
  const finish = (index: number, reply: string) => {
    const message = must(sent[index]);
    must(histories.get(message.target)).turns.push(turn('turn' + index, message.prompt, reply));
    message.emitter.emit('completed', {});
  };
  t.after(async () => { await groups?.dispose(); runs.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { get groups() { return groups; }, get runs() { return runs; }, create, reopen, codex, agy, dsh, directory, host, histories, reads, catalogs, sent, reports, created, finish };
}

test('parallel branches survive restart, report partial results and request one summary', async t => {
  const fixture = setup(t);
  let groups = await fixture.reopen();
  const { id } = await fixture.create(fixture.codex, 'parallel');
  await groups.poll();
  groups.send(id, { key: 'task', text: 'Independently review two items, then summarize', allowParallel: true });
  await groups.poll();
  fixture.finish(0, groupAction({ action: 'collect', mode: 'parallel', summarize: true, questions: [
    { member: 'A', text: 'Review the first item' }, { member: 'B', text: 'Review the second item' },
  ] }));
  await groups.poll(); await groups.poll();
  assert.deepEqual(fixture.sent.slice(1).map(item => item.target), ['dsh:A', 'dsh:B']);
  const [a, b] = must(groups.progress(id)).dispatchPlan;
  assert(a && b && 'parallelBatch' in a && a.parallelBatch && 'parallelBatch' in b);
  assert.equal(a.parallelBatch, b.parallelBatch);
  const first = must(fixture.sent[1]);
  const history = must(fixture.histories.get(first.target));
  history.turns.push(new UnifiedTurn({ id: 'approval-turn', userPrompt: first.prompt, status: 'running',
    approvals: [{ id: 'approval', title: 'Review command', detail: '', decisions: ['approve'] }] }));
  fixture.finish(2, 'Second result');
  await groups.poll();
  assert.equal(groups.progress(id)?.state, 'waiting');
  assert.equal(groups.view(id).messages.at(-1)?.text, 'Second result');
  assert.equal(fixture.sent.length, 3);
  groups = await fixture.reopen(true);
  history.turns.splice(0, 1, new UnifiedTurn({ id: 'approval-turn', userPrompt: first.prompt, status: 'failed',
    statusEvidence: 'native', assistantReply: 'First failed' }));
  await groups.poll(); await groups.poll();
  assert.equal(fixture.sent.length, 4);
  assert.match(must(fixture.sent[3]).prompt, /Second result/);
  assert.match(must(fixture.sent[3]).prompt, /First failed/);
  fixture.finish(3, groupAction({ action: 'summary', text: 'Second result only' }));
  await groups.poll(); await groups.poll();
  assert.equal(groups.progress(id)?.state, 'partial');
  assert.equal(fixture.sent.length, 4);
});

test('an unapproved parallel request falls back to sequential collection', async t => {
  const fixture = setup(t), groups = await fixture.reopen();
  const { id } = await fixture.create(fixture.codex, 'serial');
  await groups.poll();
  groups.send(id, { key: 'task', text: 'Follow the two steps in order' });
  await groups.poll();
  fixture.finish(0, groupAction({ action: 'collect', mode: 'parallel', questions: [
    { member: 'A', text: 'First' }, { member: 'B', text: 'Second' },
  ] }));
  await groups.poll(); await groups.poll();
  assert.deepEqual(fixture.sent.slice(1).map(item => item.target), ['dsh:A']);
  fixture.finish(1, 'First result');
  await groups.poll(); await groups.poll();
  assert.equal(fixture.sent[2]?.target, 'dsh:B');
});

test('evidence template previews participants and passes the actual first reply only after completion', async t => {
  const fixture = setup(t);
  let groups = await fixture.reopen();
  const { id } = await fixture.create(fixture.codex, 'evidence-template');
  await groups.poll();
  const participants = groups.view(id).members.map(item => item.enrollmentId!);
  const input = { template: 'evidence', language: 'en', members: participants.slice(0, 2), roles: ['Gather case studies', 'Check each footnote'],
    material: 'Review the draft', criteria: 'Cite the primary source', sources: [], summarize: true };
  const preview = groups.previewTemplate(id, input);
  assert.equal(fixture.sent.length, 0);
  assert.deepEqual(preview.steps.map(step => [step.member, step.followsPrevious]), [['A', false], ['B', true]]);
  const confirm = { ...input, version: preview.version, key: 'confirm-evidence' };
  const task = must(groups.startTemplate(id, confirm).task);
  assert.equal(groups.view(id).messages.at(-1)?.template, 'evidence');
  groups.startTemplate(id, confirm);
  await groups.poll();
  assert.deepEqual(fixture.sent.map(item => item.target), ['dsh:A']);
  assert(must(fixture.sent[0]).prompt.includes(must(preview.steps[0]).prompt));
  assert.equal(groups.results(id, task.id, task.revision).entries[1]?.pending, 'planned');
  groups = await fixture.reopen(true);
  fixture.finish(0, 'PRIMARY: controlled experiment, Appendix 3');
  await groups.poll(); await groups.poll();
  assert.deepEqual(fixture.sent.map(item => item.target), ['dsh:A', 'dsh:B']);
  const reviewerPrompt = must(fixture.sent[1]).prompt;
  assert(reviewerPrompt.includes(must(preview.steps[1]).prompt));
  assert.match(reviewerPrompt, /PRIMARY: controlled experiment, Appendix 3/);
  fixture.finish(1, 'The appendix verifies just one of the claims.');
  await groups.poll(); await groups.poll();
  assert.equal(fixture.sent.length, 3);
  const summaryPrompt = must(fixture.sent[2]).prompt;
  assert.match(summaryPrompt, /Review the draft/);
  assert.match(summaryPrompt, /Appendix 3/);
  assert.match(summaryPrompt, /verifies just one/);
  fixture.finish(2, groupAction({ action: 'summary', text: 'One claim was verified.' }));
  await groups.poll();
  const first = must(groups.results(id, task.id, task.revision).entries[0]);
  const message = must(first.message);
  assert.equal(first.adopted, false);
  groups.adoptResult(id, { taskId: task.id, revision: task.revision, messageId: message.id, adopted: true });
  groups = await fixture.reopen();
  assert.equal(groups.results(id, task.id, task.revision).entries[0]?.adopted, true);
  assert.equal(groups.messageContext(id, message.id).messages.some(item => item.id === message.id), true);
  const other = await fixture.create(fixture.codex, 'other-results');
  assert.throws(() => groups.messageContext(other.id, message.id), /群发言不存在/);
  const stalePreview = groups.previewTemplate(id, input);
  await groups.changeMembers(id, { remove: [{ engine: 'dsh', id: 'B' }], add: [{ engine: 'dsh', id: 'B', alias: 'B' }] });
  assert.throws(() => groups.startTemplate(id, { ...input, key: 'stale', version: stalePreview.version }), /请选择两位不同/);
  for (let index = 0; index < 70; index++) groups.send(id, { key: 'later-' + index, member: 'A', text: 'Later discussion ' + index });
  assert.equal(groups.view(id).messages.some(item => item.id === message.id), false);
  const context = groups.messageContext(id, message.id);
  assert(context.messages.length <= 30);
  assert(context.messages.some(item => item.id === message.id));
  assert(!context.messages.some(item => item.text === 'Later discussion 69'));
});

test('two proposals show the result that arrives first and keep failures unaccepted', async t => {
  const fixture = setup(t), groups = await fixture.reopen();
  const { id } = await fixture.create(fixture.codex, 'proposal-template');
  await groups.poll();
  const input = { template: 'proposals', members: groups.view(id).members.slice(0, 2).map(item => item.enrollmentId),
    material: 'Same brief', criteria: 'Provide an independent hook', roles: ['Comedy', 'Fantasy'] };
  const preview = groups.previewTemplate(id, input);
  const task = must(groups.startTemplate(id, { ...input, key: 'publish-proposals', version: preview.version }).task);
  await groups.poll();
  assert.deepEqual(fixture.sent.map(item => item.target), ['dsh:A', 'dsh:B']);
  fixture.finish(1, 'Fantasy result');
  await groups.poll();
  assert.equal(groups.results(id, task.id, task.revision).entries[0]?.message?.text, 'Fantasy result');
  const branch = must(fixture.sent[0]);
  must(fixture.histories.get(branch.target)).turns.push(new UnifiedTurn({ id: 'failed', userPrompt: branch.prompt, status: 'failed', statusEvidence: 'native' }));
  await groups.poll();
  const entries = groups.results(id, task.id, task.revision).entries;
  assert.equal(entries[1]?.delivery?.outcome, 'failed');
  assert.throws(() => groups.adoptResult(id, { taskId: task.id, revision: task.revision, messageId: entries[1]?.message?.id, adopted: true }), /只能采纳/);
  assert.equal(groups.progress(id)?.state, 'partial');
});

test('a quoted member revision returns to the same task result card and can be adopted', async t => {
  const fixture = setup(t);
  let groups = await fixture.reopen();
  const { id } = await fixture.create(fixture.codex, 'result-revision');
  await groups.poll();
  const input = { template: 'proposals', members: groups.view(id).members.slice(0, 2).map(item => item.enrollmentId),
    material: 'One brief', criteria: 'Two independent proposals' };
  const preview = groups.previewTemplate(id, input);
  const task = must(groups.startTemplate(id, { ...input, version: preview.version, key: 'proposals' }).task);
  await groups.poll(); await groups.poll();
  fixture.finish(0, 'Original proposal A');
  fixture.finish(1, 'Original proposal B');
  await groups.poll();
  const original = must(groups.results(id, task.id, task.revision).entries[0]?.message);
  groups.send(id, { key: 'revise', member: original.author, replyTo: original.id, text: 'Add the cost estimate' });
  await groups.poll(); await groups.poll();
  assert.match(must(fixture.sent[2]).prompt, /Original proposal A/);
  fixture.finish(2, 'Revised proposal including cost estimate');
  await groups.poll();
  const revised = must(groups.results(id, task.id, task.revision).entries.find(item => item.message?.text.includes('including cost estimate'))?.message);
  assert.equal(revised.taskId, task.id);
  assert.equal(revised.taskRevision, task.revision);
  groups.adoptResult(id, { taskId: task.id, revision: task.revision, messageId: revised.id, adopted: true });
  groups = await fixture.reopen();
  const card = groups.results(id, task.id, task.revision);
  assert.equal(card.entries.find(item => item.message?.id === revised.id)?.adopted, true);
  assert.equal(card.entries.find(item => item.message?.id === original.id)?.adopted, false);
  assert.equal(card.entries.length, 3);
});

test('the inbox shows preflight blocks and confirmed native turns with unconfirmed outcomes', async t => {
  const fixture = setup(t);
  let groups = await fixture.reopen();
  const { id } = await fixture.create(fixture.codex, 'delivery-inbox');
  await groups.poll();
  fixture.dsh.blocked = target => target === 'B' ? 'Test quota exhausted' : undefined;
  groups.send(id, { key: 'quota', text: 'Check quota block', member: 'B' });
  groups.send(id, { key: 'receipt', text: 'Check native outcome', member: 'A' });
  await groups.poll(); await groups.poll();
  const blocked = must(groups.view(id).deliveries.find(item => item.target === 'B'));
  const running = must(groups.view(id).deliveries.find(item => item.target === 'A'));
  assert.equal(blocked.state, 'queued');
  assert.deepEqual(groups.inbox().flatMap(item => item.kind === 'delivery' ? [[item.operationId, item.title]] : []),
    [[blocked.id, 'Test quota exhausted']]);
  const sent = must(fixture.sent[0]), history = must(fixture.histories.get(sent.target));
  history.turns.push(new UnifiedTurn({ id: 'pending-native', status: 'unknown', userPrompt: sent.prompt }));
  await groups.poll();
  groups = await fixture.reopen(true);
  await groups.poll();
  const found = groups.inbox().find(item => item.kind === 'delivery' && item.operationId === running.id);
  assert.equal(found?.title, '正在确认原生轮次结果');
  assert.equal(found?.turnId, 'pending-native');
  fixture.dsh.blocked = () => undefined;
  history.turns[0] = turn('pending-native', sent.prompt, 'Native record confirmed');
  await groups.poll(); await groups.poll();
  assert.equal(groups.inbox().length, 0);
  assert.deepEqual(fixture.sent.map(item => item.target), ['dsh:A', 'dsh:B']);
});

test('mixed agents can join as fresh or existing members and only a recipient gets a native chat', async t => {
  const fixture = setup(t);
  let groups = await fixture.reopen();
  const { id } = await groups.create(fixture.codex, { key: 'mixed', name: 'Review', members: [
    { engine: 'codex', newSession: true, alias: 'Fresh Codex' },
    { engine: 'antigravity', newSession: true, alias: 'Fresh AG' },
    { engine: 'dsh', newSession: true, alias: 'Fresh DSH' },
    { engine: 'dsh', id: 'B', alias: 'Existing DSH' },
  ] });
  await groups.poll();
  assert.deepEqual(fixture.created.map(item => item.engine), ['codex']);
  assert.equal(fixture.sent.length, 0);
  const [coder, analyst, worker] = groups.view(id).members;
  assert.equal(coder?.sessionId, undefined);
  assert.equal(analyst?.sessionId, undefined);
  groups.send(id, { key: 'ask', member: JSON.stringify(['codex', coder?.id]), text: 'Review this' });
  await groups.poll(); await groups.poll();
  const bound = must(groups.view(id).members[0]?.sessionId);
  const hostId = must(groups.view(id).sessionId);
  assert.notEqual(bound, hostId);
  assert.equal(fixture.created[0]?.input.title, '「群聊」Review');
  assert.equal(fixture.created[1]?.input.title, '「Review」Fresh Codex');
  assert.equal(groups.view(id).members[1]?.sessionId, undefined);
  assert.equal(fixture.sent.length, 0, 'the first prompt already went through native creation');
  assert.match(must(fixture.created[1]?.input.prompt), /Review this/);
  assert.equal(groups.view(id).messages.at(-1)?.native?.id, bound);
  groups = await fixture.reopen();
  const reads = fixture.reads.length;
  assert.deepEqual(groups.sessionRoles('codex').get(hostId), { kind: 'group-host', group: 'Review' });
  assert.deepEqual(groups.sessionRoles('codex').get(bound), { kind: 'group-member', group: 'Review', nativeTitlePrefix: '「Review」' });
  assert.equal(groups.sessionRoles('dsh').has('B'), false);
  assert.equal(fixture.reads.length, reads, 'loading roles does not read any native conversations');
  groups.rename(id, { name: 'Revised review' });
  assert.deepEqual(groups.sessionRoles('codex', bound).get(bound), { kind: 'group-member', group: 'Revised review', nativeTitlePrefix: '「Review」' });
  groups.send(id, { key: 'follow', member: JSON.stringify(['codex', coder?.id]), text: 'Follow up' });
  await groups.poll();
  assert.equal(fixture.sent[0]?.target, 'codex:' + bound);
  fixture.finish(0, 'Follow-up result');
  await groups.poll();
  assert.equal(groups.view(id).messages.at(-1)?.author, 'Fresh Codex');
  assert.equal((await groups.members('', 'Review')).some(item => item.id === bound), false);

  groups.send(id, { key: 'first-dsh', member: JSON.stringify(['dsh', worker?.id]), text: 'Summarize' });
  groups.send(id, { key: 'second-dsh', member: JSON.stringify(['dsh', worker?.id]), text: 'Check' });
  await groups.poll(); await groups.poll();
  assert.equal(fixture.created[2]?.engine, 'dsh');
  assert.equal(fixture.created[2]?.input.prompt, undefined, 'the desktop creates a blank chat before sending');
  const dshId = must(groups.view(id).members[2]?.sessionId);
  assert.equal(fixture.sent[1]?.target, 'dsh:' + dshId);
  assert.match(must(fixture.sent[1]?.prompt), /Summarize/);
  assert.equal(fixture.sent.length, 2);
  fixture.finish(1, 'Summarized');
  await groups.poll();
  assert.match(must(fixture.sent[2]?.prompt), /Check/);
});

test('verified new group chats get native titles even when creation ignored the supplied title', async t => {
  const fixture = setup(t);
  let groups = await fixture.reopen();
  const create = fixture.codex.create;
  fixture.codex.create = input => create({ ...input, title: 'Desktop-generated title' });
  const names: Array<{ sessionId: string; title: string }> = [];
  must(fixture.codex.coordinator).nameNewSession = (sessionId, title) => {
    names.push({ sessionId, title });
    must(must(fixture.histories.get('codex:' + sessionId)).session).title = title;
  };
  const { id } = await groups.create(fixture.codex, { key: 'native-names', name: 'Review', members: [
    { engine: 'codex', newSession: true, alias: 'Reviewer' },
  ] });
  await groups.poll();
  const hostId = must(groups.view(id).sessionId);
  assert.deepEqual(names, [{ sessionId: hostId, title: '「群聊」Review' }]);

  // Recovery must use the same naming path when desktop creation ran but the response was lost.
  const createUnnamed = fixture.codex.create;
  fixture.codex.create = async input => { await createUnnamed(input); throw new Error('Desktop creation response lost'); };
  groups.send(id, { key: 'question', member: 'Reviewer', text: 'Review this' });
  await groups.poll();
  groups = await fixture.reopen();
  await groups.poll(); await groups.poll();
  const memberId = must(groups.view(id).members[0]?.sessionId);
  assert.deepEqual(names, [
    { sessionId: hostId, title: '「群聊」Review' },
    { sessionId: memberId, title: '「Review」Reviewer' },
  ]);
  await groups.poll();
  assert.equal(names.length, 2);
  assert.equal(fixture.created.length, 2);
});

test('a lost native creation response recovers the original dedicated chat without creating again', async t => {
  const fixture = setup(t);
  let groups = await fixture.reopen();
  const { id } = await groups.create(fixture.codex, { key: 'recover-member', name: 'Review', members: [
    { engine: 'antigravity', newSession: true, alias: 'AG' },
  ] });
  await groups.poll();
  const create = fixture.agy.create;
  fixture.agy.create = async input => { await create(input); throw new Error('Response lost after the desktop received the question'); };
  groups.send(id, { key: 'one', member: 'AG', text: 'Verify the result' });
  await groups.poll();
  const delivery = must(groups.view(id).deliveries[0]);
  assert.equal(delivery.creatingMember, true);
  assert.equal(delivery.state, 'sent');
  assert.throws(() => groups.retryDelivery(id, delivery.id), /无法重试/);
  groups = await fixture.reopen();
  await groups.poll(); await groups.poll();
  assert.ok(groups.view(id).members[0]?.sessionId);
  assert.equal(groups.view(id).deliveries.length, 0);
  assert.equal(fixture.created.filter(item => item.engine === 'antigravity').length, 1);
  assert.equal(fixture.sent.length, 0);
});

test('dedicated group members inherit a project, apply explicit overrides, and preserve existing chats', async t => {
  const fixture = setup(t);
  let groups = await fixture.reopen();
  const workspace = path.join(fixture.directory, 'shared-project');
  fs.mkdirSync(workspace);
  fixture.codex.models = () => [{ id: 'codex-model', name: 'Codex Model' }];
  fixture.codex.projects = () => [{ id: 'project', name: 'Shared project', cwd: workspace }];
  const { id } = await groups.create(fixture.codex, { key: 'setup', name: 'Setup', workspace, members: [
    { engine: 'codex', newSession: true, alias: 'Reviewer', setup: { model: 'codex-model' } },
    { engine: 'antigravity', newSession: true, alias: 'Discussion', setup: { workspace: null } },
    { engine: 'dsh', id: 'B', alias: 'Existing' },
  ] });
  await groups.poll();
  assert.equal(fixture.created.length, 1);
  assert.notEqual(fixture.created[0]?.input.cwd, workspace, 'the host stays in its own project');
  groups = await fixture.reopen();
  assert.equal(groups.view(id).workspace, workspace);
  assert.deepEqual((await groups.memberOptions(fixture.codex)).projects, [{ name: 'Shared project', cwd: workspace }]);
  groups.send(id, { key: 'one', member: 'Reviewer', text: 'Review the project' });
  await groups.poll(); await groups.poll();
  assert.equal(fixture.created[1]?.input.cwd, workspace);
  assert.equal(fixture.created[1]?.input.model, 'codex-model');
  const reviewer = must(groups.view(id).members[0]);
  assert.deepEqual(reviewer.nativeSettings, { cwd: workspace, model: 'codex-model' });
  await assert.rejects(groups.configureMember(id, reviewer.id, {}), /无法修改/);
  groups.send(id, { key: 'two', member: 'Discussion', text: 'Discuss independently' });
  await groups.poll(); await groups.poll();
  assert.match(must(fixture.created[2]?.input.cwd), /group-members/);
  groups.send(id, { key: 'three', member: 'Existing', text: 'Use the original chat' });
  await groups.poll();
  assert.equal(fixture.sent[0]?.target, 'dsh:B');
  assert.equal(fixture.created.length, 3);
});

test('a selected native conversation can host directly without a setup turn or duplicate member', async t => {
  const fixture = setup(t);
  const groups = await fixture.reopen();
  const room = await groups.create(fixture.dsh, { key: 'existing-host', name: 'Existing host', hostSession: 'B', members: [
    { engine: 'dsh', id: 'B', alias: 'Promoted' },
    { engine: 'dsh', id: 'A', alias: 'Peer' },
  ] });
  assert.equal(room.state, 'ready');
  assert.equal(room.sessionId, 'B');
  assert.equal(room.hostTitle, 'Metrics');
  assert.deepEqual(room.members.map(member => member.alias), ['Peer']);
  await groups.poll();
  assert.equal(fixture.created.length, 0);
  assert.equal(fixture.sent.length, 0);
  await assert.rejects(groups.create(fixture.dsh, { key: 'again', name: 'Other group', hostSession: 'B', members: [{ engine: 'dsh', id: 'C' }] }), /其他群/);
  assert.equal((await groups.members('dsh', 'Metrics')).length, 0);
  groups.send(room.id, { key: 'discussion', text: 'Give your own summary first' });
  await groups.poll();
  assert.equal(fixture.sent[0]?.target, 'dsh:B');
  assert.match(must(fixture.sent[0]?.prompt), /Existing host/);
  fixture.finish(0, 'Here is the summary');
  await groups.poll();
  assert.equal(groups.view(room.id).messages[1]?.author, 'host');
});

test('a group can start with just a host, then add existing or dedicated members and persist the roster', async t => {
  const fixture = setup(t);
  let groups = await fixture.reopen();
  const { id } = await groups.create(fixture.codex, { key: 'empty-roster', name: 'Editable' });
  await groups.poll();
  assert.equal(groups.view(id).state, 'ready');
  assert.deepEqual(groups.view(id).members, []);
  const added = await groups.changeMembers(id, { add: [
    { engine: 'dsh', id: 'B', alias: 'Reviewer' }, { engine: 'codex', newSession: true, alias: 'Assistant' },
  ] });
  assert.deepEqual(added.members.map(member => member.alias), ['Reviewer', 'Assistant']);
  assert.equal(fixture.created.length, 1);
  assert.equal(fixture.sent.length, 0);
  await assert.rejects(groups.changeMembers(id, { add: [{ engine: 'dsh', id: 'A', alias: 'Reviewer' }] }), /别名/);
  groups = await fixture.reopen();
  assert.deepEqual(groups.view(id).members.map(member => member.alias), ['Reviewer', 'Assistant']);
  assert.deepEqual((await groups.changeMembers(id, { remove: added.members })).members, []);
  assert.equal(groups.view(id).state, 'ready');
});

test('removing a member withdraws unsent work and preserves the original approval and receipt', async t => {
  const fixture = setup(t);
  const groups = await fixture.reopen();
  const { id } = await fixture.create(fixture.codex, 'remove-member');
  await groups.poll();
  groups.send(id, { key: 'complete', member: 'B', text: 'Earlier request' });
  await groups.poll();
  fixture.finish(0, 'Earlier reply');
  await groups.poll();
  groups.send(id, { key: 'running', member: 'B', text: 'Already sent' });
  await groups.poll();
  const running = new UnifiedTurn({ id: 'turn1', userPrompt: must(fixture.sent[1]).prompt, status: 'running',
    approvals: [{ id: 'approval', title: 'Approve this action', detail: '', decisions: ['Allow'] }] });
  must(fixture.histories.get('dsh:B')).turns.push(running);
  groups.send(id, { key: 'queued', member: 'B', text: 'Still queued' });
  await groups.poll();
  assert.equal(groups.view(id).pending, 2);
  const updated = await groups.changeMembers(id, {
    remove: [{ engine: 'dsh', id: 'B' }], add: [{ engine: 'codex', newSession: true, alias: 'B' }],
  });
  assert.equal(updated.pending, 1);
  assert.equal(updated.members.find(member => member.alias === 'B')?.engine, 'codex');
  assert.ok(updated.messages.some(message => message.kind === 'notice' && message.text.includes('撤销待投递')));
  const delivery = must(updated.deliveries[0]);
  assert.equal(delivery.removedMember, 'B');
  assert.equal(delivery.target, 'B');
  assert.equal(delivery.nativeTurn, 'turn1');
  assert.equal(delivery.attention?.id, 'approval');
  assert.equal(fixture.runs.get('dsh', 'B')?.run.status, 'running');
  await fixture.reopen();
  const restored = fixture.groups;
  await restored.poll();
  assert.equal(restored.view(id).deliveries[0]?.attention?.id, 'approval');
  must(fixture.histories.get('dsh:B')).turns.pop();
  fixture.finish(1, 'Late reply in the original chat');
  await restored.poll();
  assert.equal(fixture.sent.length, 2);
  assert.equal(restored.view(id).pending, 0);
  assert.ok(restored.view(id).messages.some(message => message.text === 'Earlier reply'));
  assert.ok(!restored.view(id).messages.some(message => message.text === 'Late reply in the original chat'));
  const receipt = restored.view(id).messages.at(-1);
  assert.equal(receipt?.kind, 'notice');
  assert.match(receipt?.text || '', /原会话完成/);
  assert.deepEqual(receipt?.native, { engine: 'dsh', id: 'B', turn: 'turn1' });
  assert.ok(must(fixture.histories.get('dsh:B')).turns.some(item => item.assistantReply === 'Late reply in the original chat'));
  assert.throws(() => restored.send(id, { key: 'gone', member: JSON.stringify(['dsh', 'B']), text: 'Do not retarget' }), /群内成员/);
});

const groupAction = (value: object) => '\x60\x60\x60frontdesk\n' + JSON.stringify(value) + '\n\x60\x60\x60';

test('reading task progress leaves the original flow intact through an approval and restart', async t => {
  const fixture = setup(t);
  let groups = await fixture.reopen();
  const { id } = await fixture.create(fixture.codex, 'read-only-progress');
  const poll = async () => { await groups.poll(); await groups.poll(); };
  await poll();
  const host = 'codex:' + groups.view(id).sessionId;

  groups.send(id, { key: 'task', text: 'Ask B to check the dataset and summarize' });
  const original = must(groups.progress(id));
  await poll();
  assert.equal(groups.progress(id)?.state, 'confirming', 'sending alone does not prove a native turn started');
  const hostHistory = must(fixture.histories.get(host)).turns;
  hostHistory.push(new UnifiedTurn({ id: 'turn0', userPrompt: must(fixture.sent[0]).prompt, status: 'running' }));
  await poll();
  assert.equal(groups.progress(id)?.state, 'running');
  hostHistory.pop();
  fixture.finish(0, groupAction({ action: 'ask', member: 'B', text: 'Check dataset' }));
  await poll();
  const memberHistory = must(fixture.histories.get('dsh:B')).turns;
  memberHistory.push(new UnifiedTurn({ id: 'turn1', userPrompt: must(fixture.sent[1]).prompt, status: 'running',
    approvals: [{ id: 'check-files', title: 'Approve access', detail: '', kind: 'plan', decisions: ['desktop'] }] }));
  await poll();

  fixture.reads.length = fixture.catalogs.length = 0;
  const progress = must(groups.progress(id));
  assert.equal(progress.id, original.id);
  assert.equal(progress.revision, original.revision);
  const memberWork = must(progress.deliveries.find(delivery => delivery.target === 'B'));
  assert.equal(memberWork.state, 'waiting');
  assert.equal(memberWork.nativeTurn, 'turn1');
  assert.equal(memberWork.attention?.id, 'check-files');
  assert.deepEqual(groups.progress(id), progress);
  assert.deepEqual(fixture.reads, [], 'viewing progress must not read or wake a native session');
  assert.deepEqual(fixture.catalogs, []);
  assert.throws(() => groups.send(id, { key: 'ordinary', text: 'What is the status?' }), { status: 409 });
  assert.equal(groups.progress(id)?.id, original.id);

  groups = await fixture.reopen(true);
  await poll();
  assert.equal(groups.progress(id)?.id, original.id);
  assert.equal(groups.progress(id)?.deliveries.find(delivery => delivery.target === 'B')?.attention?.id, 'check-files');
  assert.deepEqual(fixture.sent.map(message => message.target), [host, 'dsh:B']);
  memberHistory.pop();
  fixture.finish(1, 'Checked dataset');
  await poll();
  fixture.finish(2, groupAction({ action: 'summary', text: 'Dataset checked' }));
  await poll();
  assert.deepEqual(fixture.sent.map(message => message.target), [host, 'dsh:B', host]);
  assert.deepEqual(groups.decisions(id).map(message => message.text), ['Dataset checked']);
  assert.equal(groups.decisions(id)[0]?.taskId, original.id);
  assert.equal(groups.view(id).pending, 0);
});

test('supplementing a task preserves late native receipts without advancing the old plan', async t => {
  const fixture = setup(t), groups = await fixture.reopen();
  const { id } = await fixture.create(fixture.codex, 'supplement');
  const poll = async () => { await groups.poll(); await groups.poll(); };
  await poll();
  const host = 'codex:' + groups.view(id).sessionId;

  groups.send(id, { key: 'task', text: 'Check the old requirements' });
  const original = must(groups.progress(id));
  await poll();
  fixture.finish(0, groupAction({ action: 'collect', questions: [
    { member: 'B', text: 'Check the old assumptions' }, { member: 'C', text: 'Check the old constraints' },
  ], summarize: true }));
  await poll();
  assert.deepEqual(fixture.sent.map(message => message.target), [host, 'dsh:B']);

  assert.throws(() => groups.send(id, { key: 'missing-version', text: 'Amend', taskAction: 'supplement', taskId: original.id }));
  const supplement = { key: 'amend', text: 'Use the amended requirements', taskAction: 'supplement',
    taskId: original.id, taskRevision: original.revision };
  groups.send(id, supplement);
  groups.send(id, supplement);
  const revised = must(groups.progress(id));
  assert.equal(revised.id, original.id);
  assert.ok(revised.revision > original.revision);
  assert.throws(() => groups.send(id, { ...supplement, key: 'stale-change' }), { status: 409 });
  assert.throws(() => groups.cancel(id, { taskId: original.id, taskRevision: original.revision }), { status: 409 });
  await poll();
  assert.deepEqual(fixture.sent.map(message => message.target), [host, 'dsh:B', host]);
  assert.match(must(fixture.sent[2]).prompt, /Use the amended requirements/);
  assert.match(must(fixture.sent[2]).prompt, /"remaining":2/, 'the already submitted member still counts toward the task limit');

  fixture.finish(1, 'OLD_REVISION_RESULT');
  await poll();
  const late = must(groups.view(id).messages.find(message => message.text === 'OLD_REVISION_RESULT'));
  assert.equal(late.taskId, original.id);
  assert.equal(late.taskRevision, original.revision);
  assert.deepEqual(late.native, { engine: 'dsh', id: 'B', turn: 'turn1' });
  assert.deepEqual(fixture.sent.map(message => message.target), [host, 'dsh:B', host], 'old receipt must not dispatch the next member');
  fixture.finish(2, groupAction({ action: 'read', member: 'B', text: 'No replies for the amended requirements yet' }));
  await poll();
  assert.equal(fixture.sent.length, 3, 'default reads must not pull the superseded revision into the new request');
});

test('supplementing before the first native turn keeps the original and new requirements', async t => {
  const fixture = setup(t), groups = await fixture.reopen();
  const { id } = await fixture.create(fixture.codex, 'amend-queued');
  const poll = async () => { await groups.poll(); await groups.poll(); };
  await poll();
  const host = 'codex:' + groups.view(id).sessionId;
  const session = must(must(fixture.histories.get(host)).session);
  session.status = 'busy';
  groups.send(id, { key: 'initial', text: 'ORIGINAL_REQUIREMENT' });
  await poll();
  assert.equal(fixture.sent.length, 0);
  const task = must(groups.progress(id));
  groups.send(id, { key: 'supplement', text: 'ADDED_REQUIREMENT', taskAction: 'supplement', taskId: task.id, taskRevision: task.revision });
  await poll();
  assert.equal(fixture.sent.length, 0);

  session.status = 'idle';
  await poll();
  assert.deepEqual(fixture.sent.map(message => message.target), [host]);
  const prompt = must(fixture.sent[0]).prompt;
  assert.equal(prompt.split('ORIGINAL_REQUIREMENT').length, 2);
  assert.equal(prompt.split('ADDED_REQUIREMENT').length, 2);
  assert.match(prompt, /"remaining":3/, 'cancelled unsent work does not consume any delivery budget');
});

test('the default host read only supplies the current task while replies can quote a specific previous result', async t => {
  const fixture = setup(t), groups = await fixture.reopen();
  const { id } = await fixture.create(fixture.codex, 'read-task-scope');
  const poll = async () => { await groups.poll(); await groups.poll(); };
  await poll();
  const host = 'codex:' + groups.view(id).sessionId;

  groups.send(id, { key: 'independent', member: 'B', text: 'Check the earlier draft' });
  await poll();
  fixture.finish(0, 'OUTSIDE_TASK_RESULT');
  await poll();
  groups.send(id, { key: 'quote-available', member: 'B', text: 'Find a source for reference' });
  await poll();
  fixture.finish(1, 'EXPLICIT_REFERENCE');
  await poll();
  const earlier = must(groups.view(id).messages.find(message => message.text === 'EXPLICIT_REFERENCE'));
  groups.send(id, { key: 'current', text: 'Review the new draft', replyTo: earlier.id });
  const current = must(groups.progress(id));
  await poll();
  assert.match(must(fixture.sent[2]).prompt, /EXPLICIT_REFERENCE/, 'an explicit quote can carry a previous result');
  groups.send(id, { key: 'in-task', member: 'B', text: 'Check this specific draft', replyTo: current.id });
  await poll();
  fixture.finish(3, 'CURRENT_TASK_RESULT');
  await poll();
  fixture.finish(2, groupAction({ action: 'read', member: 'B' }));
  await poll();
  assert.deepEqual(fixture.sent.map(message => message.target), ['dsh:B', 'dsh:B', host, 'dsh:B', host]);
  const currentContext = must(fixture.sent[4]).prompt;
  assert.match(currentContext, /CURRENT_TASK_RESULT/);
  assert.doesNotMatch(currentContext, /OUTSIDE_TASK_RESULT|EXPLICIT_REFERENCE/);
  assert.equal(groups.view(id).messages.find(message => message.text === 'CURRENT_TASK_RESULT')?.taskId, current.id);
});

test('stopping follow-up preserves the in-flight native turn without applying its action', async t => {
  for (const replace of [false, true]) await t.test(replace ? 'replace the active task' : 'cancel before starting another task', async t => {
    const fixture = setup(t), groups = await fixture.reopen();
    const { id } = await fixture.create(fixture.codex, 'stop-follow-up');
    const poll = async () => { await groups.poll(); await groups.poll(); };
    await poll();
    const hostId = must(groups.view(id).sessionId);
    groups.send(id, { key: 'old', text: 'Ask A about the old project' });
    const original = must(groups.progress(id));
    await poll();
    const expected = { taskId: original.id, taskRevision: original.revision };
    assert.throws(() => groups.cancel(id, { taskId: original.id }));
    assert.throws(() => groups.send(id, { key: 'missing-version', text: 'Review the new project', taskAction: 'replace', taskId: original.id }));
    if (!replace) {
      groups.cancel(id, expected);
      assert.equal(groups.progress(id)?.state, 'cancelled');
    }
    const request = { key: 'new', text: 'Review the new project' };
    groups.send(id, replace ? { ...request, ...expected, taskAction: 'replace' } : { ...request, taskAction: 'start' });
    assert.equal(fixture.runs.get('codex', hostId)?.run.status, 'running');
    const current = must(groups.progress(id));
    assert.notEqual(current.id, original.id);
    assert.throws(() => groups.cancel(id, expected), { status: 409 });
    await poll();
    assert.equal(fixture.sent.length, 1, 'the next host turn waits for the original native turn');

    fixture.finish(0, groupAction({ action: 'ask', member: 'A', text: 'Late question about the old project' }));
    await poll();
    assert.deepEqual(fixture.sent.map(message => message.target), ['codex:' + hostId, 'codex:' + hostId]);
    assert.match(must(fixture.sent[1]).prompt, /Review the new project/);
    const late = must(groups.view(id).messages.find(message => message.text.includes('Late question about the old project')));
    assert.equal(late.taskId, original.id);
    assert.equal(late.taskRevision, original.revision);
    assert.deepEqual(late.native, { engine: 'codex', id: hostId, turn: 'turn0' });
  });
});

test('after restart, only a proven unsent hosted delivery can be retried', async t => {
  for (const notSent of [false, true]) await t.test(notSent ? 'desktop refused before submission' : 'submission is uncertain', async t => {
    const fixture = setup(t);
    let groups = await fixture.reopen();
    const { id } = await fixture.create(fixture.codex, 'retry-host');
    const poll = async () => { await groups.poll(); await groups.poll(); };
    await poll();
    groups.send(id, { key: 'task', text: 'Review the draft' });
    await poll();
    const first = must(fixture.sent[0]);
    const delivery = must(groups.progress(id)?.deliveries[0]);
    first.emitter.emit('error', Object.assign(new Error('Transport closed'), { notSent }));
    groups = await fixture.reopen(true);
    await poll();
    assert.equal(fixture.sent.length, 1, 'restarting does not retry either case');
    if (notSent) {
      assert.equal(groups.progress(id)?.state, 'blocked');
      assert.equal(groups.progress(id)?.deliveries[0]?.note, 'Transport closed');
      groups.retryDelivery(id, delivery.id);
      await poll();
      assert.equal(fixture.sent.length, 2);
      assert.equal(fixture.sent[1]?.prompt, first.prompt);
    } else {
      assert.equal(groups.progress(id)?.state, 'confirming');
      assert.throws(() => groups.retryDelivery(id, delivery.id), { status: 409 });
      assert.equal(fixture.sent.length, 1);
    }
  });
});

test('task progress shows undispatched steps and replaces them with their actual receipts', async t => {
  for (const finish of ['completed', 'interrupted', 'cancelled'] as const) await t.test(finish, async t => {
    const fixture = setup(t);
    let groups = await fixture.reopen();
    const { id } = await groups.create(fixture.codex, { key: 'visible-plan', name: 'Review', members: [
      { engine: 'dsh', id: 'B', alias: 'First' },
      { engine: 'antigravity', newSession: true, alias: 'Second' },
    ] });
    await groups.poll();
    groups.send(id, { key: 'plan', text: 'Ask First, then Second.' });
    await groups.poll();
    fixture.finish(0, groupAction({ action: 'collect', questions: [
      { member: 'First', text: 'First check' }, { member: 'Second', text: 'Second check' },
    ] }));
    await groups.poll(); await groups.poll();
    const initial = must(groups.progress(id));
    const first = must(initial.deliveries.find(item => item.kind === 'member'));
    assert.deepEqual(initial.dispatchPlan, [
      { member: 'First', deliveryId: first.id },
      { member: 'Second', engine: 'antigravity', creatingMember: true, state: 'planned' },
    ]);
    assert.equal(initial.deliveries.filter(item => item.engine === 'antigravity').length, 0);
    groups = await fixture.reopen(true);
    assert.deepEqual(groups.progress(id)?.dispatchPlan, initial.dispatchPlan);

    if (finish === 'cancelled') {
      groups.cancel(id, { taskId: initial.id, taskRevision: initial.revision });
    } else if (finish === 'completed') {
      fixture.finish(1, 'First result');
    } else {
      const message = must(fixture.sent[1]);
      must(fixture.histories.get(message.target)).turns.push(new UnifiedTurn({
        id: 'turn1', userPrompt: message.prompt, status: 'interrupted', statusEvidence: 'native',
      }));
    }
    await groups.poll(); await groups.poll();
    const updated = must(groups.progress(id));
    if (finish === 'completed') {
      const second = must(updated.deliveries.find(item => item.engine === 'antigravity'));
      assert.deepEqual(updated.dispatchPlan, [
        { member: 'First', deliveryId: first.id }, { member: 'Second', deliveryId: second.id },
      ]);
    } else {
      assert.deepEqual(updated.dispatchPlan[1], {
        member: 'Second', engine: 'antigravity', creatingMember: true,
        state: finish === 'cancelled' ? 'cancelled' : 'previous-failed',
      });
      assert.equal(updated.deliveries.some(item => item.engine === 'antigravity'), false);
    }
  });
});

test('removing an unrelated member preserves the assigned discussion and an in-flight decision', async t => {
  const fixture = setup(t);
  const groups = await fixture.reopen();
  const { id } = await fixture.create(fixture.codex, 'unrelated');
  await groups.poll();
  const host = 'codex:' + groups.view(id).sessionId;
  groups.send(id, { key: 'plan', text: 'Ask A, then ask B and summarize.' });
  await groups.poll();
  fixture.finish(0, groupAction({ action: 'collect', questions: [
    { member: 'A', text: 'First check' }, { member: 'B', text: 'Second check' },
  ], summarize: true }));
  await groups.poll(); await groups.poll();
  await groups.changeMembers(id, { remove: [{ engine: 'dsh', id: 'C' }] });
  fixture.finish(1, 'First result');
  await groups.poll(); await groups.poll();
  fixture.finish(2, 'Second result');
  await groups.poll(); await groups.poll();
  await groups.changeMembers(id, { remove: [{ engine: 'dsh', id: 'A' }] });
  fixture.finish(3, groupAction({ action: 'summary', text: 'Both checks passed' }));
  await groups.poll();
  assert.deepEqual(fixture.sent.map(message => message.target), [host, 'dsh:A', 'dsh:B', host]);
  assert.deepEqual(groups.decisions(id).map(message => message.text), ['Both checks passed']);
});

test('removing a participant invalidates pending parallel work and preserves native results', async t => {
  for (const stage of ['planning', 'running', 'summary queued'] as const) await t.test(stage, async t => {
    const fixture = setup(t);
    let groups = await fixture.reopen();
    const { id } = await fixture.create(fixture.codex, 'parallel-removal');
    await groups.poll();
    groups.send(id, { key: 'task', text: 'Collect two independent proposals and summarize', allowParallel: true });
    await groups.poll();
    const remove = () => groups.changeMembers(id, { remove: [{ engine: 'dsh', id: 'B' }] });
    if (stage === 'planning') await remove();
    fixture.finish(0, groupAction({ action: 'collect', mode: 'parallel', summarize: true,
      questions: [{ member: 'A', text: 'One' }, { member: 'B', text: 'Two' }] }));
    await groups.poll(); await groups.poll();
    if (stage === 'planning') {
      assert.equal(groups.progress(id)?.state, 'paused');
      assert.equal(fixture.sent.length, 1, 'a stale proposal never falls back to a serial dispatch');
      return;
    }
    assert.deepEqual(fixture.sent.slice(1).map(item => item.target), ['dsh:A', 'dsh:B']);
    fixture.finish(2, 'B finishes before removal');
    await groups.poll();
    if (stage === 'summary queued') {
      fixture.codex.blocked = () => 'Host temporarily unavailable';
      fixture.finish(1, 'A finishes before removal');
      await groups.poll(); await groups.poll();
      assert.equal(groups.progress(id)?.deliveries.at(-1)?.state, 'queued');
      assert.equal(groups.progress(id)?.deliveries.at(-1)?.kind, 'host');
    }
    await remove();
    groups = await fixture.reopen(true);
    if (stage === 'running') fixture.finish(1, 'A returns after removal');
    fixture.codex.blocked = () => undefined;
    await groups.poll(); await groups.poll();
    const task = must(groups.progress(id));
    assert.equal(task.state, 'paused');
    assert.equal(fixture.sent.length, 3, 'no automatic summary is sent');
    const results = groups.results(id, task.id, task.revision).entries;
    assert.equal(results.find(item => item.label === 'B')?.message?.text, 'B finishes before removal');
    assert.match(results.find(item => item.label === 'A')?.message?.text || '', /^A (returns|finishes)/);
    assert.equal(groups.view(id).pending, 0);
  });
});

test('a plan pauses at the removed enrollment even when its alias or native chat is reused', async t => {
  for (const rejoin of [false, true]) await t.test(rejoin ? 'same native chat rejoins' : 'a new chat takes the same alias', async t => {
    const fixture = setup(t);
    const groups = await fixture.reopen();
    const { id } = await fixture.create(fixture.codex, 'same-alias');
    await groups.poll();
    groups.send(id, { key: 'plan', text: 'Ask A, then B, then ask C.' });
    await groups.poll();
    const replace = () => groups.changeMembers(id, { remove: [{ engine: 'dsh', id: 'B' }], add: rejoin
      ? [{ engine: 'dsh', id: 'B', alias: 'B' }] : [{ engine: 'codex', newSession: true, alias: 'B' }] });
    if (!rejoin) await replace();
    fixture.finish(0, groupAction({ action: 'collect', questions: [
      { member: 'A', text: 'First check' }, { member: 'B', text: 'Second check' }, { member: 'C', text: 'Third check' },
    ] }));
    await groups.poll(); await groups.poll();
    if (rejoin) await replace();
    fixture.finish(1, 'First result');
    await groups.poll(); await groups.poll();
    assert.equal(fixture.sent.length, 2);
    assert.equal(fixture.created.length, 1);
    assert.equal(groups.view(id).pending, 0);
    assert.match(groups.view(id).messages.at(-1)?.text || '', /后续步骤等待重新安排.*B → C/);
  });
});

test('work submitted through an in-flight dedicated chat creation stays traceable after removal', async t => {
  for (const blank of [false, true]) await t.test(blank ? 'blank chat created before its prompt' : 'created with the first prompt', async t => {
    const fixture = setup(t);
    const groups = await fixture.reopen();
    const engine = blank ? fixture.dsh : fixture.codex;
    const { id } = await groups.create(fixture.codex, { key: 'creation-in-flight', name: 'Room',
      members: [{ engine: engine.id, newSession: true, alias: 'Runner' }] });
    await groups.poll();
    const member = must(groups.view(id).members[0]);
    const create = engine.create;
    let notifyStarted!: () => void, allowCreation!: () => void;
    const started = new Promise<void>(resolve => { notifyStarted = resolve; });
    const allow = new Promise<void>(resolve => { allowCreation = resolve; });
    engine.create = async input => {
      notifyStarted();
      await allow;
      return create(input);
    };
    groups.send(id, { key: 'first', member: 'Runner', text: 'Initial task' });
    await started;
    try {
      const removed = await groups.changeMembers(id, { remove: [member] });
      assert.equal(removed.pending, 1);
      assert.equal(removed.deliveries[0]?.creatingMember, true);
      assert.equal(removed.deliveries[0]?.removedMember, 'Runner');
    } finally {
      allowCreation();
    }
    await groups.poll(); await groups.poll();
    assert.equal(groups.view(id).pending, 0);
    assert.equal(groups.view(id).members.length, 0);
    assert.equal(fixture.sent.length, 0);
    const result = groups.view(id).messages.at(-1);
    assert.equal(result?.kind, 'notice');
    assert.equal(result?.native?.engine, engine.id);
    assert.notEqual(result?.native?.id, member.id);
    assert.match(result?.text || '', blank ? /撤销待投递/ : /原会话完成/);
  });
});

test('a failed host setup can be replaced on the original group without touching the existing chats', async t => {
  const fixture = setup(t);
  let groups = await fixture.reopen();
  fixture.codex.create = () => { throw Object.assign(new Error('Native picker refused before sending'), { notSent: true }); };
  const { id } = await fixture.create(fixture.codex, 'replace-host');
  await groups.poll();
  assert.equal(groups.view(id).state, 'blocked');
  const fixed = await groups.chooseHost(id, fixture.dsh, { hostSession: 'B' });
  assert.equal(fixed.id, id);
  assert.equal(fixed.state, 'ready');
  assert.equal(fixed.sessionId, 'B');
  assert.deepEqual(fixed.members.map(member => member.id), ['A', 'C']);
  assert.equal(fixed.issue, undefined);
  groups = await fixture.reopen();
  assert.equal(groups.view(id).hostTitle, 'Metrics');
  assert.equal(fixture.sent.length, 0);
  await assert.rejects(groups.chooseHost(id, fixture.agy, {}), /无法更换群主/);
});

test('a confirmed pre-send host failure can recover through the native draft', async t => {
  const fixture = setup(t);
  const groups = await fixture.reopen();
  const nativeCreate = fixture.codex.create;
  fixture.codex.create = () => { throw Object.assign(new Error('Native picker refused before sending'), { notSent: true }); };
  fixture.codex.coordinator!.prepare = async (cwd, prompt) => { await nativeCreate({ cwd, prompt }); };
  const { id } = await fixture.create(fixture.codex, 'recover-host');
  await groups.poll();
  assert.equal(groups.view(id).canOpenHostDraft, true);
  await groups.prepare(id);
  await groups.poll();
  assert.equal(groups.view(id).state, 'ready');
  assert.equal(fixture.created.length, 1);
});

test('an unregistered workspace or missing model is surfaced before a new member can receive a turn', async t => {
  const fixture = setup(t);
  const groups = await fixture.reopen();
  const workspace = path.join(fixture.directory, 'real-project');
  fs.mkdirSync(workspace);
  fixture.codex.coordinator!.groupProject = true;
  fixture.codex.projects = () => [{ id: 'host-project', name: 'Hosts', cwd: groups.directory(fixture.codex) }];
  const request = { key: 'validate', name: 'Validate', workspace, members: [
    { engine: 'codex', newSession: true, alias: 'Worker', setup: { model: 'retired' } },
  ] };
  await assert.rejects(groups.create(fixture.codex, request), /登记所选项目/);
  const otherProjects = fixture.codex.projects;
  fixture.codex.projects = async () => [...await otherProjects(), { id: 'real', name: 'Project', cwd: workspace }];
  fixture.codex.models = () => [{ id: 'retired', name: 'Old Model' }];
  const { id } = await groups.create(fixture.codex, request);
  await groups.poll();
  fixture.codex.models = () => [{ id: 'replacement', name: 'Replacement' }];
  groups.send(id, { key: 'one', member: 'Worker', text: 'Keep this exact task' });
  await groups.poll();
  const old = groups.view(id);
  assert.equal(old.deliveries[0]?.state, 'blocked');
  assert.match(must(old.deliveries[0]?.note), /所选模型当前不可用/);
  assert.equal(fixture.created.length, 1);
  const member = must(old.members[0]);
  assert.equal(member.canEditSetup, true);
  await groups.configureMember(id, member.id, { model: 'replacement' });
  groups.retryDelivery(id, must(old.deliveries[0]?.id));
  await groups.poll(); await groups.poll();
  const repaired = groups.view(id);
  assert.equal(fixture.created[1]?.input.model, 'replacement');
  assert.match(must(fixture.created[1]?.input.prompt), /Keep this exact task/);
  assert.equal(repaired.messages.filter(message => message.kind === 'user').length, 1);
});

test('a blank-chat engine applies the selected model before the first prompt in a shared project', async t => {
  const fixture = setup(t);
  const groups = await fixture.reopen();
  const { dsh } = fixture;
  dsh.models = () => [{ id: 'dsh-model', name: 'DSH Model' }];
  let modelPrepared = '';
  dsh.coordinator!.groupMember!.prepareModel = (id, model) => {
    assert.equal(fixture.sent.length, 0);
    const history = must(fixture.histories.get('dsh:' + id));
    assert.equal(history.turns.length, 0);
    assert.equal(history.session?.cwd, fixture.directory);
    must(history.session).metadata.model = model;
    modelPrepared = model;
  };
  const { id } = await groups.create(fixture.codex, { key: 'blank', name: 'Blank', workspace: fixture.directory, members: [
    { engine: 'dsh', newSession: true, alias: 'Worker', setup: { model: 'dsh-model' } },
  ] });
  await groups.poll();
  groups.send(id, { key: 'one', member: 'Worker', text: 'Review only this' });
  await groups.poll(); await groups.poll();
  assert.equal(modelPrepared, 'dsh-model');
  assert.equal(fixture.sent.length, 1);
  assert.notEqual(fixture.sent[0]?.target, 'dsh:B');
  fixture.finish(0, 'Done');
  await groups.poll();
  assert.equal(groups.view(id).members[0]?.nativeSettings?.model, 'dsh-model');
});

test('a refused member creation can retry the original ask after restart', async t => {
  for (const legacy of [false, true]) await t.test(legacy ? 'existing Codex journal' : 'explicit unsent reply', async t => {
    const fixture = setup(t);
    let groups = await fixture.reopen();
    const { id } = await groups.create(fixture.codex, { key: 'new-member', name: 'Review', members: [
      { engine: 'codex', newSession: true, alias: 'Reviewer' },
    ] });
    await groups.poll();
    const create = fixture.codex.create;
    const attempts: CreateInput[] = [];
    fixture.codex.create = input => {
      attempts.push(input);
      if (attempts.length > 1) return create(input);
      if (legacy) throw new Error('Codex 桌面版的页面上有 2 个控件都对得上「newChat」，分不清该动哪一个，所以没有动手（桌面版可能改过界面，这个控件的认法要更新）');
      throw Object.assign(new Error('The desktop refused before sending'), { notSent: true });
    };
    groups.send(id, { key: 'one', member: 'Reviewer', text: 'Review this' });
    await groups.poll();
    const delivery = must(groups.view(id).deliveries[0]);
    assert.equal(delivery.state, 'blocked');
    assert.equal(delivery.creatingMember, true);
    groups = await fixture.reopen();
    await groups.poll();
    assert.equal(attempts.length, 1, 'do not retry a blocked task automatically');
    assert.equal(groups.retryDelivery(id, delivery.id).deliveries[0]?.state, 'queued');
    assert.throws(() => groups.retryDelivery(id, delivery.id), /无法重试/);
    await groups.poll(); await groups.poll();
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]?.nativeCreationMarker, attempts[1]?.nativeCreationMarker);
    assert.equal(attempts[0]?.prompt, attempts[1]?.prompt);
    assert.equal(groups.view(id).deliveries.length, 0);
    assert.deepEqual(groups.view(id).messages.map(message => message.kind), ['user', 'member']);
  });
});

test('two hosts can share a member without sharing private messages or resending after restart', async t => {
  const fixture = setup(t);
  await fixture.reopen();
  let { groups } = fixture;
  const first = await fixture.create(fixture.codex, 'one');
  await groups.poll();
  const second = await fixture.create(fixture.agy, 'two');
  await groups.poll();
  const b = JSON.stringify(['dsh', 'B']);
  assert.notEqual(groups.view(first.id).sessionId, groups.view(second.id).sessionId);
  assert.equal(groups.search({ query: 'ablation' }).items.length, 2);
  assert.equal(fixture.sent.length, 0);
  groups.send(first.id, { text: 'first @A', member: b, key: 'one' });
  groups.send(second.id, { text: 'second @C', member: b, key: 'two' });
  await groups.poll();
  assert.deepEqual(fixture.sent.map(item => item.target), ['dsh:B']);
  assert.equal(groups.view(second.id).deliveries[0]?.state, 'queued');
  groups = await fixture.reopen(true);
  must(fixture.histories.get('dsh:B')).turns.push(turn('private', 'Desktop question', 'Private conversation'));
  await groups.poll();
  assert.equal(fixture.sent.length, 1);
  assert.equal(groups.view(first.id).deliveries[0]?.state, 'sent');
  fixture.finish(0, 'Result one');
  await groups.poll();
  assert.deepEqual(fixture.sent.map(item => item.target), ['dsh:B', 'dsh:B']);
  fixture.finish(1, 'Result two');
  await groups.poll();
  await groups.poll();
  assert.deepEqual(groups.view(first.id).messages.map(item => item.text), ['first @A', 'Result one']);
  assert.deepEqual(groups.view(second.id).messages.map(item => item.text), ['second @C', 'Result two']);
  fixture.reads.length = fixture.catalogs.length = 0;
  groups.search();
  groups.view(first.id);
  await groups.poll();
  assert.deepEqual(fixture.reads, []);
  assert.deepEqual(fixture.catalogs, []);
});

test('the bound host decides who follows up, and summaries do not call a controller until requested', async t => {
  const fixture = setup(t), groups = await fixture.reopen();
  const { id } = await fixture.create(fixture.codex, 'host');
  await groups.poll();
  groups.send(id, { text: 'Ask A and then decide whether B should check', key: 'task' });
  await groups.poll();
  const action = (object: object) => '\x60\x60\x60frontdesk\n' + JSON.stringify(object) + '\n\x60\x60\x60';
  const host = 'codex:' + groups.view(id).sessionId;
  assert.equal(fixture.sent[0]?.target, host);
  const rootRequest = 'Ask A and then decide whether B should check';
  assert.equal(must(fixture.sent[0]).prompt.split(rootRequest).length, 2);
  fixture.finish(0, action({ action: 'ask', member: 'A', text: 'Show the first result' }));
  await groups.poll();
  await groups.poll();
  assert.equal(fixture.sent[1]?.target, 'dsh:A');
  assert.doesNotMatch(must(fixture.sent[1]).prompt, /Ask A and then decide/);
  fixture.finish(1, 'One result');
  await groups.poll();
  await groups.poll();
  assert.equal(fixture.sent[2]?.target, host);
  assert.equal(must(fixture.sent[2]).prompt.split('One result').length, 2);
  assert.doesNotMatch(must(fixture.sent[2]).prompt, /Ask A and then decide|Show the first result/);
  const result = groups.view(id).messages.find(item => item.text === 'One result');
  fixture.finish(2, action({ action: 'ask', member: 'B', text: 'Check A’s result', sources: [must(result).id, must(result).id] }));
  await groups.poll();
  await groups.poll();
  assert.equal(fixture.sent[3]?.target, 'dsh:B');
  assert.equal(must(fixture.sent[3]).prompt.split('One result').length, 2);
  assert.doesNotMatch(must(fixture.sent[3]).prompt, /Ask A and then decide/);
  fixture.finish(3, 'B agrees');
  await groups.poll();
  await groups.poll();
  assert.doesNotMatch(must(fixture.sent[4]).prompt, /One result/);
  fixture.finish(4, action({ action: 'summary', text: 'Confirmed' }));
  await groups.poll();
  assert.deepEqual(fixture.sent.map(item => item.target), [host, 'dsh:A', host, 'dsh:B', host]);
  assert.deepEqual(groups.decisions(id).map(item => item.text), ['Confirmed']);
  assert.deepEqual(fixture.reports, []);
  const daily = new UnifiedSession({ engine: fixture.agy.id, id: 'daily', cwd: fixture.directory, status: 'idle' });
  fixture.histories.set('antigravity:daily', { session: daily, turns: [] });
  const report = { key: 'report', message: groups.decisions(id)[0]?.id };
  groups.report(id, report, { engine: fixture.agy.id, id: daily.id, origin: 'wechat-test/' });
  groups.report(id, report, { engine: fixture.agy.id, id: daily.id, origin: 'wechat-test/' });
  await groups.poll();
  assert.equal(fixture.sent[5]?.target, 'antigravity:daily');
  assert.equal(fixture.sent.length, 6);
  fixture.finish(5, 'Received');
  await groups.poll();
  await groups.poll();
  assert.equal(fixture.reports.length, 1);
});

test('ordinary host turns use native context and a requested batch summary receives every new result once', async t => {
  const fixture = setup(t), groups = await fixture.reopen();
  const { id } = await fixture.create(fixture.codex, 'native-context');
  const poll = async () => { await groups.poll(); await groups.poll(); };
  const action = (value: object) => '\x60\x60\x60frontdesk\n' + JSON.stringify(value) + '\n\x60\x60\x60';
  await poll();
  groups.send(id, { text: 'Original instructions with OLD_TASK', key: 'original' });
  await poll();
  fixture.finish(0, action({ action: 'summary', text: 'OLD_CONCLUSION' }));
  await poll();
  groups.send(id, { text: 'Collect two results, then summarize NEW_TASK', key: 'next' });
  await poll();
  const second = must(fixture.sent[1]).prompt;
  assert.equal(second.split('NEW_TASK').length, 2);
  assert.doesNotMatch(second, /OLD_TASK|OLD_CONCLUSION/);
  fixture.finish(1, action({ action: 'collect', questions: [{ member: 'A', text: 'Read the first metric' }, { member: 'B', text: 'Read the second metric' }], summarize: true }));
  await poll();
  fixture.finish(2, 'RESULT_A');
  await poll();
  fixture.finish(3, 'RESULT_B');
  await poll();
  const summary = must(fixture.sent[4]).prompt;
  assert.equal(summary.split('RESULT_A').length, 2);
  assert.equal(summary.split('RESULT_B').length, 2);
  assert.doesNotMatch(summary, /OLD_TASK|OLD_CONCLUSION|NEW_TASK/);
});

test('explicit member context reads keep omitted and failed pages available and remember confirmed excerpts after restart', async t => {
  const fixture = setup(t);
  let groups = await fixture.reopen();
  const { id } = await fixture.create(fixture.codex, 'read-context');
  const poll = async () => { await groups.poll(); await groups.poll(); };
  const action = (value: object) => '\x60\x60\x60frontdesk\n' + JSON.stringify(value) + '\n\x60\x60\x60';
  await poll();
  for (let i = 0; i < 13; i++) {
    groups.send(id, { member: 'B', key: 'member-' + i, text: 'Question ' + i });
    await poll();
    fixture.finish(i, 'REPLY_' + i + '_END');
    await poll();
  }
  const latest = must(groups.view(id).messages.at(-1));
  groups.send(id, { member: 'C', key: 'quote', text: 'Check this one', replyTo: latest.id });
  await poll();
  assert.match(must(fixture.sent[13]).prompt, /REPLY_12_END/);
  assert.doesNotMatch(must(fixture.sent[13]).prompt, /REPLY_0_END/);
  fixture.finish(13, 'EXTRA_REPLY');
  await poll();
  groups.send(id, { key: 'read', text: 'Summarize all of B’s new replies' });
  await poll();
  assert.doesNotMatch(must(fixture.sent[14]).prompt, /REPLY_0_END|EXTRA_REPLY/);
  fixture.finish(14, action({ action: 'read', member: 'B', scope: 'group' }));
  await poll();
  const firstPage = must(fixture.sent[15]);
  assert.match(firstPage.prompt, /REPLY_0_END/);
  assert.match(firstPage.prompt, /"inReplyTo":\{"id":"[^"]+","text":"Question 0"\}/);
  assert.match(firstPage.prompt, /"moreMemberReplies":true/);
  assert.doesNotMatch(firstPage.prompt, /REPLY_12_END|EXTRA_REPLY/);
  fixture.finish(15, 'Stopped');
  must(must(fixture.histories.get(firstPage.target)).turns.at(-1)).status = 'failed';
  await poll();

  groups.send(id, { key: 'retry', text: 'Try reading B’s replies again' });
  await poll();
  fixture.finish(16, action({ action: 'read', member: 'B', scope: 'group' }));
  await poll();
  assert.match(must(fixture.sent[17]).prompt, /REPLY_0_END/);
  groups = await fixture.reopen();
  await poll();
  assert.equal(fixture.sent.length, 18, 'an unconfirmed context delivery is not resent');
  fixture.finish(17, action({ action: 'read', member: 'B', scope: 'group' }));
  await poll();
  const finalPage = must(fixture.sent[18]).prompt;
  assert.match(finalPage, /REPLY_12_END/);
  assert.match(finalPage, /"moreMemberReplies":false/);
  assert.doesNotMatch(finalPage, /REPLY_0_END|EXTRA_REPLY/);
});

test('the HTTP group API serves task progress and cancellation alongside the existing directory', async t => {
  const fixture = setup(t);
  const config = { ...loadConfig(), settingsFile: path.join(fixture.directory, 'settings.json'), uploadsDir: fixture.directory, exportsDir: fixture.directory };
  const context = await createApp({ config, host: fixture.host });
  const server = context.app.listen(0, '127.0.0.1');
  t.after(async () => { await context.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = 'http://127.0.0.1:' + address.port;
  assert.deepEqual(await (await fetch(base + '/api/groups')).json(), { items: [], nextOffset: null });
  const response = await fetch(base + '/api/group-members/dsh?q=Metrics');
  assert.equal(response.status, 200);
  const members = await response.json();
  assert.equal(members.length, 1);
  assert.equal(members[0].id, 'B');
  assert.deepEqual(fixture.reads, []);

  const host = new UnifiedSession({ id: 'http-host', engine: 'codex', title: 'Native host title', cwd: fixture.directory, status: 'busy' });
  fixture.histories.set('codex:' + host.id, { session: host, turns: [] });
  const post = (route: string, body: object) => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const createdResponse = await post('/api/groups/codex/create', { key: 'http-group', name: 'HTTP group', hostSession: host.id,
    members: [{ engine: 'dsh', id: 'B' }] });
  assert.equal(createdResponse.status, 202);
  const room: GroupView = await createdResponse.json();
  const route = '/api/groups/' + room.id;
  const reads = fixture.reads.length;
  const sessions = await (await fetch(base + '/api/sessions')).json();
  assert.equal(fixture.reads.length, reads);
  assert.equal(sessions.codex[0].title, 'Native host title');
  assert.deepEqual(sessions.codex[0].metadata.frontdeskRole, { kind: 'group-host', group: 'HTTP group' });
  assert.equal(sessions.dsh.find((item: UnifiedSession) => item.id === 'B').metadata.frontdeskRole, undefined);
  const hostHistory = await (await fetch(base + '/api/sessions/codex/' + host.id)).json();
  assert.deepEqual(hostHistory.session.metadata.frontdeskRole, sessions.codex[0].metadata.frontdeskRole);
  assert.equal(host.metadata.frontdeskRole, undefined, 'the engine record is not decorated in place');
  assert.equal(await (await fetch(base + route + '/task')).json(), null);
  const startedResponse = await post(route + '/messages', { key: 'task', text: 'Review the draft' });
  assert.equal(startedResponse.status, 202);
  const started: GroupView = await startedResponse.json();
  const progressResponse = await fetch(base + route + '/task');
  assert.equal(progressResponse.status, 200);
  const progress: GroupTask = await progressResponse.json();
  assert.equal(progress.id, started.task?.id);
  assert.equal(progress.state, 'queued');
  const stopResponse = await post(route + '/task/cancel', { taskId: progress.id, taskRevision: progress.revision });
  assert.equal(stopResponse.status, 200);
  const stopped: GroupView = await stopResponse.json();
  assert.equal(stopped.task?.state, 'cancelled');
  assert.equal(stopped.task?.deliveries[0]?.outcome, 'cancelled');
  assert.equal(fixture.sent.length, 0);
});

test('directory pagination and a specific group read leave one hundred idle native chats untouched', async t => {
  const fixture = setup(t), groups = await fixture.reopen();
  let chosen = '';
  for (let i = 0; i < 100; i++) {
    const room = await fixture.create(fixture.codex, 'seed-' + i);
    await groups.poll();
    if (i === 62) {
      chosen = room.id;
      groups.rename(chosen, { name: 'Ablation decision' });
    }
  }
  assert.equal(fixture.sent.length, 0);
  fixture.reads.length = fixture.catalogs.length = 0;
  assert.equal(groups.search().items.length, 30);
  assert.equal(groups.search().nextOffset, 30);
  assert.equal(groups.search({ query: 'decision' }).items[0]?.id, chosen);
  assert.equal(groups.view(chosen).state, 'ready');
  await groups.poll();
  assert.deepEqual(fixture.catalogs, []);
  assert.deepEqual(fixture.reads, []);
});

test('a paused group reconciles in-flight replies without executing a stale next step', async t => {
  const fixture = setup(t), groups = await fixture.reopen();
  const { id } = await fixture.create(fixture.codex, 'pause');
  await groups.poll();
  groups.send(id, { key: 'first', text: 'Have B check the answer' });
  await groups.poll();
  assert.equal(fixture.sent.length, 1);
  groups.pause(id, true);
  fixture.finish(0, '\x60\x60\x60frontdesk\n{"action":"ask","member":"B","text":"Check"}\n\x60\x60\x60');
  await groups.poll();
  groups.pause(id, false);
  await groups.poll();
  assert.equal(fixture.sent.length, 1);
  assert.equal(groups.view(id).pending, 0);
  assert.equal(groups.view(id).messages.at(-1)?.kind, 'host');
});

test('a native confirmation stays in the sending group after the original turn ends and reconnects', async t => {
  const fixture = setup(t), groups = await fixture.reopen();
  const { id } = await fixture.create(fixture.codex, 'pending');
  await groups.poll();
  groups.send(id, { key: 'review', text: 'Propose a plan', member: 'B' });
  await groups.poll();
  fixture.finish(0, 'The proposed plan');
  const native = must(must(fixture.histories.get('dsh:B')).turns.at(-1));
  native.approvals = [{ id: 'b-plan', title: 'Confirm plan', detail: '', kind: 'plan', decisions: ['desktop'] }];
  await groups.poll();
  assert.equal(groups.view(id).deliveries[0]?.state, 'waiting');
  assert.equal(groups.view(id).deliveries[0]?.nativeTurn, native.id);
  assert.equal(groups.view(id).deliveries[0]?.attention?.title, 'Confirm plan');
  const reopened = await fixture.reopen();
  await reopened.poll();
  assert.equal(reopened.view(id).deliveries[0]?.attention?.id, 'b-plan');
  delete native.approvals;
  await reopened.poll();
  assert.equal(reopened.view(id).messages.at(-1)?.text, 'The proposed plan');
  assert.equal(fixture.sent.length, 1);
});
