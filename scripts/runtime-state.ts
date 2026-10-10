import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config/load.js';

const config = loadConfig();
const db = new DatabaseSync(path.join(config.dataDir, 'connector.db'), { readOnly: true });
try {
  const tasks = db.prepare('SELECT state, count(*) AS count FROM tasks GROUP BY state').all();
  const owners = db.prepare('SELECT count(*) AS count FROM owners').get();
  const raw = db.prepare("SELECT data FROM pairing WHERE id='owner'").get() as { data: string } | undefined;
  const pairing = raw ? JSON.parse(raw.data) : undefined;
  const file = path.join(config.dataDir, 'pairing-code.txt');
  const code = fs.existsSync(file) ? /^\/pair (\S+)\s*$/.exec(fs.readFileSync(file, 'utf8'))?.[1] : undefined;
  console.log(JSON.stringify({ tasks, owners, pairing: { present: Boolean(pairing), revoked: pairing?.revoked === true,
    permanent: Boolean(pairing) && pairing.expiresAt == null,
    localFileMatches: Boolean(code && pairing?.hash === createHash('sha256').update(code).digest('hex')) } }, null, 2));
} finally { db.close(); }
