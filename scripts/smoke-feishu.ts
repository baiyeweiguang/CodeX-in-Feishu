import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config/load.js';
import { makeLogger } from '../src/observability/logger.js';
import { FeishuTransport } from '../src/adapters/feishu/client.js';

const config = loadConfig();
const client = new FeishuTransport(config, makeLogger(config.appSecret));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'connector-feishu-smoke-'));
const report: Record<string, unknown> = {};
try {
  report.identity = await client.checkIdentity();
  try {
    const file = path.join(root, 'connector-smoke.txt');
    await fs.writeFile(file, 'CodexConnector file API smoke test. No user data.\n');
    const uploaded = await client.upload(file, 'connector-smoke.txt');
    const downloaded = await client.client.im.file.get({ path: { file_key: uploaded.key } });
    const destination = path.join(root, 'downloaded.txt');
    await downloaded.writeFile(destination);
    report.fileRoundtrip = (await fs.readFile(destination, 'utf8')) === (await fs.readFile(file, 'utf8'));
  } catch (error) { report.fileRoundtrip = { error: (error as Error).message }; }
  try {
    await client.connect(() => { /* No chat messages are handled by this diagnostic. */ });
    report.websocket = client.status();
  } catch (error) { report.websocket = { error: (error as Error).message }; }
  console.log(JSON.stringify(report, null, 2));
} finally { client.close(); await fs.rm(root, { recursive: true, force: true }); }
