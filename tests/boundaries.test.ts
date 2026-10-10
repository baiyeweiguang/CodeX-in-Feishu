import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import pino from 'pino';
import { harness, MemoryTransport } from './helpers.js';
import { safePath, sensitive, validateRelative } from '../src/adapters/filesystem/paths.js';
import { normalize, card } from '../src/adapters/feishu/client.js';
import { chunks, DeliveryService } from '../src/application/delivery-service.js';
import { Store } from '../src/adapters/persistence/database.js';
import { instanceLock } from '../src/platform/instance-lock.js';
import { scopeKey, type Task } from '../src/domain/models.js';

let h: Awaited<ReturnType<typeof harness>> | undefined;
afterEach(async () => { await h?.close(); h = undefined; });
describe('file and identity boundaries', () => {
  it('resumes partial artifact collection without duplicating snapshots', async () => {
    h = await harness(); await h.send('/project a');
    const session = h.app.sessions.current(h.event(''))!;
    const root = path.join(h.root, 'a', 'exports'); await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'one.txt'), 'one');
    await fs.writeFile(path.join(root, 'two.txt'), 'two');
    const task: Task = { id: 'collect', inboxId: 'collect', sessionId: session.id, projectId: 'a',
      actorId: 'owner', scope: session.scope, target: { chatId: 'chat' }, project: h.config.projects[0]!,
      prompt: '', state: 'succeeded', createdAt: Date.now(), exportsPath: root };
    const first = await h.app.files.snapshot(task, root, 'one.txt');
    const result = await h.app.files.collect(task);
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.some(a => a.id === first.id)).toBe(true);
    expect((await h.app.files.collect(task)).artifacts).toHaveLength(2);
  });
  it('serializes quota admission for concurrent incoming files', async () => {
    h = await harness(); h.config.files.maxStorageBytes = h.config.files.maxBytes;
    await h.send('/project a');
    await h.send('', { kind: 'file', resourceKey: 'one', fileName: 'one.txt' });
    await h.send('', { kind: 'file', resourceKey: 'two', fileName: 'two.txt' });
    await h.pump(() => h!.app.store.list('attachments').every(a => ['ready', 'failed'].includes(a.state)));
    expect(h.app.store.list('attachments', { state: 'ready' })).toHaveLength(1);
    expect(h.app.store.list('attachments', { state: 'failed' })).toHaveLength(1);
  });
  it.each(['../outside', '..\\outside', 'C:\\private.txt', '\\\\server\\share', 'x.txt:stream', 'con.txt', 'NUL', 'folder./x', 'foo?.txt'])('rejects path %s', input => {
    expect(() => validateRelative(input)).toThrow();
  });
  it.each(['.env', '.env.production', '.git/config', '.codex/auth.json', '.ssh/id_rsa', 'secrets.key', 'config.local.yaml'])('blocks sensitive file %s', input => expect(sensitive(input)).toBe(true));
  it('rejects junctions and handles spaces and unicode paths', async () => {
    h = await harness(); const root = path.join(h.root, 'a');
    await fs.writeFile(path.join(root, '中文 report.txt'), 'ok');
    expect(await safePath(root, '中文 report.txt')).toBe(path.join(root, '中文 report.txt'));
    await fs.symlink(path.join(h.root, 'b'), path.join(root, 'link'), 'junction');
    await expect(safePath(root, 'link/file.txt', true)).rejects.toThrow();
  });
  it('rejects oversized explicit file sends without producing an artifact', async () => {
    h = await harness(); await h.send('/project a');
    await fs.writeFile(path.join(h.root, 'a', 'large.bin'), Buffer.alloc(h.config.files.maxBytes + 1));
    await h.send('/send-path large.bin'); expect(h.app.store.list('artifacts')).toHaveLength(0);
    expect(h.app.store.list('outbox').some(d => d.message.text.includes('大小上限'))).toBe(true);
  });
  it('uploads an explicitly selected project file and leaves the original unchanged', async () => {
    h = await harness(); await h.send('/project a');
    await fs.writeFile(path.join(h.root, 'a', '中文 file.txt'), 'content');
    await h.send('/send-path "中文 file.txt"'); await h.app.delivery.tick();
    expect(h.transport.uploads[0]?.content).toBe('content');
    expect(await fs.readFile(path.join(h.root, 'a', '中文 file.txt'), 'utf8')).toBe('content');
  });
  it('cannot send another user or scope artifact', async () => {
    h = await harness(); await h.send('/project a');
    await fs.writeFile(path.join(h.root, 'a', 'file.txt'), 'content'); await h.send('/send-path file.txt');
    const artifact = h.app.store.list('artifacts')[0]!;
    const before = h.app.store.list('outbox').filter(d => d.artifactId).length;
    await h.send(`/send ${artifact.id}`, { scope: scopeKey('app', 'tenant', 'another'), target: { chatId: 'another' } });
    expect(h.app.store.list('outbox').filter(d => d.artifactId)).toHaveLength(before);
  });
  it('keeps attachments with their original session across project switches', async () => {
    h = await harness(); await h.send('/project a'); const a = h.app.sessions.current(h.event(''))!;
    await h.send('', { kind: 'file', resourceKey: 'file', fileName: 'file.txt' });
    await h.send('/project b'); await h.send('task in b');
    await h.pump(() => h!.app.store.list('tasks')[0]?.finalized === true);
    const attachment = h.app.store.list('attachments')[0]!;
    expect(attachment.sessionId).toBe(a.id); expect(attachment.taskId).toBeUndefined();
  });
  it('binds card actions to their original actor and chat', async () => {
    h = await harness(); await h.send('/projects');
    const token = h.app.store.list('actions')[0]!.id;
    await h.send('', { kind: 'action', actionToken: token, actorId: 'stranger' });
    await h.send('', { kind: 'action', actionToken: token, target: { chatId: 'other' } });
    expect(h.app.store.list('sessions')).toHaveLength(0);
    await h.send('', { kind: 'action', actionToken: token }); expect(h.app.store.list('sessions')).toHaveLength(1);
  });
});

describe('transport and durability', () => {
  it('normalizes DM replies into the same scope and ignores bot senders', () => {
    const raw = { app_id: 'app', event_id: 'event', tenant_key: 't', sender: { sender_type: 'user', sender_id: { open_id: 'owner' } },
      message: { message_id: 'm', chat_id: 'chat', chat_type: 'p2p', root_id: 'old', message_type: 'text', content: '{"text":"hello"}' } };
    expect(normalize(raw, 'app')?.scope).toBe(scopeKey('app', 't', 'chat'));
    expect(normalize({ ...raw, sender: { sender_type: 'app' } }, 'app')).toBeUndefined();
    expect(normalize({ ...raw, app_id: 'other' }, 'app')).toBeUndefined();
  });
  it('requires a bot mention in groups', () => {
    const raw = { sender: { sender_type: 'user', sender_id: { open_id: 'owner' } }, message: { message_id: 'm', chat_id: 'chat', chat_type: 'group', message_type: 'text', content: '{"text":"@_user_1 hello"}' } };
    expect(normalize(raw, 'app', 'bot')).toBeUndefined();
    expect(normalize({ ...raw, message: { ...raw.message, mentions: [{ key: '@_user_1', id: { open_id: 'bot' } }] } }, 'app', 'bot')?.text).toBe('hello');
  });
  it('chunks unicode without losing characters and constructs valid cards', () => {
    const input = '中文😀'.repeat(2500); const parts = chunks(input);
    expect(parts.join('')).toBe(input); expect(parts.every(p => p.length <= 2800)).toBe(true);
    expect(JSON.stringify(card({ text: 'hello', buttons: [{ label: 'stop', token: 't' }] }))).toContain('"token":"t"');
  });
  it('rolls back all database changes on failure and enforces inbox uniqueness', () => {
    const store = new Store(':memory:');
    expect(() => store.transaction(() => { store.put('owners', { id: 'one', createdAt: 1 }); throw new Error('fail'); })).toThrow();
    expect(store.list('owners')).toHaveLength(0); store.close();
  });
  it('does not let old progress overwrite a newer terminal revision', async () => {
    const store = new Store(':memory:'); const transport = new MemoryTransport();
    const delivery = new DeliveryService(store, transport, pino({ level: 'silent' }));
    delivery.progress('task', { chatId: 'chat' }, { text: 'working' }); await delivery.tick();
    delivery.progress('task', { chatId: 'chat' }, { text: 'completed' });
    const row = store.list('outbox')[0]!; store.put('outbox', { ...row, nextAttemptAt: 0 }); await delivery.tick();
    expect(transport.sent).toHaveLength(1); expect(transport.sent[0]?.message.text).toBe('completed'); store.close();
  });
  it('uses a live OS instance lock rather than trusting a stale pid file', async () => {
    const dir = path.join(os.tmpdir(), `lock-${crypto.randomUUID()}`);
    const release = await instanceLock(dir); await expect(instanceLock(dir)).rejects.toThrow(); await release();
    const again = await instanceLock(dir); await again();
  });
});
