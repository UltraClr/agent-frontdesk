import { request } from 'node:http';
import { readFileSync } from 'node:fs';

const [op, value] = process.argv.slice(2);
if (!op || op === 'help') {
  console.log(JSON.stringify({
    agents: {},
    workers: 'Find chats you have tracked or delegated work to. Match follow-ups by chat title, description, last task or optional alias. If several chats fit, ask the user.',
    search: { engine: 'engine-id', query: 'title keywords', project: 'project or folder (optional)', after: 'ISO datetime (optional)', before: 'ISO datetime (optional)', offset: 0 },
    track: { engine: 'engine-id', id: 'matched-session-id', role: 'optional short alias', purpose: 'optional description of what the chat is working on' },
    untrack: { engine: 'engine-id', id: 'saved-session-id', effect: 'Forget this saved chat. The desktop chat and its delivery history stay available.' },
    read: { engine: 'engine-id', id: 'matched-session-id', role: 'exact saved alias (instead of engine and id)', offset: 0 },
    send: { engine: 'engine-id', id: 'matched-session-id', role: 'exact saved alias (instead of engine and id)', key: 'stable unique delivery key', prompt: 'user-authorized message', mode: 'queue (default) or steer',
      followUp: 'false by default; use true only if the user wants the coordinator to act again after the target replies' },
    follow: {},
    'group-member-options': { engine: 'engine-id; returns desktop project paths and model IDs' },
    'group-create': { key: 'stable creation key', name: 'group title', topic: 'subject', workspace: 'optional default absolute project path',
      host: 'optional engine ID for the host; defaults to the current coordinator', hostSession: 'optional chosen native chat ID on the host engine',
      members: [{ engine: 'engine-id', id: 'native-session-id', alias: 'unique alias for an existing chat' },
        { engine: 'engine-id', newSession: true, alias: 'unique alias for a dedicated chat',
          setup: { workspace: 'optional absolute project path; null opts out of the group project', model: 'optional desktop model ID' } }] },
    'group-find': { query: 'name, topic or member', after: 'ISO datetime', before: 'ISO datetime', offset: 0 },
    'group-open': { group: 'group-id', before: 'optional message cursor' },
    'group-decisions': { group: 'group-id' },
    'group-send': { group: 'group-id', key: 'stable request key', text: 'message', member: 'optional member alias or JSON.stringify([engine,id]); omit to ask host', replyTo: 'optional message ID' },
    'group-report': { group: 'group-id', key: 'stable report key', message: 'conclusion message ID' },
  }, null, 2));
} else {
  try {
    const { address, key, engine } = JSON.parse(readFileSync('.frontdesk-controller-tool.json', 'utf8'));
    const json = value?.startsWith('@') ? readFileSync(value.slice(1), 'utf8').replace(/^\uFEFF/, '') : value;
    const data = JSON.stringify({ controller: engine, key, op, args: JSON.parse(json || '{}') });
    const call = request({ socketPath: address, path: '/', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, reply => {
      reply.setEncoding('utf8');
      reply.on('data', chunk => process.stdout.write(chunk));
      reply.on('end', () => { process.stdout.write('\n'); if (reply.statusCode >= 400) process.exitCode = 1; });
    });
    call.setTimeout(30_000, () => call.destroy(new Error('Frontdesk did not respond')));
    call.on('error', error => { console.error(error.message); process.exitCode = 1; });
    call.end(data);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
