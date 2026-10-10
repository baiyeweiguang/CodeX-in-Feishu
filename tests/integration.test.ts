import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { harness } from './helpers.js';
import { terminal } from '../src/domain/models.js';

let h: Awaited<ReturnType<typeof harness>>;
afterEach(async () => { await h?.close(); });
describe('gateway end-to-end with a real protocol subprocess', () => {
  it('handles status and stop while a steer request is stalled', async () => {
    h = await harness(); await h.send('/project a'); await h.send('SLOW');
    await h.pump(() => h.app.store.list('tasks')[0]?.state === 'running');
    const steer = h.event('/steer STALL'); h.app.router.accept(steer); await h.app.router.tick();
    expect(h.app.store.get('inbox', steer.id)?.state).toBe('pending');
    await h.send('/status'); await h.send('/stop');
    await h.pump(() => h.app.store.list('tasks')[0]?.finalized === true);
    expect(h.app.store.list('tasks')[0]?.state).toBe('cancelled');
  });
  it('replays an unfinished new-conversation inbox without creating another session', async () => {
    h = await harness(); await h.send('/project a'); const message = await h.send('/new durable');
    const row = h.app.store.get('inbox', message.id)!;
    h.app.store.put('inbox', { ...row, state: 'pending' }); await h.restart();
    await h.pump(() => h.app.store.get('inbox', message.id)?.state === 'done');
    expect(h.app.store.list('sessions')).toHaveLength(2);
    expect(h.app.sessions.current(h.event(''))?.id).toBe(message.id);
  });
  it('selects projects, preserves conversation context, creates and switches sessions', async () => {
    h = await harness(); await h.send('/project a'); const session = h.app.sessions.current(h.event(''))!;
    await h.send('first'); await h.pump(() => h.app.store.list('tasks')[0]?.finalized === true);
    await h.send('second'); await h.pump(() => h.app.store.list('tasks')[1]?.finalized === true);
    expect(h.app.store.list('tasks')[1]?.result).toContain('history=2');
    await h.send('/new other'); const next = h.app.sessions.current(h.event(''))!;
    expect(next.id).not.toBe(session.id);
    await h.send('third'); await h.pump(() => h.app.store.list('tasks')[2]?.finalized === true);
    expect(h.app.store.list('tasks')[2]?.result).toContain('history=1');
    await h.send(`/use ${session.id.slice(0, 8)}`); expect(h.app.sessions.current(h.event(''))?.id).toBe(session.id);
    await h.send('/project b'); await h.send('/project a'); expect(h.app.sessions.current(h.event(''))?.id).toBe(session.id);
  }, 40000);

  it('deduplicates inbound events and freezes project and reply targets', async () => {
    h = await harness(); await h.send('/project a');
    const message = h.event('first'); h.app.router.accept(message); h.app.router.accept({ ...message, id: 'duplicate', eventId: 'another-event' });
    await h.app.router.tick(); await h.send('/project b');
    expect(h.app.store.list('tasks')).toHaveLength(1);
    expect(h.app.store.list('tasks')[0]?.projectId).toBe('a');
    await h.pump(() => h.app.store.list('tasks')[0]?.finalized === true);
    const final = h.app.store.list('outbox').find(d => d.message.streamDone);
    expect(final?.target).toEqual(message.target);
  });

  it('serializes one workspace while another project can execute', async () => {
    h = await harness(); await h.send('/project a'); await h.send('SLOW'); await h.send('queued');
    await h.send('/project b'); await h.send('fast');
    await h.pump(() => h.app.store.list('tasks').some(t => t.projectId === 'b' && t.finalized));
    const a = h.app.store.list('tasks').filter(t => t.projectId === 'a');
    expect(a.map(t => t.state)).toEqual(['running', 'queued']);
    await h.send(`/stop ${a[0]!.id}`);
    await h.pump(() => h.app.store.get('tasks', a[0]!.id)?.state === 'cancelled');
    expect(h.app.store.get('tasks', a[1]!.id)?.state).toBe('queued');
    await h.send('/project a'); await h.send('/continue');
    await h.pump(() => h.app.store.get('tasks', a[1]!.id)?.finalized === true);
  }, 40000);

  it('handles approval once and rejects replay', async () => {
    h = await harness(); await h.send('/project a'); await h.send('APPROVE');
    await h.pump(() => h.app.store.list('interactions').length === 1);
    const request = h.app.store.list('interactions')[0]!;
    await h.send(`/approve ${request.id}`); await h.pump(() => h.app.store.list('tasks')[0]?.finalized === true);
    expect(h.app.store.list('tasks')[0]?.result).toContain('accept');
    await h.send(`/approve ${request.id}`);
    expect(h.app.store.list('interactions')[0]?.state).toBe('resolved');
    expect(h.app.store.list('outbox').some(d => d.message.text.includes('已经处理'))).toBe(true);
  });

  it('answers user input without starting another turn', async () => {
    h = await harness(); await h.send('/project a'); await h.send('ASK');
    await h.pump(() => h.app.store.list('interactions').length === 1);
    await h.send(`/answer ${h.app.store.list('interactions')[0]!.id} A`);
    await h.pump(() => h.app.store.list('tasks')[0]?.finalized === true);
    expect(h.app.store.list('tasks')).toHaveLength(1);
    expect(h.app.store.list('tasks')[0]?.result).toContain('"answers":["A"]');
  });

  it('downloads once when a task arrives while download is in flight', async () => {
    h = await harness(); await h.send('/project a');
    await h.send('', { kind: 'file', resourceKey: 'resource', fileName: 'input with spaces.txt' });
    await h.send('read input');
    await h.pump(() => h.app.store.list('tasks')[0]?.finalized === true);
    const attachment = h.app.store.list('attachments')[0]!;
    expect(attachment.taskId).toBe(h.app.store.list('tasks')[0]!.id);
    expect(attachment.state).toBe('ready'); expect(h.transport.downloadCount).toBe(1);
    const inputDir = path.join(h.root, 'a', '.codex-connector/sessions', attachment.sessionId!, 'inputs');
    expect(await fs.readdir(inputDir)).toHaveLength(1);
  });

  it('sends immutable artifacts and retries delivery without reexecution or reupload', async () => {
    h = await harness(); await h.send('/project a'); await h.send('EXPORT');
    await h.pump(() => h.app.store.list('tasks')[0]?.finalized === true);
    const artifact = h.app.store.list('artifacts')[0]!;
    await fs.writeFile(path.join(h.app.store.list('tasks')[0]!.exportsPath!, 'report.txt'), 'CHANGED');
    await h.app.delivery.tick();
    await h.send(`/send ${artifact.id}`); h.transport.failSend = 1; await h.app.delivery.tick();
    const delivery = h.app.store.list('outbox').find(d => d.artifactId === artifact.id)!;
    await h.restart();
    h.app.store.put('outbox', { ...delivery, nextAttemptAt: 0 }); await h.app.delivery.tick();
    expect(h.transport.uploads.at(-1)?.content).toBe('ORIGINAL_ARTIFACT');
    expect(h.transport.uploads).toHaveLength(1);
    expect(h.app.store.list('tasks')).toHaveLength(1);
    expect(h.app.store.get('outbox', delivery.id)?.state).toBe('sent');
  });

  it('persists cursors and resumes a completed thread after restart', async () => {
    h = await harness(); await h.send('/project a'); await h.send('first');
    await h.pump(() => h.app.store.list('tasks')[0]?.finalized === true);
    const threadId = h.app.store.list('sessions')[0]?.threadId;
    await h.restart(); await h.send('second'); await h.pump(() => h.app.store.list('tasks')[1]?.finalized === true);
    expect(h.app.store.list('sessions')[0]?.threadId).toBe(threadId);
    expect(h.app.store.list('tasks')[1]?.result).toContain('history=2');
  }, 30000);

  it('does not replay a task whose dispatch outcome is unknown', async () => {
    h = await harness(); await h.send('/project a'); await h.send('not sent');
    const task = h.app.store.list('tasks')[0]!;
    h.app.store.put('tasks', { ...task, state: 'starting' });
    await h.restart();
    expect(h.app.store.get('tasks', task.id)?.state).toBe('interrupted_unknown');
    expect(h.app.store.get('sessions', task.sessionId)?.queuePaused).toBe(true);
    await expect(fs.stat(path.join(h.root, 'a', 'execution-count.txt'))).rejects.toThrow();
  });

  it('recovers a persisted completed turn and only queues its result', async () => {
    h = await harness(); await h.send('/project a'); await h.send('first');
    await h.pump(() => h.app.store.list('tasks')[0]?.finalized === true);
    const task = h.app.store.list('tasks')[0]!;
    h.app.store.put('tasks', { ...task, state: 'running', finalized: false });
    await h.restart();
    expect(h.app.store.get('tasks', task.id)?.state).toBe('succeeded');
    expect(await fs.readFile(path.join(h.root, 'a', 'execution-count.txt'), 'utf8')).toBe('1');
    expect(h.app.store.list('outbox').filter(d => d.message.streamDone)).toHaveLength(1);
  }, 30000);

  it('rejects other users and group messages before creating tasks', async () => {
    h = await harness(); await h.send('/project a', { actorId: 'stranger' }); await h.send('task', { actorId: 'stranger' });
    await h.send('/project a', { isGroup: true });
    expect(h.app.store.list('sessions')).toHaveLength(0); expect(h.app.store.list('tasks')).toHaveLength(0);
  });

  it('keeps pairing keys reusable after restart and rejects revoked keys', async () => {
    h = await harness(); const code = h.app.sessions.makePairing();
    await h.send('/pair wrong', { actorId: 'new-owner' }); expect(h.app.store.list('owners')).toHaveLength(0);
    await h.send(`/pair ${code}`, { actorId: 'new-owner' }); expect(h.app.store.get('owners', 'new-owner')).toBeDefined();
    await h.restart();
    const record = h.app.store.get('pairing', 'owner')!;
    h.app.store.put('pairing', { ...record, expiresAt: 1 });
    await h.send(`/pair ${code}`, { actorId: 'another' }); expect(h.app.store.get('owners', 'another')).toBeDefined();
    await h.send('/pair-revoke'); await h.restart();
    await h.send(`/pair ${code}`, { actorId: 'revoked-user' }); expect(h.app.store.get('owners', 'revoked-user')).toBeUndefined();
    expect(h.app.store.get('owners', 'new-owner')).toBeDefined();
    expect(h.app.store.list('inbox').every(e => !e.text.includes(code))).toBe(true);
  });

  it('stops spawned descendants when cancelling a task', async () => {
    h = await harness(); await h.send('/project a'); await h.send('CHILD');
    await h.pump(() => h.app.store.list('tasks')[0]?.state === 'running');
    const pidFile = path.join(h.root, 'a', 'child-pid.txt');
    let pid = 0;
    for (let i = 0; i < 50 && !pid; i++) { try { pid = Number(await fs.readFile(pidFile, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
    expect(pid).toBeGreaterThan(0);
    await h.send('/stop'); await h.pump(() => h.app.store.list('tasks')[0]?.finalized === true);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('isolates a crashed Codex process and pauses its queue', async () => {
    h = await harness(); await h.send('/project a'); await h.send('DISCONNECT'); await h.send('queued');
    await h.pump(() => h.app.store.list('tasks')[0]?.finalized === true);
    expect(h.app.store.list('tasks')[0]?.state).toBe('interrupted_unknown');
    expect(h.app.store.list('tasks')[1]?.state).toBe('queued');
  });
});
