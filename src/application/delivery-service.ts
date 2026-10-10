import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import { id, now, type Delivery, type Message, type Target, type Transport } from '../domain/models.js';
import { Store } from '../adapters/persistence/database.js';

export function chunks(text: string, max = 2800): string[] {
  const result: string[] = []; let buffer = '';
  for (const char of text) {
    if (buffer.length + char.length > max) { result.push(buffer); buffer = ''; }
    buffer += char;
  }
  if (buffer || !result.length) result.push(buffer);
  return result;
}
export class DeliveryService {
  private sending = false;
  constructor(private store: Store, private transport: Transport, private logger: Logger) {}
  enqueue(key: string, target: Target, message: Message, taskId?: string, artifactId?: string): Delivery {
    const existing = this.store.list('outbox', { logicalKey: key })[0];
    if (existing) return existing;
    const value: Delivery = { id: id(), logicalKey: key, target, message, taskId, artifactId,
      state: 'pending', attempts: 0, nextAttemptAt: 0, revision: 1, sentRevision: 0, createdAt: now() };
    this.store.put('outbox', value); return value;
  }
  text(key: string, target: Target, message: Message, taskId?: string): void {
    this.store.transaction(() => {
      for (const [index, text] of chunks(message.text).entries()) this.enqueue(`${key}:${index}`, target,
        { ...message, text, buttons: index === 0 ? message.buttons : undefined }, taskId);
    });
  }
  progress(taskId: string, target: Target, message: Message): void {
    message = { ...message, streaming: true };
    const key = `progress:${taskId}`;
    const existing = this.store.list('outbox', { logicalKey: key })[0];
    if (!existing) { this.enqueue(key, target, message, taskId); return; }
    if (existing.message.streamDone) return;
    if (JSON.stringify(existing.message) === JSON.stringify(message)) return;
    this.store.put('outbox', { ...existing, message, revision: existing.revision + 1,
      state: existing.state === 'sending' ? 'sending' : 'pending',
      nextAttemptAt: message.streamDone || message.interactionId !== existing.message.interactionId ? 0 : existing.nextAttemptAt });
  }
  history(taskId: string): Message['details'] {
    const events = this.store.list('task_events', { taskId });
    return events.length ? [{ title: `执行记录（${events.length} 项，最近 8 项）`,
      text: events.slice(-8).map(e => e.summary).join('\n\n') }] : [];
  }
  recover(): void { for (const row of this.store.list('outbox', { state: 'sending' })) this.store.put('outbox', { ...row, state: 'pending' }); }
  async tick(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      const due = this.store.list('outbox', { state: 'pending' }).filter(row => row.nextAttemptAt <= now()).slice(0, 8);
      for (const row of due) await this.deliver(row);
    } finally { this.sending = false; }
  }
  private async deliver(row: Delivery): Promise<void> {
    this.store.put('outbox', { ...row, state: 'sending' });
    try {
      if (row.message.streaming && !row.remoteId && !row.cardId && !row.streamFallback && this.transport.createStream) {
        try { row.cardId = await this.transport.createStream(row.message); }
        catch (error) {
          // Missing CardKit permission still permits editing one ordinary message.
          if (!String((error as Error).message).includes('99991672')) throw error;
          row.streamFallback = true;
          this.logger.warn('CardKit permission missing; using single-card message updates');
        }
        this.store.put('outbox', { ...this.store.get('outbox', row.id)!, cardId: row.cardId, streamFallback: row.streamFallback });
      }
      if (row.artifactId && !row.message.fileKey) {
        const artifact = this.store.get('artifacts', row.artifactId);
        if (!artifact || artifact.state !== 'ready') throw new Error('Artifact expired or missing');
        const uploaded = await this.transport.upload(artifact.snapshotPath, artifact.name);
        row.message.fileKey = uploaded.key;
        this.store.put('outbox', { ...row, state: 'sending' });
      }
      let remoteId = row.remoteId;
      if (remoteId) {
        if (row.cardId && this.transport.updateStream) await this.transport.updateStream(row.cardId, row.message, row.revision, row.id, row.sentMessage);
        else await this.transport.update(remoteId, row.message);
      } else remoteId = await this.transport.send(row.target, { ...row.message, cardId: row.cardId }, createHash('sha256').update(row.logicalKey).digest('hex').slice(0, 32));
      const latest = this.store.get('outbox', row.id)!;
      this.store.put('outbox', { ...latest, remoteId, sentRevision: row.revision, sentMessage: row.message,
        state: latest.revision > row.revision ? 'pending' : 'sent', attempts: 0, error: undefined,
        nextAttemptAt: latest.message.streamDone ? 0 : now() + 1200 });
    } catch (error) {
      const latest = this.store.get('outbox', row.id)!;
      const attempts = row.attempts + 1;
      this.store.put('outbox', { ...latest, state: attempts >= 8 ? 'failed' : 'pending', attempts,
        nextAttemptAt: now() + Math.min(60000, 1000 * 2 ** attempts), error: (error as Error).message });
      this.logger.warn({ deliveryId: row.id, attempts, error: (error as Error).message }, 'Delivery failed');
    }
  }
  retry(taskId?: string): number {
    const failed = this.store.list('outbox', { state: 'failed' }).filter(d => !taskId || d.taskId === taskId);
    for (const row of failed) this.store.put('outbox', { ...row, state: 'pending', attempts: 0, nextAttemptAt: 0,
      message: row.artifactId ? { ...row.message, fileKey: undefined } : row.message });
    return failed.length;
  }
  async drain(): Promise<void> { while (this.sending) await new Promise(resolve => setTimeout(resolve, 20)); }
}
