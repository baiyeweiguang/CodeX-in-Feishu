import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('dist/src/platform', { recursive: true });
copyFileSync('src/platform/windows-job.ps1', 'dist/src/platform/windows-job.ps1');
