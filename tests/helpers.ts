import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import type { Config } from '../src/config/load.js';
import { id, scopeKey, type Envelope, type Message, type Target, type Transport } from '../src/domain/models.js';
import { CodexClient, CodexPool } from '../src/adapters/codex/client.js';
import { bootstrap } from '../src/bootstrap.js';

export class MemoryTransport implements Transport {
  streams: string[] = [];
  streamUpdates: { cardId: string; message: Message; revision: number }[] = [];
  async createStream(): Promise<string> { const cardId = id(); this.streams.push(cardId); return cardId; }
  async updateStream(cardId: string, message: Message, revision: number): Promise<void> {
    this.streamUpdates.push({ cardId, message: structuredClone(message), revision });
    const sent = this.sent.find(s => s.message.cardId === cardId);
    if (!sent) throw new Error('Missing stream card');
    sent.message = { ...structuredClone(message), cardId };
  }
  sent: { id: string; target: Target; message: Message }[] = [];
  uploads: { key: string; content: string; name: string }[] = [];
  downloadCount = 0; failSend = 0;
  async send(target: Target, message: Message): Promise<string> {
    if (this.failSend > 0) { this.failSend--; throw new Error('Simulated network failure'); }
    const remoteId = id(); this.sent.push({ id: remoteId, target, message: structuredClone(message) }); return remoteId;
  }
  async update(remoteId: string, message: Message): Promise<void> {
    const sent = this.sent.find(s => s.id === remoteId); if (!sent) throw new Error('Missing message'); sent.message = structuredClone(message);
  }
  async download(_messageId: string, _key: string, _kind: string, destination: string): Promise<void> {
    this.downloadCount++; await new Promise(resolve => setTimeout(resolve, 30)); await fs.writeFile(destination, 'INPUT_FILE');
  }
  async upload(file: string, name: string): Promise<{ key: string }> {
    const key = id(); this.uploads.push({ key, name, content: await fs.readFile(file, 'utf8') }); return { key };
  }
}
export async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'connector-test-'));
  await fs.mkdir(path.join(root, 'a')); await fs.mkdir(path.join(root, 'b'));
  const config: Config = {
    dataDir: path.join(root, 'data'), timezone: 'Asia/Shanghai', appId: 'app', appSecret: '', configPath: '',
    projects: ['a', 'b'].map(name => ({ id: name, alias: name, root: path.join(root, name), workspaceKey: path.join(root, name), sandbox: 'workspace-write', autoSendExports: false })),
    feishu: { allowedOpenIds: ['owner'], groupsEnabled: false, allowedChatIds: [] },
    codex: { executable: 'unused', expectedVersion: '0.144.1', requestTimeoutMs: 10000, idleProcessMinutes: 15 },
    scheduler: { globalConcurrency: 2, interactionTimeoutMinutes: 30 },
    files: { maxBytes: 1024 * 1024, maxArtifactsPerTask: 10, maxStorageBytes: 50 * 1024 * 1024, retentionDays: 7 },
  };
  const logger = pino({ level: 'silent' }); const transport = new MemoryTransport();
  const factory = () => new CodexPool(config, logger, project => new CodexClient(project, config.codex, logger,
    { executable: process.execPath, args: [fileURLToPath(new URL('fixtures/fake-codex.mjs', import.meta.url))] }));
  let app = await bootstrap(config, transport, logger, factory());
  const event = (text: string, overrides: Partial<Envelope> = {}): Envelope => ({
    id: id(), eventId: id(), messageId: id(), appId: 'app', tenantId: 'tenant', actorId: 'owner',
    scope: scopeKey('app', 'tenant', 'chat'), target: { chatId: 'chat', messageId: id() }, isGroup: false,
    kind: 'text', text, receivedAt: Date.now(), ...overrides,
  });
  return { root, config, transport, event, get app() { return app; },
    async send(text: string, overrides: Partial<Envelope> = {}) {
      const e = event(text, overrides); app.router.accept(e); await app.router.tick();
      const start = Date.now();
      while (app.store.get('inbox', e.id)?.state === 'pending') {
        if (Date.now() - start > 15000) throw new Error('Message routing timed out');
        await app.router.tick(); await new Promise(resolve => setTimeout(resolve, 5));
      }
      return e;
    },
    async pump(predicate: () => boolean, timeout = 18000) {
      const start = Date.now();
      while (!predicate()) { if (Date.now() - start > timeout) throw new Error(`Timed out: ${JSON.stringify(app.store.list('tasks').map(t => ({ state: t.state, error: t.error, stage: t.stage })))}`);
        await app.tick(); await app.delivery.tick(); await new Promise(resolve => setTimeout(resolve, 20)); }
      await app.delivery.tick();
    },
    async restart() { await app.close(); app = await bootstrap(config, transport, logger, factory()); },
    async close() { await app.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); },
  };
}
