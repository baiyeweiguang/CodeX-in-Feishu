import type { Logger } from 'pino';
import type { Config } from '../config/load.js';
import { Store } from '../adapters/persistence/database.js';
import { CodexPool, type CodexClient, type RpcEvent } from '../adapters/codex/client.js';
import { active, id, now, short, terminal, UserError, type Envelope, type Task } from '../domain/models.js';
import { ArtifactService } from './artifact-service.js';
import { DeliveryService } from './delivery-service.js';
import { InteractionService } from './interaction-service.js';
import { SessionService } from './session-service.js';

interface Running {
  taskId: string; client: CodexClient; done: () => void; chain: Promise<void>;
  stopTimer?: NodeJS.Timeout; finalizing: boolean; onEvent: (event: RpcEvent) => void;
  onDisconnect: (error: Error) => void;
}
export class TaskService {
  private running = new Map<string, Running>();
  private quarantined = new Set<string>();
  private reservations = new Set<string>();
  private lastProject = '';
  private closing = false;
  private launches = new Set<Promise<void>>();
  constructor(private config: Config, private store: Store, private sessions: SessionService,
    readonly pool: CodexPool, private files: ArtifactService, private delivery: DeliveryService,
    readonly interactions: InteractionService, private logger: Logger) {}

  create(event: Envelope): Task {
    const session = this.sessions.require(event);
    const existing = this.store.list('tasks', { inboxId: event.id })[0];
    if (existing) return existing;
    const task: Task = { id: id(), inboxId: event.id, sessionId: session.id, projectId: session.projectId,
      project: this.sessions.project(session.projectId), actorId: event.actorId, scope: event.scope,
      target: event.target, prompt: event.text, state: 'queued', createdAt: now() };
    this.store.transaction(() => {
      this.store.put('tasks', task);
      for (const attachment of this.store.list('attachments', { sessionId: session.id })) {
        if (!attachment.taskId && attachment.state !== 'expired' && attachment.state !== 'failed') this.store.put('attachments', { ...attachment, taskId: task.id });
      }
      this.delivery.progress(task.id, task.target, { title: `${task.project.alias} / ${short(task.id)}`,
        text: `任务已入队。对话 ${short(session.id)}${session.queuePaused ? '\n此对话队列已暂停，请使用 /continue。' : ''}`,
        buttons: [this.interactions.button(task, '停止', `/stop ${task.id}`)] });
    }); return task;
  }
  find(event: Envelope, prefix?: string): Task {
    const records = this.store.list('tasks', { actorId: event.actorId, scope: event.scope });
    if (prefix) {
      const matches = records.filter(t => t.id.startsWith(prefix));
      if (matches.length !== 1) throw new UserError('任务 ID 不存在或不唯一。'); return matches[0]!;
    }
    const session = this.sessions.require(event);
    const tasks = records.filter(t => t.sessionId === session.id);
    const task = tasks.find(t => active(t.state)) ?? tasks.filter(t => t.state === 'queued')[0] ?? tasks.at(-1);
    if (!task) throw new UserError('当前对话还没有任务。'); return task;
  }
  status(task: Task): string {
    const deliveries = this.store.list('outbox', { taskId: task.id });
    const pending = deliveries.filter(d => d.state !== 'sent').length;
    const failed = deliveries.filter(d => d.state === 'failed').length;
    return `项目：${task.project.alias}\n对话：${short(task.sessionId)}\n任务：${short(task.id)}\n状态：${task.state}` +
      `\n阶段：${task.stage ?? '-'}\n耗时：${Math.round(((task.completedAt ?? now()) - (task.startedAt ?? task.createdAt)) / 1000)} 秒` +
      `\n待交付：${pending}，发送失败：${failed}` + (task.error ? `\n错误：${task.error}` : '') +
      (this.quarantined.has(task.projectId) ? '\n工作区已隔离，请运行 doctor 检查进程后重启服务。' : '');
  }
  tick(): void {
    if (this.closing) return;
    for (const interaction of this.store.list('interactions').filter(r => r.state === 'pending' || r.state === 'responding')) if (interaction.expiresAt < now()) {
      const task = this.store.get('tasks', interaction.taskId);
      if (task && !terminal(task.state)) void this.stop(task).catch(error => this.logger.error({ error }, 'Interaction timeout stop failed'));
    }
    const queued = this.store.list('tasks', { state: 'queued' }).filter(t => !this.store.get('sessions', t.sessionId)?.queuePaused && !this.busy(t.projectId) && !this.quarantined.has(t.projectId));
    const projectOrder = [...new Set(queued.map(t => t.projectId))];
    const index = projectOrder.indexOf(this.lastProject);
    const fairOrder = index >= 0 ? [...projectOrder.slice(index + 1), ...projectOrder.slice(0, index + 1)] : projectOrder;
    for (const projectId of fairOrder) {
      if (this.running.size >= this.config.scheduler.globalConcurrency) break;
      const task = queued.find(t => t.projectId === projectId)!;
      this.lastProject = projectId;
      const promise = this.launch(task).catch(error => this.logger.error({ error, taskId: task.id }, 'Task launch failed'));
      this.launches.add(promise); void promise.finally(() => this.launches.delete(promise));
    }
    void this.pool.reap(new Set(this.running.keys())).catch(error => this.logger.warn({ error }, 'Idle process cleanup failed'));
  }
  private async launch(task: Task): Promise<void> {
    const client = this.pool.get(task.project);
    let release!: () => void;
    const completed = new Promise<void>(resolve => { release = resolve; });
    const rt: Running = { taskId: task.id, client, done: release, chain: Promise.resolve(), finalizing: false,
      onEvent: event => { rt.chain = rt.chain.then(() => this.onEvent(rt, event)).catch(error => this.failRuntime(rt, error as Error)); },
      onDisconnect: error => { rt.chain = rt.chain.then(() => this.failRuntime(rt, error)); } };
    this.running.set(task.projectId, rt);
    client.on('event', rt.onEvent); client.on('disconnect', rt.onDisconnect);
    try {
      const configured = this.sessions.project(task.projectId);
      if (configured.root !== task.project.root) throw new UserError('项目目录已改变，此任务未执行。');
      this.store.put('tasks', { ...task, state: 'preparing', startedAt: now(), generation: client.generation, stage: '准备工作区' });
      const session = this.store.get('sessions', task.sessionId)!;
      const threadId = await client.ensureThread(session);
      this.store.put('sessions', { ...this.store.get('sessions', session.id)!, threadId });
      let current = this.store.get('tasks', task.id)!;
      this.store.put('tasks', { ...current, threadId });
      if (current.cancelRequested || terminal(current.state)) { await this.finish(rt, 'cancelled'); return; }
      const prepared = await this.files.prepare(current);
      current = this.store.get('tasks', task.id)!;
      if (current.cancelRequested || terminal(current.state)) { await this.finish(rt, 'cancelled'); return; }
      this.store.put('tasks', { ...current, state: 'starting', exportsPath: prepared.exportsPath, stage: '等待 Codex 开始' });
      const turn = await client.startTurn(threadId, prepared.text, task.id, prepared.images);
      current = this.store.get('tasks', task.id)!;
      if (!terminal(current.state)) this.store.put('tasks', { ...current, turnId: turn.id,
        state: current.state === 'starting' ? 'running' : current.state, stage: '执行中' });
      if (current.cancelRequested && !terminal(current.state)) await client.interrupt(threadId, turn.id);
      await completed;
    } catch (error) {
      await this.failRuntime(rt, error as Error);
    } finally {
      if (rt.stopTimer) clearTimeout(rt.stopTimer);
      client.off('event', rt.onEvent); client.off('disconnect', rt.onDisconnect);
      this.running.delete(task.projectId);
    }
  }
  private async failRuntime(rt: Running, error: Error): Promise<void> {
    const task = this.store.get('tasks', rt.taskId);
    if (!task || rt.finalizing) return;
    this.logger.warn({ taskId: task.id, error: error.message }, 'Codex task interrupted');
    try { await this.pool.stop(task.projectId); }
    catch { this.quarantined.add(task.projectId); }
    await this.finish(rt, task.state === 'preparing' || task.state === 'queued' ? 'failed' : 'interrupted_unknown', error.message);
  }
  private async onEvent(rt: Running, event: RpcEvent): Promise<void> {
    const task = this.store.get('tasks', rt.taskId);
    if (!task || terminal(task.state) || rt.finalizing) {
      if (event.id !== undefined) rt.client.reject(event.id, 'No active task for this request'); return;
    }
    const p = event.params;
    if (p.threadId && task.threadId && p.threadId !== task.threadId) return;
    if (event.id !== undefined) { this.interactions.create(task, event, rt.client); return; }
    if (p.turnId && task.turnId && p.turnId !== task.turnId) return;
    if (event.method === 'turn/started') {
      this.store.put('tasks', { ...task, turnId: p.turn.id, state: task.cancelRequested ? 'stopping' : 'running', stage: '执行中' });
      this.progress(this.store.get('tasks', task.id)!);
    } else if (event.method === 'item/agentMessage/delta') {
      const streamText = (task.streamItemId === p.itemId ? task.streamText ?? '' : '') + String(p.delta ?? '');
      this.store.put('tasks', { ...task, streamItemId: p.itemId, streamText,
        streamPhase: task.streamItemId === p.itemId ? task.streamPhase : undefined });
      this.progress(this.store.get('tasks', task.id)!);
    } else if (event.method === 'item/started' || event.method === 'item/completed') {
      const item = p.item;
      if (!item) return;
      if (item.type === 'agentMessage' && event.method === 'item/started') {
        this.store.put('tasks', { ...task, streamItemId: item.id, streamPhase: item.phase, streamText: '' });
      }
      if (item.type === 'agentMessage' && event.method === 'item/completed') {
        if (item.phase === 'final_answer' || item.phase === null || item.phase === undefined)
          this.store.put('tasks', { ...task, result: item.text, streamText: item.text, streamPhase: item.phase });
        else {
          this.store.put('tasks', { ...task, stage: '处理中', streamText: '', streamPhase: 'commentary' });
          this.store.put('task_events', { id: `${task.id}:${item.id}`, taskId: task.id, kind: 'commentary',
            summary: String(item.text).slice(0, 500), createdAt: now() });
        }
      } else if (['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'].includes(item.type)) {
        const stage = item.type === 'commandExecution' ? '执行命令' : item.type === 'fileChange' ? '修改文件' : item.type === 'webSearch' ? '检索资料' : '调用工具';
        const detail = item.type === 'commandExecution' ? String(item.command).slice(0, 500) :
          item.type === 'fileChange' ? (item.changes ?? []).map((c: { path: string }) => c.path).join('\n').slice(0, 500) : String(item.tool ?? '');
        const summary = `${stage} · ${event.method === 'item/completed' ? item.status ?? '已结束' : '进行中'}\n${detail}`;
        this.store.transaction(() => { this.store.put('tasks', { ...task, stage });
          const eventId = `${task.id}:${item.id}`;
          this.store.put('task_events', { id: eventId, taskId: task.id, kind: item.type, summary,
            createdAt: this.store.get('task_events', eventId)?.createdAt ?? now() }); });
      }
      this.progress(this.store.get('tasks', task.id)!);
    } else if (event.method === 'serverRequest/resolved') this.interactions.resolveServerRequest(task.id, p.requestId);
    else if (event.method === 'turn/completed') {
      const turn = p.turn;
      if (task.turnId && turn.id !== task.turnId) return;
      this.store.put('tasks', { ...task, turnId: turn.id });
      const state = turn.status === 'completed' ? 'succeeded' : turn.status === 'interrupted' ? 'cancelled' : 'failed';
      if (task.cancelRequested || state === 'cancelled') {
        try { await this.pool.stop(task.projectId); } catch { this.quarantined.add(task.projectId); }
      }
      await this.finish(rt, state, turn.error?.message);
    } else if (event.method === 'error' && !p.willRetry) {
      this.logger.warn({ taskId: task.id, code: p.error?.codexErrorInfo }, 'Codex reported error');
    }
  }
  private progress(task: Task): void {
    if (this.interactions.refresh(task.id)) return;
    this.delivery.progress(task.id, task.target, { title: `${task.project.alias} / ${short(task.id)}`,
      text: ((task.streamPhase !== 'commentary' ? task.streamText : '') || `${task.state}\n${task.stage ?? ''}`).slice(0, 6000),
      details: this.delivery.history(task.id), buttons: terminal(task.state) ? [] : [this.interactions.button(task, '停止', `/stop ${task.id}`)] });
  }
  private async finish(rt: Running, state: Task['state'], error?: string): Promise<void> {
    if (rt.finalizing) return;
    rt.finalizing = true;
    if (rt.stopTimer) clearTimeout(rt.stopTimer);
    const task = this.store.get('tasks', rt.taskId)!;
    const final: Task = { ...task, state, error, completedAt: now(), stage: state === 'succeeded' ? '执行完成' : state };
    this.store.transaction(() => {
      this.store.put('tasks', final); this.interactions.expire(task.id);
      if (state !== 'succeeded') { const session = this.store.get('sessions', task.sessionId)!; this.store.put('sessions', { ...session, queuePaused: true }); }
    });
    try { await this.finalize(final); } finally { rt.done(); }
  }
  private async finalize(task: Task): Promise<void> {
    let artifacts = this.store.list('artifacts', { taskId: task.id }); let warnings: string[] = [];
    let response = task.result || '任务完成。';
    if (task.state === 'succeeded') {
      try { ({ artifacts, warnings } = await this.files.collect(task)); }
      catch (error) { warnings = [`产物收集失败：${(error as Error).message}`]; }
    }
    if (response.length > 5000) {
      try {
        const full = await this.files.saveResponse(task, response);
        artifacts = [full, ...artifacts.filter(a => a.id !== full.id)];
        response = Array.from(response).slice(0, 4500).join('') + '\n\n完整回复见下方文件。';
      } catch (error) {
        warnings.push(`完整回复文件保存失败：${(error as Error).message}`);
        // Preserve all output when a full-response artifact cannot be stored.
        this.delivery.text(`result-overflow:${task.id}`, task.target, { text: response }, task.id);
        response = '回复较长，已分段发送。';
      }
    }
    this.store.transaction(() => {
      const buttons = artifacts.filter(a => a.state === 'ready').slice(0, 5).map(a => this.interactions.button(task, `发送 ${a.name.slice(0, 20)}`, `/send ${a.id}`));
      const text = `${task.state === 'succeeded' ? response : `任务状态：${task.state}\n${task.error ?? '任务已停止；已完成的文件修改不会回滚。'}`}` +
        (artifacts.length ? '\n\n文件：\n' + artifacts.map(a => `${short(a.id)}  ${a.name} (${a.size} bytes)`).join('\n') : '') +
        (warnings.length ? '\n\n' + warnings.join('\n') : '');
      this.delivery.progress(task.id, task.target, { title: `${task.project.alias} / ${short(task.id)}`, text, buttons, streamDone: true, details: this.delivery.history(task.id) });
      if (task.project.autoSendExports) for (const artifact of artifacts) this.delivery.enqueue(`auto-file:${artifact.id}`, task.target, { text: artifact.name }, task.id, artifact.id);
      this.store.put('tasks', { ...task, finalized: true });
    });
  }
  async stop(task: Task): Promise<void> {
    task = this.store.get('tasks', task.id)!;
    const session = this.store.get('sessions', task.sessionId)!;
    this.store.put('sessions', { ...session, queuePaused: true });
    if (terminal(task.state)) return;
    if (task.state === 'queued') {
      const cancelled: Task = { ...task, state: 'cancelled', completedAt: now() };
      this.store.put('tasks', cancelled); await this.finalize(cancelled); return;
    }
    this.store.put('tasks', { ...task, cancelRequested: true, state: 'stopping', stage: '正在停止' });
    this.interactions.expire(task.id);
    this.progress(this.store.get('tasks', task.id)!);
    const rt = this.running.get(task.projectId);
    if (!rt || rt.taskId !== task.id) return;
    if (!rt.stopTimer) rt.stopTimer = setTimeout(() => {
      void this.pool.stop(task.projectId).then(() => this.finish(rt, 'cancelled'))
        .catch(async error => { this.quarantined.add(task.projectId); await this.finish(rt, 'interrupted_unknown', String(error)); });
    }, 10000);
    if (task.threadId && task.turnId) await rt.client.interrupt(task.threadId, task.turnId);
  }
  async steer(task: Task, text: string): Promise<void> {
    const rt = this.running.get(task.projectId);
    if (!rt || rt.taskId !== task.id || !task.threadId || !task.turnId || task.state !== 'running') throw new UserError('当前没有可补充指令的执行中任务。');
    await rt.client.steer(task.threadId, task.turnId, text);
  }
  client(task: Task): CodexClient {
    const rt = this.running.get(task.projectId);
    if (!rt || rt.taskId !== task.id) throw new UserError('任务当前未连接到 Codex。'); return rt.client;
  }
  busy(projectId: string): boolean { return this.running.has(projectId) || this.reservations.has(projectId); }
  reserve(projectId: string): () => void {
    if (this.busy(projectId) || this.quarantined.has(projectId)) throw new UserError('项目正在执行任务或被隔离，请结束后再发送现有文件。');
    this.reservations.add(projectId); return () => this.reservations.delete(projectId);
  }
  async recover(): Promise<void> {
    for (const row of this.store.list('interactions')) if (row.state === 'pending' || row.state === 'responding') this.store.put('interactions', { ...row, state: 'expired' });
    for (const task of this.store.list('tasks')) {
      if (terminal(task.state)) { if (!task.finalized) await this.finalize(task); continue; }
      if (task.state === 'queued') continue;
      if (task.state === 'preparing' && !task.cancelRequested) { this.store.put('tasks', { ...task, state: 'queued' }); continue; }
      let state: Task['state'] = 'interrupted_unknown'; let result = task.result;
      if (task.threadId && task.turnId) {
        try {
          const thread = await this.pool.get(task.project).readThread(task.threadId);
          const turn = thread.turns.find(t => t.id === task.turnId);
          if (turn && ['completed', 'failed', 'interrupted'].includes(turn.status)) {
            state = turn.status === 'completed' ? 'succeeded' : turn.status === 'failed' ? 'failed' : 'cancelled';
            result = turn.items.filter(i => i.type === 'agentMessage').map(i => i.type === 'agentMessage' ? i.text : '').join('\n');
          }
        } catch (error) { this.logger.warn({ taskId: task.id, error: (error as Error).message }, 'Recovery could not read thread'); }
      }
      const final: Task = { ...task, state, result, completedAt: now(), error: state === 'interrupted_unknown' ? '服务中断，无法确认上一轮是否已执行。请检查文件后发送新的继续指令。' : undefined };
      this.store.transaction(() => {
        this.store.put('tasks', final);
        const session = this.store.get('sessions', task.sessionId)!;
        this.store.put('sessions', { ...session, queuePaused: state !== 'succeeded' || session.queuePaused });
      });
      await this.finalize(final);
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const rt of this.running.values()) {
      const task = this.store.get('tasks', rt.taskId)!;
      try { await this.pool.stop(task.projectId); } catch (error) { this.logger.error({ error }, 'Process cleanup failed'); }
      await this.finish(rt, 'interrupted_unknown', '服务关闭，未自动重跑任务。');
    }
    await Promise.allSettled([...this.launches]); await this.pool.close();
  }
}
