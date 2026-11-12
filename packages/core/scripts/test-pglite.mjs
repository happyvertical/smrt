/** Run the ordinary package tests with the existing isolated PostgreSQL SDK fixture. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionPglite } from './pglite-fixture.mjs';

const root = await mkdtemp(join(tmpdir(), 'smrt-postgres-tests-'));
try {
  const fixture = await provisionPglite(join(root, 'peer'));
  const child = spawn('pnpm', ['exec', 'vitest', 'run', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, SMRT_TEST_PGLITE: '1', SMRT_TEST_PGLITE_MODULE: fixture.moduleUrl },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
