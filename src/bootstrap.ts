import path from 'node:path';
import fs from 'node:fs/promises';
import type { Logger } from 'pino';
import type { Config } from './config/load.js';
import type { Transport } from './domain/models.js';
import { Store } from './adapters/persistence/database.js';
import { CodexPool } from './adapters/codex/client.js';
import { DeliveryService } from './application/delivery-service.js';
import { ArtifactService } from './application/artifact-service.js';
import { SessionService } from './application/session-service.js';
import { InteractionService } from './application/interaction-service.js';
import { TaskService } from './application/task-service.js';
import { CommandRouter } from './application/command-router.js';

export async function bootstrap(config: Config, transport: Transport, logger: Logger, pool?: CodexPool) {
  const store = new Store(path.join(config.dataDir, 'connector.db'));
  const delivery = new DeliveryService(store, transport, logger);
  const files = new ArtifactService(config, store, transport);
  const sessions = new SessionService(config, store);
  const interactions = new InteractionService(config, store, delivery);
  const tasks = new TaskService(config, store, sessions, pool ?? new CodexPool(config, logger), files, delivery, interactions, logger);
  const router = new CommandRouter(store, sessions, tasks, files, delivery, logger);
  await files.init(); delivery.recover(); await tasks.recover();
  for (const row of store.list('attachments', { state: 'downloading' })) store.put('attachments', { ...row, state: 'pending' });
  let ticking = false; let timer: NodeJS.Timeout | undefined; let sendTimer: NodeJS.Timeout | undefined; let lastCleanup = 0;
  async function tick() {
    if (ticking) return; ticking = true;
    try { await router.tick(); tasks.tick();
      if (Date.now() - lastCleanup > 3600000) { lastCleanup = Date.now(); await files.cleanup(); }
    } catch (error) { logger.error({ error }, 'Service tick failed'); }
    finally { ticking = false; }
  }
  return { store, delivery, files, sessions, tasks, router, tick,
    start() { timer = setInterval(() => void tick(), 300); sendTimer = setInterval(() => void delivery.tick().catch(error => logger.error({ error }, 'Delivery tick failed')), 300); },
    async close() {
      if (timer) clearInterval(timer);
      if (sendTimer) clearInterval(sendTimer);
      await router.close(); await tasks.close(); await delivery.drain();
      while (ticking) await new Promise(resolve => setTimeout(resolve, 20));
      store.close();
    },
  };
}
