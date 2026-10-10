import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { harness } from './helpers.js';
import { parseCommand } from '../src/application/command-router.js';

let h: Awaited<ReturnType<typeof harness>> | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

describe('permanent pairing and command discovery', () => {
  it('migrates a consumed local key and keeps it stable until revocation or rotation', async () => {
    h = await harness(); const file = path.join(h.config.dataDir, 'pairing-code.txt');
    const old = '1234567890abcdef'; await fs.writeFile(file, `/pair ${old}\n`);
    await h.app.sessions.pairingFile();
    await h.send(`/pair ${old}`, { actorId: 'migrated' });
    expect(h.app.store.get('owners', 'migrated')).toBeDefined();
    await h.restart(); await h.app.sessions.pairingFile();
    expect(await fs.readFile(file, 'utf8')).toBe(`/pair ${old}\n`);
    await h.send('/pair-revoke'); await h.restart();
    await h.app.sessions.pairingFile(); await expect(fs.stat(file)).rejects.toThrow();
    await h.app.sessions.pairingFile(true);
    const renewed = (await fs.readFile(file, 'utf8')).trim();
    expect(renewed).toMatch(/^\/pair [a-f0-9]{64}$/);
    await h.send(renewed, { actorId: 'rotated' }); expect(h.app.store.get('owners', 'rotated')).toBeDefined();
    await h.send(`/pair ${old}`, { actorId: 'old-key' }); expect(h.app.store.get('owners', 'old-key')).toBeUndefined();
  });
  it.each(['list', '/list', 'list commands', '/list commands'])('shows a menu without starting a task: %s', async command => {
    h = await harness(); await h.send(command);
    expect(h.app.store.list('tasks')).toHaveLength(0);
    const reply = h.app.store.list('outbox')[0]!;
    expect(reply.message.text).toContain('list projects');
    expect(reply.message.buttons).toHaveLength(4);
  });
  it.each(['list projects', '/list projects'])('lists projects before a selection: %s', async command => {
    h = await harness(); await h.send(command);
    const reply = h.app.store.list('outbox')[0]!;
    expect(reply.message.text).toContain(h.config.projects[0]!.root);
    const token = reply.message.buttons![1]!.token;
    await h.send('', { kind: 'action', actionToken: token });
    expect(h.app.sessions.current(h.event(''))?.projectId).toBe('b');
    expect(h.app.store.list('tasks')).toHaveLength(0);
  });
  it('offers buttons for projects after the first page', async () => {
    h = await harness();
    for (let i = 0; i < 5; i++) h.config.projects.push({ ...h.config.projects[0]!, id: `p${i}`, alias: `p${i}` });
    await h.send('/list projects');
    let reply = h.app.store.list('outbox').at(-1)!;
    await h.send('', { kind: 'action', actionToken: reply.message.buttons!.at(-1)!.token });
    reply = h.app.store.list('outbox').at(-1)!;
    expect(reply.message.text).toContain('第 2/2 页');
    await h.send('', { kind: 'action', actionToken: reply.message.buttons![2]!.token });
    expect(h.app.sessions.current(h.event(''))?.projectId).toBe('p4');
  });
  it('does not interpret prose mentioning list as a command', () => {
    expect(parseCommand('Please list projects in the README')).toBeUndefined();
  });
});

describe('one streaming card per task', () => {
  it('streams deltas into the queued card, then replaces it with the final answer', async () => {
    h = await harness(); await h.send('/project a'); await h.app.delivery.tick();
    const before = h.transport.sent.length;
    await h.send('STREAM'); await h.app.delivery.tick();
    const first = h.transport.sent.at(-1)!;
    await h.pump(() => h!.transport.streamUpdates.some(u => u.message.text.includes('Hello') && !u.message.streamDone));
    await h.pump(() => h!.app.store.list('tasks')[0]?.finalized === true);
    expect(h.transport.sent).toHaveLength(before + 1);
    expect(h.transport.sent.at(-1)?.id).toBe(first.id);
    expect(h.transport.sent.at(-1)?.message.text).toBe('Hello world!');
    expect(h.transport.sent.at(-1)?.message.streamDone).toBe(true);
    const task = h.app.store.list('tasks')[0]!;
    h.app.delivery.progress(task.id, task.target, { text: 'late old progress' });
    await h.app.delivery.tick(); expect(h.transport.sent.at(-1)?.message.text).toBe('Hello world!');
  });
  it('reuses the persisted card entity after a send failure and restart', async () => {
    h = await harness(); await h.send('/project a'); await h.app.delivery.tick();
    await h.send('queued'); h.transport.failSend = 1; await h.app.delivery.tick();
    const row = h.app.store.list('outbox').find(d => d.message.streaming)!;
    expect(row.cardId).toBeTruthy(); expect(row.remoteId).toBeUndefined();
    await h.restart();
    h.app.store.put('outbox', { ...row, nextAttemptAt: 0 }); await h.app.delivery.tick();
    expect(h.transport.streams).toHaveLength(1);
    expect(h.transport.sent.at(-1)?.message.cardId).toBe(row.cardId);
  });
  it('returns a long answer as a downloadable file without splitting the task card', async () => {
    h = await harness(); await h.send('/project a'); await h.app.delivery.tick();
    const before = h.transport.sent.length; await h.send('LONG');
    await h.pump(() => h!.app.store.list('tasks')[0]?.finalized === true);
    expect(h.transport.sent).toHaveLength(before + 1);
    const full = h.app.store.list('artifacts').find(a => a.name === '完整回复.md')!;
    expect(await fs.readFile(full.snapshotPath, 'utf8')).toBe('Long response. '.repeat(1000));
    expect(h.transport.sent.at(-1)?.message.buttons?.length).toBeGreaterThan(0);
  });
});
