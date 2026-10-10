import fs from 'node:fs/promises';
import path from 'node:path';
import { UserError } from '../../domain/models.js';

export function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export function validateRelative(relative: string): void {
  if (!relative || path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.includes(':') || /[\x00-\x1f*?]/.test(relative) || relative.startsWith('\\')) throw new UserError('必须使用项目内的相对文件路径。');
  const segments = relative.split(/[\\/]/);
  if (segments.some(s => s === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s) || /[. ]$/.test(s))) throw new UserError('文件路径包含不允许的片段。');
}
export async function safePath(root: string, relative: string, allowMissing = false): Promise<string> {
  validateRelative(relative);
  const canonical = await fs.realpath(root);
  let cursor = canonical;
  for (const segment of relative.split(/[\\/]/).filter(s => s && s !== '.')) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new UserError('不允许通过符号链接或 junction 访问文件。');
      if (!within(canonical, await fs.realpath(cursor))) throw new UserError('文件超出允许目录。');
    } catch (error) { if (!(allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT')) throw error; }
  }
  if (!within(canonical, cursor)) throw new UserError('文件超出允许目录。');
  return cursor;
}
export function sensitive(relative: string): boolean {
  return relative.split(/[\\/]/).some(s => /^(\.env(?:\..*)?|\.git|\.ssh|\.aws|\.codex|auth\.json|config\.local\.yaml|connector\.db(?:-.*)?|id_rsa|id_ed25519)$/i.test(s)) || /\.(pem|key|pfx|p12)$/i.test(relative);
}
export async function managedDirectory(root: string, relative: string): Promise<string> {
  const target = await safePath(root, relative, true);
  await fs.mkdir(target, { recursive: true });
  return safePath(root, relative);
}
