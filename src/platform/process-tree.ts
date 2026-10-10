import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function guardProcess(child: ChildProcessWithoutNullStreams): Promise<() => Promise<void>> {
  if (!child.pid) throw new Error('Child process has no pid');
  const pid = child.pid;
  if (process.platform !== 'win32') return async () => {
    try { process.kill(-pid, 'SIGKILL'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const guard = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fileURLToPath(new URL('windows-job.ps1', import.meta.url)), '-ChildPid', String(pid)],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Windows process supervisor timed out')), 15000);
      let output = ''; let errors = '';
      guard.stdout.on('data', (part: Buffer) => { output += part.toString(); if (output.includes('READY')) { clearTimeout(timer); resolve(); } });
      guard.stderr.on('data', (part: Buffer) => { errors = (errors + part.toString()).slice(-2000); });
      guard.once('error', error => { clearTimeout(timer); reject(error); });
      guard.once('exit', code => { clearTimeout(timer); reject(new Error(`Windows process supervisor exited (${code}): ${errors}`)); });
    });
  } catch (error) { guard.kill(); child.kill(); throw error; }
  return async () => {
    if (guard.exitCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { guard.kill(); reject(new Error('Process supervisor did not close')); }, 10000);
      guard.once('exit', () => { clearTimeout(timer); resolve(); });
      guard.stdin.end();
    });
  };
}
