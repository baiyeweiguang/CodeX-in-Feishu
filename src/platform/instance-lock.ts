import { createServer, type Server } from 'node:net';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export async function instanceLock(dataDir: string): Promise<() => Promise<void>> {
  const hash = createHash('sha256').update(path.resolve(dataDir).toLowerCase()).digest('hex').slice(0, 24);
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\codex-connector-${hash}` : path.join(os.tmpdir(), `codex-connector-${hash}.sock`);
  const server: Server = createServer(connection => connection.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', () => reject(new Error('Another connector instance is using this data directory')));
    server.listen(socket, resolve);
  });
  return () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
