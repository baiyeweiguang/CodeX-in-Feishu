import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse } from 'yaml';
import { config as dotenv } from 'dotenv';
import { z } from 'zod';
import type { Project } from '../domain/models.js';

const schema = z.object({
  dataDir: z.string().default('.local/data'),
  timezone: z.string().default('Asia/Shanghai'),
  feishu: z.object({
    allowedOpenIds: z.array(z.string()).default([]), groupsEnabled: z.boolean().default(false),
    allowedChatIds: z.array(z.string()).default([]),
  }).default({ allowedOpenIds: [], groupsEnabled: false, allowedChatIds: [] }),
  codex: z.object({
    executable: z.string().default('codex'), expectedVersion: z.string().default('0.144.1'),
    requestTimeoutMs: z.number().int().min(1000).default(30000),
    idleProcessMinutes: z.number().positive().default(15),
  }).default({ executable: 'codex', expectedVersion: '0.144.1', requestTimeoutMs: 30000, idleProcessMinutes: 15 }),
  scheduler: z.object({
    globalConcurrency: z.number().int().min(1).max(8).default(2),
    interactionTimeoutMinutes: z.number().positive().default(30),
  }).default({ globalConcurrency: 2, interactionTimeoutMinutes: 30 }),
  files: z.object({
    maxBytes: z.number().int().positive().default(20 * 1024 ** 2),
    maxArtifactsPerTask: z.number().int().min(1).max(100).default(10),
    maxStorageBytes: z.number().int().positive().default(1024 ** 3),
    retentionDays: z.number().positive().default(7),
  }).default({ maxBytes: 20 * 1024 ** 2, maxArtifactsPerTask: 10, maxStorageBytes: 1024 ** 3, retentionDays: 7 }),
  projects: z.array(z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/), alias: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    root: z.string(), sandbox: z.enum(['read-only', 'workspace-write']).default('workspace-write'),
    approvalsReviewer: z.enum(['user', 'auto_review']).default('user'),
    autoSendExports: z.boolean().default(false), model: z.string().optional(),
  })).min(1),
});
export type Config = Omit<z.infer<typeof schema>, 'projects'> & {
  projects: Project[]; appId: string; appSecret: string; configPath: string;
};
export function loadConfig(file = process.env.CONNECTOR_CONFIG ?? 'config.local.yaml'): Config {
  const full = path.resolve(file);
  const credentialFile = process.env.CONNECTOR_ENV_FILE ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local/share'), 'CodexConnector', '.env');
  dotenv({ path: credentialFile, quiet: true });
  dotenv({ path: path.join(path.dirname(full), '.env'), quiet: true });
  const raw = schema.parse(parse(fs.readFileSync(full, 'utf8')));
  const projects = raw.projects.map(p => {
    const root = fs.realpathSync(path.resolve(path.dirname(full), p.root));
    if (!fs.statSync(root).isDirectory()) throw new Error(`Project is not a directory: ${p.alias}`);
    return { ...p, root, workspaceKey: process.platform === 'win32' ? root.toLowerCase() : root };
  });
  if (new Set(projects.map(p => p.id)).size !== projects.length || new Set(projects.map(p => p.alias)).size !== projects.length)
    throw new Error('Project ids and aliases must be unique');
  for (const [i, p] of projects.entries()) for (const q of projects.slice(i + 1)) {
    if (p.workspaceKey === q.workspaceKey || p.workspaceKey.startsWith(q.workspaceKey + path.sep) || q.workspaceKey.startsWith(p.workspaceKey + path.sep))
      throw new Error(`Overlapping projects: ${p.alias}, ${q.alias}`);
  }
  return { ...raw, projects, dataDir: path.resolve(path.dirname(full), raw.dataDir), configPath: full,
    appId: process.env.FEISHU_APP_ID ?? '', appSecret: process.env.FEISHU_APP_SECRET ?? '' };
}
