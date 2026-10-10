import { randomUUID } from 'node:crypto';

export const id = () => randomUUID();
export const short = (value: string) => value.slice(0, 8);
export const now = () => Date.now();
export type TaskState = 'queued' | 'preparing' | 'starting' | 'running' | 'waiting_approval' |
  'waiting_input' | 'stopping' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted_unknown';
export const terminal = (state: TaskState) => ['succeeded', 'failed', 'cancelled', 'interrupted_unknown'].includes(state);
export const active = (state: TaskState) => !terminal(state) && state !== 'queued';

export interface Project {
  id: string; alias: string; root: string; workspaceKey: string;
  sandbox: 'read-only' | 'workspace-write'; autoSendExports: boolean; model?: string;
  approvalsReviewer?: 'user' | 'auto_review';
}
export interface Target { chatId: string; messageId?: string; threadId?: string }
export interface Envelope {
  id: string; eventId: string; messageId: string; tenantId: string; appId: string;
  actorId: string; scope: string; target: Target; isGroup: boolean;
  kind: 'text' | 'file' | 'image' | 'action'; text: string;
  resourceKey?: string; fileName?: string; actionToken?: string; receivedAt: number;
  parentMessageId?: string;
}
export interface Inbox extends Envelope { dedupeKey: string; state: 'pending' | 'done'; error?: string }
export interface Session {
  id: string; actorId: string; scope: string; projectId: string; cwd: string;
  title: string; threadId?: string; queuePaused: boolean; createdAt: number;
}
export interface Cursor { id: string; actorId: string; scope: string; projectId: string; sessionId: string }
export interface Preference { id: string; actorId: string; scope: string; projectId: string }
export interface Task {
  id: string; inboxId: string; sessionId: string; projectId: string; actorId: string;
  scope: string; target: Target; project: Project; prompt: string; state: TaskState;
  createdAt: number; startedAt?: number; completedAt?: number; turnId?: string;
  threadId?: string; generation?: string; result?: string; error?: string;
  stage?: string; cancelRequested?: boolean; exportsPath?: string; finalized?: boolean;
  streamItemId?: string; streamText?: string; streamPhase?: string;
}
export interface Attachment {
  id: string; actorId: string; scope: string; sessionId?: string; taskId?: string;
  messageId: string; resourceKey: string; name: string; kind: 'file' | 'image';
  state: 'pending' | 'downloading' | 'ready' | 'failed' | 'expired';
  blobPath?: string; size?: number; hash?: string; error?: string; createdAt: number;
}
export interface Artifact {
  id: string; taskId: string; sessionId: string; actorId: string; scope: string;
  name: string; snapshotPath: string; size: number; hash: string; sourceRelative?: string;
  state: 'ready' | 'expired'; createdAt: number;
}
export interface Button { label: string; token: string; primary?: boolean }
export interface Message { title?: string; text: string; buttons?: Button[]; fileKey?: string; streaming?: boolean; streamDone?: boolean; cardId?: string;
  streamPaused?: boolean; interactionId?: string; details?: { title: string; text: string }[] }
export interface Delivery {
  id: string; logicalKey: string; taskId?: string; target: Target; message: Message;
  artifactId?: string; state: 'pending' | 'sending' | 'sent' | 'failed';
  attempts: number; nextAttemptAt: number; remoteId?: string; error?: string;
  revision: number; sentRevision: number; createdAt: number;
  cardId?: string; streamFallback?: boolean; sentMessage?: Message;
}
export interface Interaction {
  id: string; taskId: string; actorId: string; scope: string; generation: string;
  requestId: string | number; method: string; params: Record<string, unknown>;
  state: 'pending' | 'responding' | 'resolved' | 'expired'; expiresAt: number; createdAt: number;
  card?: Message;
}
export interface Action {
  id: string; actorId: string; scope: string; command: string; expiresAt: number; used: boolean;
  usedBy?: string;
}
export interface Pairing { id: string; hash: string; expiresAt?: number | null; revoked?: boolean }
export interface Owner { id: string; createdAt: number }
export interface TaskEvent { id: string; taskId: string; kind: string; summary: string; createdAt: number }
export interface Upload { key: string }
export interface Transport {
  createStream?(message: Message): Promise<string>;
  updateStream?(cardId: string, message: Message, revision: number, operationId: string, previous?: Message): Promise<void>;
  send(target: Target, message: Message, dedupeId: string): Promise<string>;
  update(messageId: string, message: Message): Promise<void>;
  download(messageId: string, key: string, kind: 'file' | 'image', destination: string, maxBytes: number): Promise<void>;
  upload(file: string, name: string): Promise<Upload>;
}
export class UserError extends Error {}
export function scopeKey(appId: string, tenantId: string, chatId: string, topic = '') {
  return JSON.stringify([appId, tenantId, chatId, topic]);
}
