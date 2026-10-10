import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config/load.js';
import { makeLogger } from '../src/observability/logger.js';
import { CodexClient, type RpcEvent } from '../src/adapters/codex/client.js';
import type { Session } from '../src/domain/models.js';

const config = loadConfig();
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'connector-codex-smoke-'));
const project = { ...config.projects[0]!, root, workspaceKey: root, sandbox: 'workspace-write' as const };
const client = new CodexClient(project, config.codex, makeLogger(config.appSecret));
const events: string[] = [];
client.on('event', (e: RpcEvent) => {
  if (e.id !== undefined) {
    console.log(JSON.stringify({ interaction: e.method, command: e.params.command, reason: e.params.reason }));
    if (e.method === 'item/fileChange/requestApproval' || (e.method === 'item/commandExecution/requestApproval' && String(e.params.command).includes('hello.txt')))
      client.respond(e.id, { decision: 'accept' });
    else client.reject(e.id, 'Unexpected approval in smoke test');
  }
  if (e.method === 'item/completed' && e.params.item?.type === 'commandExecution')
    console.log(JSON.stringify({ command: e.params.item.command, exitCode: e.params.item.exitCode, output: e.params.item.aggregatedOutput }));
  if (['item/completed', 'turn/completed'].includes(e.method)) events.push(e.method);
});
const waitTurn = (threadId: string, text: string) => new Promise<string>((resolve, reject) => {
  let result = ''; const timer = setTimeout(() => { cleanup(); reject(new Error('Live turn timed out')); }, 120000);
  const handler = (event: RpcEvent) => {
    if (event.params.threadId !== threadId) return;
    if (event.method === 'item/completed' && event.params.item?.type === 'agentMessage') result = event.params.item.text;
    if (event.method === 'turn/completed') { cleanup(); event.params.turn.status === 'completed' ? resolve(result) : reject(new Error(`Live turn ${event.params.turn.status}`)); }
  };
  const cleanup = () => { clearTimeout(timer); client.off('event', handler); };
  client.on('event', handler);
  void client.startTurn(threadId, text, crypto.randomUUID()).catch(error => { cleanup(); reject(error); });
});
try {
  const session: Session = { id: crypto.randomUUID(), actorId: 'smoke', scope: 'smoke', projectId: project.id,
    cwd: root, title: 'Connector smoke', queuePaused: false, createdAt: Date.now() };
  const threadId = await client.ensureThread(session);
  const first = await waitTurn(threadId, 'For this protocol test, remember the exact marker CONNECTOR_MEMORY_7391. Reply only ACK. Do not call tools.');
  const second = await waitTurn(threadId, 'What exact marker did I ask you to remember? Reply only that marker. Do not call tools.');
  if (!second.includes('CONNECTOR_MEMORY_7391')) throw new Error('Conversation continuity failed');
  const third = await waitTurn(threadId, 'Create hello.txt in the current directory with exactly CONNECTOR_FILE_OK as its contents. Do not use other directories. Then reply DONE.');
  console.log(JSON.stringify({ root, threadId, first, second, third }));
  const content = await fs.readFile(path.join(root, 'hello.txt'), 'utf8');
  if (!content.includes('CONNECTOR_FILE_OK')) throw new Error('File execution failed');
  const snapshot = await client.readThread(threadId);
  console.log(JSON.stringify({ success: true, root, threadId, turns: snapshot.turns.length, first, second, third, events: events.length }, null, 2));
} finally { await client.close(); }
