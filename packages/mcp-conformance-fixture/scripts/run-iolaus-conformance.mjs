import { spawnSync } from 'node:child_process';
// The canonical wrapper requires a real service and provisions a disposable DB.
const result = spawnSync(process.execPath, ['../../scripts/run-with-ci-postgres.mjs', '--', 'pnpm', 'exec', 'vitest', 'run', 'src/iolaus-conformance.test.ts'], {
  stdio: 'inherit',
  env: { ...process.env, SMRT_MCP_APPS_BROWSER: '1' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
