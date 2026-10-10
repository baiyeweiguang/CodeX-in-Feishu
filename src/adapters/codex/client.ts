import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Config } from '../../config/load.js';
import type { Project, Session } from '../../domain/models.js';
import { guardProcess } from '../../platform/process-tree.js';
import type { ThreadStartParams } from './generated/v2/ThreadStartParams.js';
import type { TurnStartParams } from './generated/v2/TurnStartParams.js';
import type { Thread } from './generated/v2/Thread.js';
import type { Turn } from './generated/v2/Turn.js';

export interface RpcEvent { method: string; params: Record<string, any>; id?: string | number; generation: string }
export class RpcError extends Error { constructor(message: string, readonly code?: number) { super(message); } }
export class CodexClient extends EventEmitter {
  readonly generation = randomUUID();
  lastUsed = Date.now();
  private child?: ChildProcessWithoutNullStreams;
  private stopTree?: () => Promise<void>;
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private loaded = new Set<string>();
  private closing = false;
  private cleanup?: Promise<void>;
  private started?: Promise<void>;
  constructor(readonly project: Project, private config: Config['codex'], private logger: Logger,
    private launch?: { executable: string; args: string[] }) { super(); }

  start(): Promise<void> { return this.started ??= this.launchProcess(); }
  private async launchProcess(): Promise<void> {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(FEISHU_|CONNECTOR_|CODEX_THREAD_ID$|CODEX_INTERNAL_)/.test(key)));
    this.child = spawn(this.launch?.executable ?? this.config.executable,
      this.launch?.args ?? ['app-server', '--listen', 'stdio://'],
      { cwd: this.project.root, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const child = this.child;
    child.on('error', error => this.disconnected(error));
    child.on('exit', (code, signal) => this.disconnected(new Error(`Codex exited: ${code ?? signal}`)));
    child.stdin.on('error', error => this.disconnected(error));
    child.stderr.on('data', (buffer: Buffer) => this.logger.debug({ project: this.project.id, stderr: buffer.toString().slice(0, 2000) }, 'Codex stderr'));
    const decoder = new StringDecoder('utf8'); let buffer = '';
    child.stdout.on('data', (part: Buffer) => {
      buffer += decoder.write(part);
      if (buffer.length > 16 * 1024 ** 2) { this.disconnected(new Error('Codex protocol frame too large')); void this.close(); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); }
        catch (error) { this.logger.error({ error }, 'Invalid Codex protocol frame'); this.disconnected(new Error('Invalid Codex protocol')); void this.close(); }
      }
    });
    try {
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      this.stopTree = await guardProcess(child);
      await this.request('initialize', { clientInfo: { name: 'codex_connector', title: 'CodexConnector', version: '0.1.0' },
        capabilities: { experimentalApi: true } });
      this.write({ method: 'initialized', params: {} });
    } catch (error) { await this.close(); throw error; }
  }
  private receive(message: any): void {
    if (typeof message.method === 'string') {
      this.emit('event', { method: message.method, params: message.params ?? {}, id: message.id, generation: this.generation } satisfies RpcEvent);
      return;
    }
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new RpcError(String(message.error.message), message.error.code));
    else request.resolve(message.result);
  }
  private write(message: unknown): void {
    if (!this.child || this.child.exitCode !== null || this.closing) throw new Error('Codex is not connected');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request<T = any>(method: string, params: unknown): Promise<T> {
    this.lastUsed = Date.now();
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex request timed out: ${method}`)); }, this.config.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  respond(id: string | number, result: unknown): void { this.write({ id, result }); }
  reject(id: string | number, message: string): void { this.write({ id, error: { code: -32601, message } }); }
  async ensureThread(session: Session): Promise<string> {
    await this.start();
    if (session.threadId && this.loaded.has(session.threadId)) return session.threadId;
    const common: ThreadStartParams = { cwd: session.cwd, sandbox: this.project.sandbox, approvalPolicy: 'on-request',
      approvalsReviewer: this.project.approvalsReviewer ?? 'user', model: this.project.model, serviceName: 'codex_connector' };
    const result = session.threadId
      ? await this.request<{ thread: Thread }>('thread/resume', { ...common, threadId: session.threadId })
      : await this.request<{ thread: Thread }>('thread/start', common);
    this.loaded.add(result.thread.id); return result.thread.id;
  }
  async startTurn(threadId: string, text: string, clientId: string, images: string[] = []): Promise<Turn> {
    const params: TurnStartParams = { threadId, clientUserMessageId: clientId,
      input: [{ type: 'text', text, text_elements: [] }, ...images.map(image => ({ type: 'localImage' as const, path: image }))] };
    return (await this.request<{ turn: Turn }>('turn/start', params)).turn;
  }
  async readThread(threadId: string): Promise<Thread> { await this.start(); return (await this.request<{ thread: Thread }>('thread/read', { threadId, includeTurns: true })).thread; }
  async interrupt(threadId: string, turnId: string): Promise<void> { await this.request('turn/interrupt', { threadId, turnId }); }
  async steer(threadId: string, turnId: string, text: string): Promise<void> {
    await this.request('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text, text_elements: [] }] });
  }
  private disconnected(error: Error): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); this.loaded.clear();
    if (!this.closing) {
      this.closing = true;
      void this.close().catch(cleanupError => this.logger.error({ error: cleanupError }, 'Codex process cleanup failed'));
      this.emit('disconnect', error);
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Codex closing')); }
    this.pending.clear();
    if (!this.cleanup) {
      if (this.stopTree) { const stop = this.stopTree; this.stopTree = undefined; this.cleanup = stop(); }
      else { this.child?.kill(); this.cleanup = Promise.resolve(); }
    }
    await this.cleanup;
    this.child?.stdin.destroy();
  }
}

export class CodexPool {
  private clients = new Map<string, CodexClient>();
  constructor(private config: Config, private logger: Logger, private factory?: (project: Project) => CodexClient) {}
  get(project: Project): CodexClient {
    let client = this.clients.get(project.id);
    if (!client) {
      client = this.factory?.(project) ?? new CodexClient(project, this.config.codex, this.logger);
      this.clients.set(project.id, client);
    }
    return client;
  }
  async stop(projectId: string): Promise<void> {
    const client = this.clients.get(projectId); if (!client) return;
    this.clients.delete(projectId); await client.close();
  }
  async reap(busy: Set<string>): Promise<void> {
    for (const [id, client] of this.clients) if (!busy.has(id) && Date.now() - client.lastUsed > this.config.codex.idleProcessMinutes * 60000) await this.stop(id);
  }
  async close(): Promise<void> { for (const id of [...this.clients.keys()]) await this.stop(id); }
}
