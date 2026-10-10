import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { loadConfig } from './config/load.js';
import { makeLogger } from './observability/logger.js';
import { FeishuTransport } from './adapters/feishu/client.js';
import { Store } from './adapters/persistence/database.js';
import { SessionService } from './application/session-service.js';
import { instanceLock } from './platform/instance-lock.js';
import { bootstrap } from './bootstrap.js';

const command = process.argv[2] ?? 'run';
const config = loadConfig();
const logger = makeLogger(config.appSecret);
async function main(): Promise<void> {
  if (command === 'config-check') { console.log(`Configuration OK: ${config.projects.length} project(s)`); return; }
  const transport = new FeishuTransport(config, logger);
  if (command === 'doctor') {
    const checks: Record<string, unknown> = { node: process.version, projects: config.projects.map(p => ({ alias: p.alias, root: p.root })), credentialsPresent: Boolean(config.appId && config.appSecret) };
    try { checks.codexVersion = (await promisify(execFile)(config.codex.executable, ['--version'], { windowsHide: true })).stdout.trim(); } catch { checks.codexVersion = 'unavailable'; }
    try { checks.codexLogin = (await promisify(execFile)(config.codex.executable, ['login', 'status'], { windowsHide: true })).stderr.trim() || 'available'; } catch { checks.codexLogin = 'unavailable'; }
    try { checks.feishu = await transport.checkIdentity(); } catch (error) { checks.feishu = (error as Error).message; }
    console.log(JSON.stringify(checks, null, 2)); return;
  }
  if (command === 'pair') {
    const store = new Store(path.join(config.dataDir, 'connector.db'));
    try {
      const sessions = new SessionService(config, store);
      const option = process.argv[3];
      if (option && !['--rotate', '--revoke'].includes(option)) throw new Error('Usage: pair [--rotate|--revoke]');
      if (option === '--revoke') sessions.revokePairing();
      const file = await sessions.pairingFile(option === '--rotate');
      console.log(file ? `Permanent pairing key: ${file}` : 'No pairing file available. Use pair --rotate to create a new key.');
    } finally { store.close(); }
    return;
  }
  if (command !== 'run') throw new Error('Usage: connector run | doctor | pair | config-check');
  if (!config.appId || !config.appSecret) throw new Error('Missing Feishu credentials');
  const version = (await promisify(execFile)(config.codex.executable, ['--version'], { windowsHide: true })).stdout.trim();
  if (!version.endsWith(config.codex.expectedVersion)) throw new Error(`Codex version mismatch: ${version}; expected ${config.codex.expectedVersion}`);
  const unlock = await instanceLock(config.dataDir);
  let app: Awaited<ReturnType<typeof bootstrap>> | undefined; let closed = false;
  let stopWatcher: NodeJS.Timeout | undefined;
  const stopFile = path.join(config.dataDir, 'stop-request');
  const close = async () => {
    if (closed) return; closed = true; if (stopWatcher) clearInterval(stopWatcher); transport.close();
    try { await app?.close(); } finally { await unlock(); }
  };
  try {
    app = await bootstrap(config, transport, logger);
    const pairingFile = await app.sessions.pairingFile();
    if (pairingFile) logger.info({ pairingFile }, 'Permanent pairing key available in local file');
    await transport.connect(event => app!.router.accept(event));
    await fs.rm(stopFile, { force: true });
    stopWatcher = setInterval(() => { void fs.access(stopFile).then(async () => {
      await fs.rm(stopFile, { force: true }); await close();
    }).catch(error => { if (error.code !== 'ENOENT') logger.error({ error }, 'Shutdown request failed'); }); }, 500);
    app.start(); logger.info({ projects: config.projects.map(p => p.alias) }, 'CodexConnector running');
    process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
  } catch (error) { await close(); throw error; }
}
main().catch(error => { logger.error({ error }, 'Connector failed'); process.exitCode = 1; });
