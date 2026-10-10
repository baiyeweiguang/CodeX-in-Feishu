import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const file = path.join(process.cwd(), '.fake-threads.json');
const threads = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const pending = new Map(); const timers = new Map();
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const persist = () => fs.writeFileSync(file, JSON.stringify(threads));
function finish(threadId, turn, status = 'completed', text = 'DONE') {
  clearTimeout(timers.get(turn.id)); timers.delete(turn.id);
  turn.status = status;
  turn.items = [{ type: 'agentMessage', id: randomUUID(), text, phase: 'final_answer' }];
  persist();
  send({ method: 'item/completed', params: { threadId, turnId: turn.id, item: turn.items[0] } });
  send({ method: 'turn/completed', params: { threadId, turn } });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line); const p = m.params ?? {};
  if (!m.method) {
    const request = pending.get(m.id);
    if (request) {
      pending.delete(m.id);
      send({ method: 'serverRequest/resolved', params: { threadId: request.threadId, requestId: m.id } });
      if ([...pending.values()].some(other => other.turn.id === request.turn.id)) return;
      finish(request.threadId, request.turn, 'completed', JSON.stringify(m.result ?? m.error));
    } return;
  }
  const reply = result => send({ id: m.id, result });
  switch (m.method) {
    case 'initialize': reply({ userAgent: 'fake/1' }); break;
    case 'initialized': break;
    case 'thread/start': {
      const thread = { id: randomUUID(), turns: [], cwd: process.cwd() };
      threads[thread.id] = thread; persist(); reply({ thread }); break;
    }
    case 'thread/resume': case 'thread/read': reply({ thread: threads[p.threadId] }); break;
    case 'turn/start': {
      const thread = threads[p.threadId];
      const text = p.input.find(i => i.type === 'text').text;
      const turn = { id: randomUUID(), status: 'inProgress', items: [], error: null };
      thread.turns.push(turn); persist();
      const countFile = path.join(process.cwd(), 'execution-count.txt');
      fs.writeFileSync(countFile, String(Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : 0) + 1));
      if (text.startsWith('AMBIGUOUS')) { finish(p.threadId, turn, 'completed', 'executed without response'); break; }
      send({ method: 'turn/started', params: { threadId: p.threadId, turn } });
      reply({ turn });
      if (text.startsWith('STREAM')) {
        const itemId = randomUUID();
        for (const [index, delta] of ['Hello', ' world', '!'].entries()) setTimeout(() => {
          if (turn.status === 'inProgress') send({ method: 'item/agentMessage/delta', params: { threadId: p.threadId, turnId: turn.id, itemId, delta } });
        }, 100 + index * 800);
        timers.set(turn.id, setTimeout(() => finish(p.threadId, turn, 'completed', 'Hello world!'), 2600)); break;
      }
      if (text.startsWith('LONG')) { timers.set(turn.id, setTimeout(() => finish(p.threadId, turn, 'completed', 'Long response. '.repeat(1000)), 50)); break; }
      if (text.startsWith('DISCONNECT')) { setTimeout(() => process.exit(3), 20); break; }
      if (text.startsWith('APPROVE') || text.startsWith('ASK')) {
        for (let n = 0; n < (text.startsWith('APPROVE2') ? 2 : 1); n++) {
        const requestId = 900 + n; pending.set(requestId, { threadId: p.threadId, turn });
        send({ id: requestId, method: text.startsWith('ASK') ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval',
          params: { threadId: p.threadId, turnId: turn.id, itemId: 'item', command: 'echo test', reason: 'Test request',
            questions: [{ id: 'choice', question: 'Choose a value', options: [{ label: 'A', description: 'Option A' }] }] } });
        } break;
      }
      if (text.startsWith('TOOLLOG')) {
        for (let n = 0; n < 12; n++) for (const phase of ['started', 'completed']) send({ method: `item/${phase}`, params: {
          threadId: p.threadId, turnId: turn.id, item: { id: `command-${n}`, type: n % 2 ? 'fileChange' : 'commandExecution',
            command: `echo execution-${n}`, changes: [{ path: `file-${n}.txt` }], status: phase === 'completed' ? 'completed' : 'inProgress' } } });
      }
      if (text.startsWith('CHILD')) {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        fs.writeFileSync(path.join(process.cwd(), 'child-pid.txt'), String(child.pid));
      }
      if (text.startsWith('EXPORT')) {
        const target = /put copies in ("(?:\\.|[^"\\])*")/.exec(text);
        if (target) {
          const dir = JSON.parse(target[1]);
          fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'report.txt'), 'ORIGINAL_ARTIFACT');
          fs.writeFileSync(path.join(dir, 'artifacts.json'), JSON.stringify({ artifacts: [{ path: 'report.txt', name: 'report.txt' }] }));
        }
      }
      timers.set(turn.id, setTimeout(() => finish(p.threadId, turn, text.startsWith('FAIL') ? 'failed' : 'completed',
        `Result: ${text.split('\n')[0]} / history=${thread.turns.length}`), text.startsWith('SLOW') || text.startsWith('CHILD') ? 60000 : 50));
      break;
    }
    case 'turn/interrupt': {
      reply({}); const turn = threads[p.threadId].turns.find(t => t.id === p.turnId);
      if (turn?.status === 'inProgress') finish(p.threadId, turn, 'interrupted', 'stopped'); break;
    }
    case 'turn/steer': if (p.input[0]?.text !== 'STALL') reply({ turnId: p.expectedTurnId }); break;
    default: send({ id: m.id, error: { code: -32601, message: `Unsupported ${m.method}` } });
  }
});
