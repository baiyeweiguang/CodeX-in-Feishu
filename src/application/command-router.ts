import type { Logger } from 'pino';
import { active, id, now, short, terminal, UserError, type Envelope, type Inbox, type Task } from '../domain/models.js';
import { Store } from '../adapters/persistence/database.js';
import { ArtifactService } from './artifact-service.js';
import { DeliveryService } from './delivery-service.js';
import { SessionService } from './session-service.js';
import { TaskService } from './task-service.js';

export const help = `/projects - 选择项目\n/project <别名> - 切换项目\n/new [标题] - 新对话\n/sessions - 对话列表\n/use <ID> - 切换对话\n/status [任务ID] - 状态\n/tasks - 最近任务\n/stop [任务ID|--all] - 停止\n/continue - 恢复暂停的队列\n/steer <补充要求> - 补充当前任务\n/files - 附件与产物\n/attach <附件ID> - 关联未分配的附件\n/send <产物ID> - 发送文件\n/send-path "相对路径" - 发送项目文件\n/approve <请求ID> - 允许本次\n/deny <请求ID> - 拒绝\n/answer <请求ID> <回答> - 回答追问\n/retry [任务ID] - 重试失败的结果发送\n直接发文字开始任务；先上传文件再发文字可附带文件。`;

export function parseCommand(text: string): { name: string; argument: string } | undefined {
  text = text.trim();
  if (/^\/?list(?:\s|$)/i.test(text)) {
    const argument = text.replace(/^\/?list\s*/i, '').toLowerCase();
    if (!argument || argument === 'commands') return { name: 'help', argument: '' };
    if (['projects', 'sessions', 'tasks', 'files'].includes(argument)) return { name: argument, argument: '' };
    return { name: 'list', argument };
  }
  if (!text.startsWith('/')) return;
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) throw new UserError('命令格式不正确。');
  return { name: match[1]!.toLowerCase(), argument: match[2]?.trim() ?? '' };
}
export class CommandRouter {
  private processing = new Set<string>();
  private lanes = new Set<string>();
  private operations = new Set<Promise<void>>();
  private transfers = new Map<string, Promise<void>>();
  private closing = false;
  constructor(private store: Store, private sessions: SessionService, private tasks: TaskService,
    private files: ArtifactService, private delivery: DeliveryService, private logger: Logger) {}
  accept(event: Envelope): void {
    if (this.closing) throw new Error('Connector is shutting down');
    if (event.kind === 'action') {
      const action = this.store.get('actions', event.actionToken ?? '');
      if (!action || action.actorId !== event.actorId || action.expiresAt < now()) return;
      const parts = JSON.parse(action.scope) as string[];
      if (parts[0] !== event.appId || parts[2] !== event.target.chatId) return;
      event = { ...event, scope: action.scope, isGroup: this.store.list('inbox', { scope: action.scope }).find(r => r.kind !== 'action')?.isGroup ?? false };
    }
    const pairing = event.kind === 'text' && event.text.startsWith('/pair ');
    if (!this.sessions.authorized(event) && !pairing) return;
    if (event.text.length > 100000) throw new Error('Message too large');
    const dedupeKey = JSON.stringify([event.appId, event.tenantId, event.kind === 'action' ? 'action' : 'message', event.kind === 'action' ? event.eventId : event.messageId]);
    if (this.store.list('inbox', { dedupeKey }).length) return;
    this.store.put('inbox', { ...event, dedupeKey, state: 'pending' });
  }
  private reply(event: Envelope, text: string, title = 'CodexConnector'): void {
    this.delivery.text(`reply:${event.id}`, event.target, { title, text });
  }
  async tick(): Promise<void> {
    if (this.closing) return;
    for (const row of this.store.list('inbox', { state: 'pending' }).slice(0, 100)) {
      if (this.processing.has(row.id)) continue;
      const commandText = row.kind === 'action' ? this.store.get('actions', row.actionToken ?? '')?.command ?? '' : row.text;
      const control = /^\/(stop|status|tasks|approve|deny|answer)(\s|$)/.test(commandText);
      const lane = JSON.stringify([row.scope, row.actorId]);
      if (!control && this.lanes.has(lane)) continue;
      if (!control) this.lanes.add(lane);
      this.processing.add(row.id);
      const operation = this.process(row).finally(() => {
        this.processing.delete(row.id); if (!control) this.lanes.delete(lane); this.operations.delete(operation);
      });
      this.operations.add(operation);
    }
    this.startDownloads();
  }
  private async process(row: Inbox): Promise<void> {
    try {
      await this.route(row);
      this.store.put('inbox', { ...row, state: 'done', text: row.text.startsWith('/pair ') ? '/pair [redacted]' : row.text });
    } catch (error) {
      this.logger.warn({ inboxId: row.id, error: (error as Error).message }, 'Message handling failed');
      this.store.transaction(() => {
        this.reply(row, error instanceof UserError ? error.message : `操作失败：${(error as Error).message}`);
        this.store.put('inbox', { ...row, state: 'done', error: (error as Error).message, text: row.text.startsWith('/pair ') ? '/pair [redacted]' : row.text });
      });
    }
  }
  private async route(row: Inbox): Promise<void> {
    let event: Envelope = row;
    if (event.kind === 'action') {
      const action = this.store.get('actions', event.actionToken ?? '');
      if (!action || (action.used && action.usedBy !== row.id) || action.expiresAt < now()) throw new UserError('这个按钮已使用或过期，请发送相应命令。');
      this.store.put('actions', { ...action, used: true, usedBy: row.id });
      event = { ...event, text: action.command, kind: 'text' };
    }
    const command = parseCommand(event.text);
    if (command?.name === 'pair') {
      this.sessions.pair(event, command.argument); this.reply(event, '配对成功。使用 /projects 选择项目。'); return;
    }
    if (!this.sessions.authorized(event)) throw new UserError('当前账号或群聊未授权。');
    if (event.kind === 'file' || event.kind === 'image') {
      if (!event.resourceKey) throw new UserError('文件消息缺少资源键。');
      if (!this.store.list('attachments').some(a => a.messageId === event.messageId && a.scope === event.scope)) {
        const attachmentId = id(); const session = this.sessions.current(event);
        this.store.put('attachments', { id: attachmentId, actorId: event.actorId, scope: event.scope,
          sessionId: session?.id, messageId: event.messageId, resourceKey: event.resourceKey,
          name: event.fileName ?? 'file', kind: event.kind, state: 'pending', createdAt: now() });
        this.reply(event, `附件 ${short(attachmentId)} 已接收，正在下载。${session ? '\n下一条任务将使用该附件。' : `\n请先选择项目，然后 /attach ${short(attachmentId)}。`}`);
      } return;
    }
    if (!command) {
      if (!event.text.trim()) throw new UserError('请发送任务描述。');
      const current = this.sessions.require(event);
      const pending = this.store.list('interactions', { actorId: event.actorId, scope: event.scope, state: 'pending' })
        .filter(r => this.store.get('tasks', r.taskId)?.sessionId === current.id);
      if (pending.length) {
        const referenced = pending.find(r => this.store.list('outbox', { taskId: r.taskId })
          .some(d => d.remoteId === event.parentMessageId &&
            (d.sentMessage?.interactionId === r.id || d.logicalKey.startsWith(`interaction:${r.id}:`))));
        if (referenced && referenced.method.includes('requestUserInput')) {
          const task = this.store.get('tasks', referenced.taskId)!;
          this.tasks.interactions.respond(referenced, this.tasks.client(task), 'answer', event.text);
          return;
        }
        throw new UserError(`当前任务在等待回答，请先处理请求 ${pending.map(r => short(r.id)).join(', ')}。使用 /answer 或 /approve、/deny。`);
      }
      this.tasks.create(event); return;
    }
    const arg = command.argument;
    switch (command.name) {
      case 'help': this.delivery.text(`reply:${event.id}`, event.target, { title: '命令菜单',
        text: 'list projects - 列出并选择项目\nlist - 显示此菜单\n/pair-revoke - 撤销配对密钥\n' + help,
        buttons: ['projects', 'sessions', 'tasks', 'files'].map((name, i) =>
          this.tasks.interactions.button(event, ['项目列表', '对话列表', '任务列表', '文件列表'][i]!, `/${name}`)) }); return;
      case 'list': throw new UserError('支持 list projects、list sessions、list tasks、list files；list 显示命令菜单。');
      case 'pair-revoke': {
        if (event.isGroup) throw new UserError('请在机器人私聊中撤销配对密钥。');
        this.sessions.revokePairing(); await this.sessions.pairingFile();
        this.reply(event, '配对密钥已撤销并删除本地副本。已配对账号继续有效；新配对需在本机运行 npm run pair -- --rotate。'); return;
      }
      case 'unsupported': throw new UserError('目前支持文字、富文本、图片与文件消息。');
      case 'projects': {
        const current = this.sessions.current(event);
        const page = arg ? Number(arg) : 1;
        const projects = this.sessions.config.projects;
        const pages = Math.ceil(projects.length / 4);
        if (!Number.isInteger(page) || page < 1 || page > pages) throw new UserError('项目列表页码无效。');
        const visible = projects.slice((page - 1) * 4, page * 4);
        this.delivery.text(`reply:${event.id}`, event.target, { title: '选择项目',
          text: visible.map(p => `${p.id === current?.projectId ? '* ' : ''}${p.alias}\n${p.root}`).join('\n\n') + `\n第 ${page}/${pages} 页`,
          buttons: [...visible.map(p => this.tasks.interactions.button(event, p.alias, `/project ${p.alias}`, true)),
            ...(pages > 1 ? [this.tasks.interactions.button(event, page < pages ? '下一页' : '返回首页', `/projects ${page < pages ? page + 1 : 1}`)] : [])] }); return;
      }
      case 'project': {
        const session = this.sessions.select(event, arg);
        this.reply(event, `当前项目：${this.sessions.project(session.projectId).alias}\n对话：${short(session.id)} ${session.title}`); return;
      }
      case 'new': {
        const current = this.sessions.current(event);
        if (!current) throw new UserError('请先选择项目。');
        const session = this.sessions.create(event, this.sessions.project(current.projectId), arg || '新对话', event.id);
        this.reply(event, `已新建对话 ${short(session.id)}。原对话的任务不会因此停止。`); return;
      }
      case 'sessions': {
        const current = this.sessions.require(event);
        this.reply(event, this.store.list('sessions', { actorId: event.actorId, scope: event.scope, projectId: current.projectId }).slice(-20)
          .map(s => `${s.id === current.id ? '* ' : ''}${short(s.id)} ${s.title}${s.queuePaused ? ' [暂停]' : ''}`).join('\n')); return;
      }
      case 'use': { const session = this.sessions.use(event, arg); this.reply(event, `已切换到 ${short(session.id)} ${session.title}`); return; }
      case 'tasks': this.reply(event, this.store.list('tasks', { actorId: event.actorId, scope: event.scope }).slice(-20)
        .map(t => `${short(t.id)} ${t.project.alias} ${t.state} ${t.prompt.slice(0, 50)}`).join('\n') || '暂无任务。'); return;
      case 'status': this.reply(event, this.tasks.status(this.tasks.find(event, arg || undefined))); return;
      case 'stop': {
        if (arg === '--all') {
          const session = this.sessions.require(event);
          for (const task of this.store.list('tasks', { sessionId: session.id })) if (!terminal(task.state)) void this.tasks.stop(task).catch(error => this.logger.warn({ error }, 'Stop failed'));
        } else void this.tasks.stop(this.tasks.find(event, arg || undefined)).catch(error => this.logger.warn({ error }, 'Stop failed'));
        this.reply(event, '已请求停止，当前对话队列将暂停。已有文件修改不会回滚；使用 /status 查看最终状态。'); return;
      }
      case 'continue': {
        const session = this.sessions.require(event);
        this.store.put('sessions', { ...session, queuePaused: false }); this.reply(event, '队列已恢复。已结束或状态不明的旧任务不会重跑。'); return;
      }
      case 'steer': if (!arg) throw new UserError('请提供补充要求。');
        await this.tasks.steer(this.tasks.find(event), arg); this.reply(event, '补充要求已送达。'); return;
      case 'approve': case 'deny': case 'answer': {
        const split = /^(\S+)(?:\s+([\s\S]*))?$/.exec(arg);
        if (!split) throw new UserError('请提供请求 ID。');
        const interaction = this.tasks.interactions.find(event, split[1]!);
        const task = this.store.get('tasks', interaction.taskId)!;
        this.tasks.interactions.respond(interaction, this.tasks.client(task), command.name, split[2] ?? '');
        return;
      }
      case 'files': {
        const session = this.sessions.require(event);
        const attachments = this.store.list('attachments', { actorId: event.actorId, scope: event.scope }).filter(a => !a.sessionId || a.sessionId === session.id);
        const artifacts = this.store.list('artifacts', { sessionId: session.id });
        this.reply(event, '输入附件：\n' + (attachments.slice(-20).map(a => `${short(a.id)} ${a.name} ${a.state}${!a.sessionId ? ' [待关联]' : a.taskId ? ' [已使用]' : ' [下一任务]'}`).join('\n') || '无') +
          '\n\n可发送产物：\n' + (artifacts.slice(-20).map(a => `${short(a.id)} ${a.name} ${a.state}`).join('\n') || '无')); return;
      }
      case 'attach': {
        const session = this.sessions.require(event);
        const matches = this.store.list('attachments', { actorId: event.actorId, scope: event.scope }).filter(a => a.id.startsWith(arg));
        if (!arg || matches.length !== 1) throw new UserError('附件 ID 不存在或不唯一。');
        const attachment = matches[0]!;
        if (attachment.sessionId && attachment.sessionId !== session.id) throw new UserError('该附件属于另一个对话。');
        if (attachment.taskId) {
          if (attachment.state !== 'ready') throw new UserError('附件不可用。');
          this.store.put('attachments', { ...attachment, id: event.id, sessionId: session.id, taskId: undefined, createdAt: now() });
        } else this.store.put('attachments', { ...attachment, sessionId: session.id, state: attachment.state === 'failed' ? 'pending' : attachment.state });
        this.reply(event, `已关联 ${attachment.name}，下一条任务将使用此文件。`); return;
      }
      case 'send': {
        const matches = this.store.list('artifacts', { actorId: event.actorId, scope: event.scope }).filter(a => a.id.startsWith(arg));
        if (!arg || matches.length !== 1) throw new UserError('产物 ID 不存在或不唯一。');
        const artifact = matches[0]!;
        if (artifact.state !== 'ready') throw new UserError('文件已过期。');
        this.delivery.enqueue(`send:${event.id}`, event.target, { text: artifact.name }, artifact.taskId, artifact.id); return;
      }
      case 'send-path': {
        const session = this.sessions.require(event);
        const release = this.tasks.reserve(session.projectId);
        try {
        const relative = arg.startsWith('"') && arg.endsWith('"') ? arg.slice(1, -1) : arg;
        const project = this.sessions.project(session.projectId);
        const synthetic: Task = { id: event.id, inboxId: event.id, sessionId: session.id, projectId: project.id, actorId: event.actorId,
          scope: event.scope, target: event.target, project, prompt: `/send-path ${relative}`, state: 'succeeded', createdAt: now(), completedAt: now(), finalized: true };
        const artifact = this.store.list('artifacts', { taskId: synthetic.id })[0] ?? await this.files.snapshot(synthetic, project.root, relative);
        this.store.put('tasks', synthetic);
        this.delivery.enqueue(`send-path:${event.id}`, event.target, { text: artifact.name }, synthetic.id, artifact.id); return;
        } finally { release(); }
      }
      case 'retry': {
        const task = this.tasks.find(event, arg || undefined);
        this.reply(event, `已重新安排 ${this.delivery.retry(task.id)} 条失败交付；任务不会重跑。`); return;
      }
      default: throw new UserError('未知命令。使用 /help 查看。');
    }
  }
  private startDownloads(): void {
    for (const attachment of this.store.list('attachments', { state: 'pending' })) {
      if (this.transfers.size >= 2 || this.transfers.has(attachment.id)) break;
      if (attachment.taskId) continue;
      const transfer = this.files.receive(attachment).then(ready => {
        const origin = this.store.list('inbox', { scope: ready.scope }).find(e => e.messageId === ready.messageId);
        if (origin) this.delivery.text(`download:${attachment.id}`, origin.target, { text: `附件 ${short(attachment.id)} 已下载：${ready.name}` });
      }).catch(error => {
        const origin = this.store.list('inbox', { scope: attachment.scope }).find(e => e.messageId === attachment.messageId);
        if (origin) this.delivery.text(`download:${attachment.id}`, origin.target, { text: `附件下载失败：${(error as Error).message}\n使用 /attach ${short(attachment.id)} 重试。` });
      }).finally(() => this.transfers.delete(attachment.id));
      this.transfers.set(attachment.id, transfer);
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.operations]);
    await Promise.allSettled([...this.transfers.values()]);
  }
}
