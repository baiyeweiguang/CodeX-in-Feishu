import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config/load.js';
import { id, now, UserError, type Envelope, type Project, type Session } from '../domain/models.js';
import { Store } from '../adapters/persistence/database.js';

const key = (...parts: string[]) => JSON.stringify(parts);
export class SessionService {
  constructor(readonly config: Config, readonly store: Store) {}
  authorized(event: Envelope): boolean {
    return (this.config.feishu.allowedOpenIds.includes(event.actorId) || Boolean(this.store.get('owners', event.actorId))) &&
      (!event.isGroup || (this.config.feishu.groupsEnabled && this.config.feishu.allowedChatIds.includes(event.target.chatId)));
  }
  makePairing(): string {
    const code = randomBytes(32).toString('hex');
    this.savePairing(code);
    return code;
  }
  private savePairing(code: string): void {
    this.store.put('pairing', { id: 'owner', hash: createHash('sha256').update(code).digest('hex'), expiresAt: null });
  }
  revokePairing(): void {
    // Keep a tombstone so a restart cannot recreate a deliberately revoked key.
    this.store.put('pairing', { id: 'owner', hash: '', revoked: true, expiresAt: null });
  }
  async pairingFile(rotate = false): Promise<string | undefined> {
    const file = path.join(this.config.dataDir, 'pairing-code.txt');
    const record = this.store.get('pairing', 'owner');
    if (!rotate && record?.revoked) { await fs.rm(file, { force: true }); return; }
    let saved: string | undefined;
    try { saved = /^\/pair ([a-f0-9]{16}|[a-f0-9]{64})\s*$/.exec(await fs.readFile(file, 'utf8'))?.[1]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!rotate && saved && (!record || record.hash === createHash('sha256').update(saved).digest('hex'))) {
      // Migrate the old key, including a key already consumed by pairing.
      this.savePairing(saved); return file;
    }
    if (!rotate && record) {
      this.store.put('pairing', { ...record, expiresAt: null }); return;
    }
    const code = this.makePairing();
    await fs.mkdir(this.config.dataDir, { recursive: true });
    await fs.writeFile(file, `/pair ${code}\n`, { mode: 0o600 });
    return file;
  }
  pair(event: Envelope, code: string): void {
    if (event.isGroup) throw new UserError('请在机器人私聊中配对。');
    const record = this.store.get('pairing', 'owner');
    const digest = createHash('sha256').update(code).digest();
    if (!record || record.revoked || !timingSafeEqual(digest, Buffer.from(record.hash, 'hex'))) throw new UserError('配对码无效或已撤销。');
    this.store.transaction(() => {
      this.store.put('owners', { id: event.actorId, createdAt: now() });
    });
  }
  current(event: Pick<Envelope, 'scope' | 'actorId'>): Session | undefined {
    const pref = this.store.get('preferences', key(event.scope, event.actorId));
    if (!pref) return;
    const cursor = this.store.get('cursors', key(event.scope, event.actorId, pref.projectId));
    return cursor ? this.store.get('sessions', cursor.sessionId) : undefined;
  }
  require(event: Pick<Envelope, 'scope' | 'actorId'>): Session {
    const session = this.current(event);
    if (!session) throw new UserError('请先使用 /projects 或 /project <项目别名> 选择项目。');
    const project = this.project(session.projectId);
    if (project.root !== session.cwd) throw new UserError('项目路径已改变，请创建新对话。');
    return session;
  }
  project(projectId: string): Project {
    const project = this.config.projects.find(p => p.id === projectId);
    if (!project) throw new UserError('项目已移除或不可用。'); return project;
  }
  select(event: Envelope, alias: string): Session {
    const project = this.config.projects.find(p => p.alias === alias);
    if (!project) throw new UserError('找不到项目别名，请使用 /projects 查看。');
    return this.store.transaction(() => {
      this.store.put('preferences', { id: key(event.scope, event.actorId), actorId: event.actorId, scope: event.scope, projectId: project.id });
      const cursor = this.store.get('cursors', key(event.scope, event.actorId, project.id));
      const old = cursor ? this.store.get('sessions', cursor.sessionId) : undefined;
      return old?.cwd === project.root ? old : this.create(event, project, project.alias);
    });
  }
  create(event: Pick<Envelope, 'scope' | 'actorId'>, project: Project, title: string, sessionId: string = id()): Session {
    const existing = this.store.get('sessions', sessionId);
    const session: Session = existing ?? { id: sessionId, actorId: event.actorId, scope: event.scope, projectId: project.id,
      cwd: project.root, title: title.slice(0, 120), queuePaused: false, createdAt: now() };
    this.store.transaction(() => {
      this.store.put('sessions', session);
      this.store.put('cursors', { id: key(event.scope, event.actorId, project.id), actorId: event.actorId, scope: event.scope, projectId: project.id, sessionId: session.id });
    }); return session;
  }
  use(event: Envelope, prefix: string): Session {
    const current = this.require(event);
    const sessions = this.store.list('sessions', { scope: event.scope, actorId: event.actorId, projectId: current.projectId }).filter(s => s.id.startsWith(prefix));
    if (!prefix || sessions.length !== 1) throw new UserError('对话 ID 不存在或不唯一。');
    const session = sessions[0]!;
    if (session.cwd !== this.project(session.projectId).root) throw new UserError('旧对话路径与配置不一致，请新建对话。');
    this.store.put('cursors', { id: key(event.scope, event.actorId, session.projectId), scope: event.scope, actorId: event.actorId, projectId: session.projectId, sessionId: session.id });
    return session;
  }
}
