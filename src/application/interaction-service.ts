import type { Config } from '../config/load.js';
import Ajv from 'ajv';
import type { CodexClient, RpcEvent } from '../adapters/codex/client.js';
import { Store } from '../adapters/persistence/database.js';
import { id, now, short, terminal, UserError, type Button, type Envelope, type Interaction, type Task } from '../domain/models.js';
import { DeliveryService } from './delivery-service.js';

export class InteractionService {
  constructor(private config: Config, private store: Store, private delivery: DeliveryService) {}
  button(task: Pick<Task, 'actorId' | 'scope'>, label: string, command: string, primary = false): Button {
    const existing = this.store.list('actions', { actorId: task.actorId, scope: task.scope }).find(a => a.command === command && !a.used && a.expiresAt > now());
    if (existing) return { label, token: existing.id, primary };
    const token = id();
    this.store.put('actions', { id: token, actorId: task.actorId, scope: task.scope, command, used: false, expiresAt: now() + 86400000 });
    return { label, token, primary };
  }
  create(task: Task, event: RpcEvent, client: CodexClient): void {
    if (event.id === undefined) return;
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request'];
    if (!supported.includes(event.method)) { client.reject(event.id, 'This interaction is not supported by CodexConnector'); return; }
    const interaction: Interaction = { id: id(), taskId: task.id, actorId: task.actorId, scope: task.scope,
      generation: event.generation, requestId: event.id, method: event.method, params: event.params,
      state: 'pending', createdAt: now(), expiresAt: now() + this.config.scheduler.interactionTimeoutMinutes * 60000 };
    const isInput = event.method.includes('requestUserInput') || event.method.includes('elicitation');
    this.store.transaction(() => {
      this.store.put('interactions', interaction);
      this.store.put('tasks', { ...task, state: isInput ? 'waiting_input' : 'waiting_approval', stage: '等待你的回答' });
      const questions = Array.isArray(event.params.questions) ? event.params.questions.map((q: any) =>
        `${q.id}: ${q.question}\n${(q.options ?? []).map((o: any) => `${o.label}: ${o.description ?? ''}`).join('\n')}`).join('\n\n') : '';
      const description = questions || String(event.params.reason ?? event.params.message ?? event.params.command ?? 'Codex 请求权限');
      const command = event.params.command ? `\n命令：${String(event.params.command)}` : '';
      const details = event.params.permissions ? `\n请求权限：${JSON.stringify(event.params.permissions)}` : '';
      const network = event.params.networkApprovalContext ? `\n网络：${JSON.stringify(event.params.networkApprovalContext)}` : '';
      const location = event.params.cwd ? `\n目录：${event.params.cwd}` : '';
      const url = event.params.url ? `\n链接：${event.params.url}\n完成后 /answer ${short(interaction.id)} done` : '';
      const form = event.params.requestedSchema ? `\n表单结构：${JSON.stringify(event.params.requestedSchema)}` : '';
      const text = `任务 ${short(task.id)} / 请求 ${short(interaction.id)}\n${description}${command}${location}${details}${network}${url}${form}\n` +
        (isInput ? `回答：/answer ${short(interaction.id)} <回答>\n多问题或表单使用 JSON 对象。` : `允许本次：/approve ${short(interaction.id)}\n拒绝：/deny ${short(interaction.id)}`);
      const options = event.params.questions?.length === 1 ? event.params.questions[0]?.options ?? [] : [];
      const buttons = isInput ? options.slice(0, 5).map((o: any) => this.button(task, String(o.label).slice(0, 30), `/answer ${interaction.id} ${o.label}`))
        : [this.button(task, '允许本次', `/approve ${interaction.id}`, true), this.button(task, '拒绝', `/deny ${interaction.id}`)];
      this.store.put('interactions', { ...interaction, card: {
        text: `${isInput ? '需要回答' : '等待审批'} · ${short(interaction.id)}\n${description.slice(0, 180)}`,
        buttons, details: [{ title: isInput ? '问题详情' : '审批详情：命令、目录与权限', text }] } });
      this.refresh(task.id);
    });
  }
  refresh(taskId: string, force = false): boolean {
    const task = this.store.get('tasks', taskId);
    if (!task || terminal(task.state)) return false;
    const waiting = this.store.list('interactions', { taskId }).filter(r => r.state === 'pending' || r.state === 'responding');
    const request = waiting.find(r => r.state === 'pending');
    if (!waiting.length && !force) return false;
    this.delivery.progress(taskId, task.target, {
      title: `${task.project.alias} / ${short(taskId)}`,
      text: request?.card?.text ?? (waiting.length ? '回答已送出，等待 Codex 继续。' : '正在继续执行。'),
      interactionId: request?.id, streamPaused: waiting.length > 0,
      buttons: request?.card?.buttons ?? [this.button(task, '停止', `/stop ${taskId}`)],
      details: [...(request?.card?.details ?? []), ...(this.delivery.history(taskId) ?? [])],
    });
    return waiting.length > 0;
  }
  resolveServerRequest(taskId: string, requestId: unknown): void {
    for (const row of this.store.list('interactions', { taskId })) if (String(row.requestId) === String(requestId) && row.state !== 'expired') this.store.put('interactions', { ...row, state: 'resolved' });
    const task = this.store.get('tasks', taskId);
    if (task && ['waiting_approval', 'waiting_input'].includes(task.state) && !this.store.list('interactions', { taskId, state: 'pending' }).length) this.store.put('tasks', { ...task, state: 'running' });
    this.refresh(taskId, true);
  }
  find(event: Envelope, prefix: string): Interaction {
    const records = this.store.list('interactions', { actorId: event.actorId, scope: event.scope }).filter(r => r.id.startsWith(prefix));
    if (!prefix || records.length !== 1) throw new UserError('请求 ID 不存在或不唯一。');
    const row = records[0]!;
    if (row.state !== 'pending' || row.expiresAt < now()) throw new UserError('此请求已经处理或过期。');
    return row;
  }
  respond(row: Interaction, client: CodexClient, decision: 'approve' | 'deny' | 'answer', text: string): void {
    if (client.generation !== row.generation) throw new UserError('Codex 已重启，旧请求不能继续审批。');
    const live = this.store.get('interactions', row.id)!;
    if (live.state !== 'pending' || live.expiresAt < now()) throw new UserError('请求已经处理或过期。');
    const params = row.params as Record<string, any>;
    let payload: unknown;
    if (row.method === 'item/tool/requestUserInput') {
      if (decision !== 'answer') throw new UserError('请使用 /answer 回答此问题。');
      const questions = params.questions as { id: string }[];
      let supplied: Record<string, unknown>;
      if (questions.length === 1 && !text.trim().startsWith('{')) supplied = { [questions[0]!.id]: text };
      else { try { supplied = JSON.parse(text); } catch { throw new UserError('多问题回答需要 JSON，例如 {"问题ID":"回答"}。'); } }
      const answers: Record<string, { answers: string[] }> = {};
      for (const question of questions) {
        const value = supplied[question.id];
        if (typeof value !== 'string' || !value.trim()) throw new UserError(`缺少问题 ${question.id} 的文本回答。`);
        answers[question.id] = { answers: [value] };
      }
      payload = { answers };
    } else if (row.method === 'mcpServer/elicitation/request') {
      if (decision === 'deny') payload = { action: 'decline', content: null };
      else if (params.mode === 'url') {
        if (decision !== 'answer' || text !== 'done') throw new UserError('请完成请求中的登录链接后回答 done。');
        payload = { action: 'accept', content: null };
      } else {
        if (decision !== 'answer') throw new UserError('请使用 /answer 提交 JSON 表单。');
        let content: unknown; try { content = JSON.parse(text); } catch { throw new UserError('表单回答必须是 JSON 对象。'); }
        validateForm(params.requestedSchema, content);
        payload = { action: 'accept', content };
      }
    } else if (row.method === 'item/permissions/requestApproval') {
      if (decision === 'answer') throw new UserError('请批准或拒绝权限请求。');
      payload = { permissions: decision === 'approve' ? params.permissions : {}, scope: 'turn' };
    } else {
      if (decision === 'answer') throw new UserError('请批准或拒绝此请求。');
      const choice = decision === 'approve' ? 'accept' : 'decline';
      if (params.availableDecisions && !params.availableDecisions.includes(choice)) throw new UserError('此请求不支持该审批选项。');
      payload = { decision: choice };
    }
    this.store.put('interactions', { ...live, state: 'responding' });
    try { client.respond(row.requestId, payload); this.refresh(row.taskId, true); }
    catch (error) { this.store.put('interactions', { ...live, state: 'expired' }); throw error; }
  }
  expire(taskId: string): void {
    for (const row of this.store.list('interactions', { taskId })) if (row.state === 'pending' || row.state === 'responding') this.store.put('interactions', { ...row, state: 'expired' });
  }
}

function validateForm(schema: any, value: unknown): void {
  if (!schema || schema.type !== 'object') throw new UserError('不支持此表单结构。');
  try {
    const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    const validate = ajv.compile(schema);
    if (!validate(value)) throw new UserError(`表单内容不符合要求：${ajv.errorsText(validate.errors)}`);
  } catch (error) { if (error instanceof UserError) throw error; throw new UserError('无法验证此表单结构。'); }
}
