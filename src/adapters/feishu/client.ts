import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { Config } from '../../config/load.js';
import { id, scopeKey, type Envelope, type Message, type Target, type Transport } from '../../domain/models.js';

export function card(message: Message): object {
  if (message.streaming) return streamingCard(message, false);
  return { config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: (message.title ?? 'CodexConnector').slice(0, 100) }, template: 'green' },
    elements: [{ tag: 'markdown', content: message.text || ' ' },
      ...(message.buttons?.length ? [{ tag: 'action', actions: message.buttons.slice(0, 5).map(button => ({
        tag: 'button', text: { tag: 'plain_text', content: button.label },
        type: button.primary ? 'primary' : 'default', value: { token: button.token },
      })) }] : [])] };
}
export function streamingCard(message: Message, nativeStreaming = true): object {
  return { schema: '2.0', config: { streaming_mode: nativeStreaming && !message.streamDone && !message.streamPaused,
    summary: { content: message.streamDone ? '任务已结束' : message.streamPaused ? 'Codex 等待回答' : 'Codex 正在处理' },
    streaming_config: { print_frequency_ms: { default: 70 }, print_step: { default: 1 }, print_strategy: 'fast' } },
    header: { title: { tag: 'plain_text', content: (message.title ?? 'CodexConnector').slice(0, 100) }, template: 'green' },
    body: { elements: [{ tag: 'markdown', element_id: 'content', content: message.text || ' ' },
      ...(message.buttons ?? []).slice(0, 5).map(button => ({ tag: 'button',
        text: { tag: 'plain_text', content: button.label }, type: button.primary ? 'primary' : 'default',
        behaviors: [{ type: 'callback', value: { token: button.token } }] })),
      ...(message.details ?? []).map((detail, index) => ({ tag: 'collapsible_panel', element_id: `details_${index}`, expanded: false,
        header: { title: { tag: 'plain_text', content: detail.title } },
        elements: [{ tag: 'markdown', content: detail.text || ' ' }] }))] } };
}
export function cardLayout(message?: Message): string {
  return JSON.stringify([message?.title, message?.buttons ?? [], message?.details ?? [], Boolean(message?.streamPaused), Boolean(message?.streamDone)]);
}
export function normalize(raw: any, appId: string, botId?: string): Envelope | undefined {
  const message = raw.message;
  if (!message || raw.sender?.sender_type !== 'user') return;
  if (raw.app_id && raw.app_id !== appId) return;
  const actorId = raw.sender?.sender_id?.open_id;
  if (!actorId || !message.chat_id || !message.message_id) return;
  const isGroup = message.chat_type !== 'p2p';
  if (isGroup && !(message.mentions ?? []).some((m: any) => botId && m.id?.open_id === botId)) return;
  let content: any;
  try { content = JSON.parse(message.content); } catch { return; }
  let text = ''; let kind: Envelope['kind'] = 'text';
  if (message.message_type === 'text') text = content.text ?? '';
  else if (message.message_type === 'file' || message.message_type === 'image') kind = message.message_type;
  else if (message.message_type === 'post') {
    const post = content.content ? content : content.zh_cn ?? content.en_us;
    text = [post?.title, ...(post?.content ?? []).flat().map((x: any) => x.tag === 'text' ? x.text : x.tag === 'a' ? `${x.text} (${x.href})` : '')].filter(Boolean).join('\n');
    if (!text.trim()) text = '/unsupported';
  } else text = '/unsupported';
  for (const mention of message.mentions ?? []) text = text.split(mention.key).join('');
  const tenantId = raw.tenant_key ?? raw.sender?.tenant_key ?? '';
  // A DM remains one routing scope even when the user replies to a previous message.
  const topic = isGroup ? message.root_id ?? message.thread_id ?? '' : '';
  return { id: id(), eventId: raw.event_id ?? message.message_id, appId, tenantId,
    messageId: message.message_id, actorId, isGroup, scope: scopeKey(appId, tenantId, message.chat_id, topic),
    target: { chatId: message.chat_id, messageId: message.message_id, threadId: isGroup ? topic || undefined : undefined },
    kind, text: text.trim(), parentMessageId: message.parent_id, resourceKey: content.file_key ?? content.image_key,
    fileName: content.file_name ?? (kind === 'image' ? 'image.png' : undefined), receivedAt: Date.now() };
}

export class FeishuTransport implements Transport {
  readonly client: lark.Client;
  private ws?: lark.WSClient;
  private botId?: string;
  constructor(private config: Config, private logger: Logger) {
    lark.defaultHttpInstance.defaults.timeout = 30000;
    const sdkLogger = { error: (...args: any[]) => logger.warn({ detail: String(args[0]).slice(0, 500) }, 'Feishu SDK error'),
      warn: (...args: any[]) => logger.warn({ detail: String(args[0]).slice(0, 500) }, 'Feishu SDK warning'), info: () => {}, debug: () => {}, trace: () => {} };
    this.client = new lark.Client({ appId: config.appId, appSecret: config.appSecret, domain: lark.Domain.Feishu,
      logger: sdkLogger, loggerLevel: lark.LoggerLevel.warn });
  }
  async checkIdentity(): Promise<{ appName: string; botId: string }> {
    const result: any = await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info/' });
    if (result.code !== 0) throw new Error(`Feishu bot identity failed (${result.code}): ${result.msg}`);
    this.botId = result.bot?.open_id ?? result.data?.bot?.open_id;
    if (!this.botId) throw new Error('Feishu bot identity did not return open_id');
    return { appName: result.bot?.app_name ?? result.data?.bot?.app_name ?? '', botId: this.botId };
  }
  async connect(onMessage: (event: Envelope) => void): Promise<void> {
    await this.checkIdentity();
    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error }).register({
      'im.message.receive_v1': async (raw: any) => { const event = normalize(raw, this.config.appId, this.botId); if (event) onMessage(event); },
      'card.action.trigger': async (raw: any) => {
        const actorId = raw.operator?.open_id; const chatId = raw.context?.open_chat_id;
        const token = raw.action?.value?.token;
        if (!actorId || !chatId || typeof token !== 'string') return {};
        const tenantId = raw.tenant_key ?? '';
        onMessage({ id: id(), eventId: raw.event_id ?? createHash('sha256').update(`${token}:${actorId}`).digest('hex'),
          messageId: raw.context?.open_message_id ?? '', appId: this.config.appId, tenantId,
          actorId, isGroup: false, scope: scopeKey(this.config.appId, tenantId, chatId),
          target: { chatId }, kind: 'action', text: '', actionToken: token, receivedAt: Date.now() });
        return { toast: { type: 'info', content: '请求已接收' } };
      },
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.ws?.close({ force: true }); reject(new Error('Feishu WebSocket connection timed out')); }, 25000);
      this.ws = new lark.WSClient({ appId: this.config.appId, appSecret: this.config.appSecret,
        loggerLevel: lark.LoggerLevel.error,
        onReady: () => { clearTimeout(timer); this.logger.info('Feishu WebSocket ready'); resolve(); },
        onError: () => { clearTimeout(timer); reject(new Error('Feishu WebSocket failed; check application event subscription')); },
      });
      void this.ws.start({ eventDispatcher: dispatcher }).catch(error => { clearTimeout(timer); reject(error); });
    });
  }
  close(): void { this.ws?.close({ force: true }); }
  status(): unknown { return this.ws?.getConnectionStatus(); }
  async createStream(message: Message): Promise<string> {
    const result = await this.client.cardkit.v1.card.create({ data: { type: 'card_json', data: JSON.stringify(streamingCard(message)) } });
    if (result.code !== 0 || !result.data?.card_id) throw new Error(`Feishu streaming create failed (${result.code}): ${result.msg}`);
    return result.data.card_id;
  }
  async updateStream(cardId: string, message: Message, revision: number, operationId: string, previous?: Message): Promise<void> {
    const uuid = (step: number) => createHash('sha256').update(`${operationId}:${revision}:${step}`).digest('hex').slice(0, 32);
    const check = (result: { code?: number; msg?: string }) => {
      if (result.code !== 0) throw new Error(`Feishu streaming update failed (${result.code}): ${result.msg}`);
    };
    if (message.streamDone || cardLayout(message) !== cardLayout(previous)) {
      check(await this.client.cardkit.v1.card.settings({ path: { card_id: cardId },
        data: { settings: JSON.stringify({ config: { streaming_mode: !message.streamDone && !message.streamPaused } }), sequence: revision * 3 + 1, uuid: uuid(1) } }));
      check(await this.client.cardkit.v1.card.update({ path: { card_id: cardId },
        data: { card: { type: 'card_json', data: JSON.stringify(streamingCard(message)) }, sequence: revision * 3 + 2, uuid: uuid(2) } }));
    } else {
      check(await this.client.cardkit.v1.cardElement.content({ path: { card_id: cardId, element_id: 'content' },
        data: { content: message.text || ' ', sequence: revision * 3, uuid: uuid(0) } }));
    }
  }
  async send(target: Target, message: Message, dedupeId: string): Promise<string> {
    const msg_type = message.fileKey ? 'file' : 'interactive';
    const content = JSON.stringify(message.fileKey ? { file_key: message.fileKey } : message.cardId ? { type: 'card', data: { card_id: message.cardId } } : card(message));
    const result = target.messageId
      ? await this.client.im.message.reply({ path: { message_id: target.messageId }, data: { content, msg_type,
        reply_in_thread: Boolean(target.threadId), uuid: dedupeId } })
      : await this.client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: target.chatId, msg_type, content, uuid: dedupeId } });
    if (result.code !== 0 || !result.data?.message_id) throw new Error(`Feishu send failed (${result.code}): ${result.msg}`);
    return result.data.message_id;
  }
  async update(messageId: string, message: Message): Promise<void> {
    const result = await this.client.im.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card(message)) } });
    if (result.code !== 0) throw new Error(`Feishu update failed (${result.code}): ${result.msg}`);
  }
  async download(messageId: string, key: string, kind: 'file' | 'image', destination: string, maxBytes: number): Promise<void> {
    const result = await this.client.im.messageResource.get({ path: { message_id: messageId, file_key: key }, params: { type: kind } });
    let bytes = 0;
    const cap = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length; callback(bytes > maxBytes ? new Error('File exceeds configured size limit') : null, chunk);
    } });
    await pipeline(result.getReadableStream(), cap, fs.createWriteStream(destination, { flags: 'wx' }), { signal: AbortSignal.timeout(60000) });
  }
  async upload(file: string, name: string): Promise<{ key: string }> {
    const result = await this.client.im.file.create({ data: { file_type: 'stream', file_name: name, file: fs.createReadStream(file) } });
    if (!result?.file_key) throw new Error('Feishu upload did not return a file key');
    return { key: result.file_key };
  }
}
