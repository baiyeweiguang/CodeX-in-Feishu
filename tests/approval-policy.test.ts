import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { CodexClient } from '../src/adapters/codex/client.js';
import type { Project, Session } from '../src/domain/models.js';

describe('project approval reviewer', () => {
  it.each([undefined, 'user', 'auto_review'] as const)('preserves sandbox with reviewer %s on start and resume', async reviewer => {
    const project: Project = { id: 'test', alias: 'test', root: process.cwd(), workspaceKey: process.cwd(),
      sandbox: 'workspace-write', autoSendExports: false, approvalsReviewer: reviewer };
    const client = new CodexClient(project, { executable: 'unused', expectedVersion: '0.144.1',
      requestTimeoutMs: 1000, idleProcessMinutes: 15 }, pino({ level: 'silent' }));
    vi.spyOn(client, 'start').mockResolvedValue();
    const request = vi.spyOn(client, 'request').mockResolvedValue({ thread: { id: 'new-thread' } });
    const session: Session = { id: 'session', actorId: 'owner', scope: 'test', projectId: project.id,
      cwd: project.root, title: 'test', queuePaused: false, createdAt: 0 };
    await client.ensureThread(session);
    expect(request).toHaveBeenLastCalledWith('thread/start', expect.objectContaining({
      approvalsReviewer: reviewer ?? 'user', approvalPolicy: 'on-request', sandbox: 'workspace-write',
    }));
    await client.ensureThread({ ...session, threadId: 'existing-thread' });
    expect(request).toHaveBeenLastCalledWith('thread/resume', expect.objectContaining({
      threadId: 'existing-thread', approvalsReviewer: reviewer ?? 'user', approvalPolicy: 'on-request', sandbox: 'workspace-write',
    }));
  });
});
