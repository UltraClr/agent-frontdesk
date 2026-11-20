import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { WorkBuddyBridge } from '../src/server/workbuddy-bridge.js';

test('WorkBuddy lists local undeleted chats and reads native messages and the latest outcome', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'frontdesk-workbuddy-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const group = path.join(home, 'projects', 'fixture');
  fs.mkdirSync(group, { recursive: true });
  const db = new DatabaseSync(path.join(home, 'workbuddy.db'));
  db.exec(`CREATE TABLE workspaces (path TEXT PRIMARY KEY, last_opened_at INT);
    INSERT INTO workspaces VALUES ('/demo',2),('/empty',1);
    CREATE TABLE sessions (id TEXT, cwd TEXT, title TEXT, custom_title TEXT, status TEXT, created_at INT, updated_at INT, last_activity_at INT, model TEXT,
    permission_mode TEXT, deleted_at INT, transport TEXT);
    INSERT INTO sessions VALUES
    ('live','/demo','Original','Renamed','completed',1760000000000,1760000000100,1760000000100,'model','normal',NULL,'local'),
    ('remote','/demo','Remote',NULL,'completed',0,0,0,NULL,NULL,NULL,'cloud'),
    ('trash','/demo','Trash',NULL,'completed',0,0,0,NULL,NULL,1,'local');`);
  db.close();
  const record = (id: string, role: string, text: string, sessionId = 'live') => ({
    id, sessionId, role, status: 'completed', type: 'message', timestamp: '2026-11-19T01:00:00Z',
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
  });
  fs.writeFileSync(path.join(group, 'live.jsonl'), [
    record('a', 'user', '<system-reminder>Internal context</system-reminder>\n<user_query>First</user_query>'),
    record('b', 'assistant', 'First result\n\n[wbs-reply-done]: #'),
    record('hidden', 'user', '<cb_summary>Compacted internal history</cb_summary>'),
    record('c', 'user', 'Second'), record('d', 'assistant', 'Second result'),
    record('private', 'assistant', 'Other chat', 'remote'),
  ].map(item => JSON.stringify(item)).join('\n'));
  const bridge = new WorkBuddyBridge(home);
  assert.deepEqual(bridge.catalog().map(item => [item.id, item.title]), [['live', 'Renamed']]);
  assert.deepEqual(bridge.projects().map(item => item.cwd), ['/demo', '/empty']);
  const history = await bridge.read('live');
  assert.equal(history.session?.metadata?.desktop?.model, 'model');
  assert.equal(history.session?.metadata?.group?.cwd, '/demo');
  assert.deepEqual(history.turns.map(item => [item.userPrompt, item.assistantReply, item.status, item.statusEvidence]), [
    ['First', 'First result', 'unknown', null], ['Second', 'Second result', 'completed', 'workbuddy_session_status'],
  ]);
  await assert.rejects(bridge.read('remote'), /找不到/);
});
