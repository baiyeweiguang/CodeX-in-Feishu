import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { Action, Artifact, Attachment, Cursor, Delivery, Inbox, Interaction, Owner, Pairing, Preference, Session, Task, TaskEvent } from '../../domain/models.js';

interface Tables {
  sessions: Session; tasks: Task; inbox: Inbox; outbox: Delivery; attachments: Attachment;
  artifacts: Artifact; interactions: Interaction; actions: Action; cursors: Cursor;
  preferences: Preference; owners: Owner; pairing: Pairing; task_events: TaskEvent;
}
type Table = keyof Tables;
const columns = ['state', 'actorId', 'scope', 'projectId', 'sessionId', 'taskId', 'createdAt', 'nextAttemptAt', 'dedupeKey', 'logicalKey', 'inboxId'] as const;
export class Store {
  readonly db: DatabaseSync;
  private depth = 0;
  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (version > 1) throw new Error('Database is newer than this connector');
    if (version === 0) this.transaction(() => {
      for (const table of ['sessions', 'tasks', 'inbox', 'outbox', 'attachments', 'artifacts', 'interactions', 'actions', 'cursors', 'preferences', 'owners', 'pairing', 'task_events']) {
        this.db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)),
          ${columns.map(c => `"${c}" GENERATED ALWAYS AS (json_extract(data, '$.${c}')) VIRTUAL`).join(',')});`);
        this.db.exec(`CREATE INDEX ${table}_state ON ${table}(state, createdAt);
          CREATE INDEX ${table}_scope ON ${table}(scope, actorId, projectId);
          CREATE INDEX ${table}_session ON ${table}(sessionId);
          CREATE INDEX ${table}_task ON ${table}(taskId);`);
      }
      this.db.exec(`CREATE UNIQUE INDEX inbox_dedupe ON inbox(dedupeKey);
        CREATE UNIQUE INDEX outbox_logical ON outbox(logicalKey);
        CREATE UNIQUE INDEX tasks_inbox ON tasks(inboxId);
        CREATE INDEX outbox_due ON outbox(state,nextAttemptAt);
        PRAGMA user_version=1;`);
    });
  }
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.depth++;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.depth--; }
  }
  get<K extends Table>(table: K, id: string): Tables[K] | undefined {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as Tables[K] : undefined;
  }
  list<K extends Table>(table: K, filter: Partial<Record<typeof columns[number], string | number>> = {}): Tables[K][] {
    const entries = Object.entries(filter);
    for (const [key] of entries) if (!columns.includes(key as typeof columns[number])) throw new Error('Invalid query field');
    const rows = this.db.prepare(`SELECT data FROM ${table} ${entries.length ? 'WHERE ' + entries.map(([key]) => `"${key}"=?`).join(' AND ') : ''} ORDER BY createdAt, rowid`)
      .all(...entries.map(([, value]) => value as SQLInputValue)) as { data: string }[];
    return rows.map(r => JSON.parse(r.data) as Tables[K]);
  }
  put<K extends Table>(table: K, row: Tables[K]): void {
    this.db.prepare(`INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(row.id, JSON.stringify(row));
  }
  remove(table: Table, id: string): void { this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id); }
  close(): void { this.db.close(); }
}
