import { spawnSync } from 'node:child_process';

export function needsStandaloneBuild(environment = process.env) {
  return !environment.TURBO_HASH;
}

export function ensureConformanceBuild(environment = process.env) {
  if (!needsStandaloneBuild(environment)) return;

  const result = spawnSync(
    'pnpm',
    ['--filter', '@happyvertical/smrt-svelte...', 'build'],
    { stdio: 'inherit', env: environment },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (import.meta.main) {
  ensureConformanceBuild();
}
