/**
 * Shared isolated SDK/PGlite fixture for Node parity and browser execution QA.
 * When the workspace SDK advances, update fixtures/pglite-peer/package.json
 * and its pnpm-workspace.yaml release-age exclusions, then regenerate via
 * `pnpm --dir packages/core/scripts/fixtures/pglite-peer install --lockfile-only`.
 */
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export async function provisionPglite(directory) {
  const source = fileURLToPath(new URL('./fixtures/pglite-peer/', import.meta.url));
  const workspaceSdk = JSON.parse(await readFile(
    new URL('../package.json', import.meta.resolve('@happyvertical/sql')), 'utf8',
  ));
  const fixture = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'));
  if (fixture.dependencies['@happyvertical/sql'] !== workspaceSdk.version) {
    throw new Error('Update the isolated PGlite SDK pin/lockfile to match the workspace SDK before testing');
  }
  await mkdir(directory);
  await Promise.all(
    ['package.json', 'peer.js', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].map(
      (file) => copyFile(resolve(source, file), resolve(directory, file)),
    ),
  );
  await promisify(execFile)('pnpm', ['--dir', directory, 'install', '--frozen-lockfile']);
  const moduleUrl = pathToFileURL(resolve(directory, 'peer.js')).href;
  const { pgliteEntry } = await import(moduleUrl);
  return { moduleUrl, assetDirectory: dirname(fileURLToPath(pgliteEntry)) };
}
