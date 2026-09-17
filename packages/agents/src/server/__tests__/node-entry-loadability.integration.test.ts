/**
 * Plain-Node loadability gate for this package's server-side entry points
 * (#2924).
 *
 * `@happyvertical/smrt-agents` stamps `@happyvertical/smrt-agents/server` as
 * the `importPath` of three manifest objects
 * (`SmrtDataSurfaceActionTask`, `DataSurfaceActionTokenState`,
 * `DataSurfaceActionIdempotencyState`), so `smrt-core`'s consumer plugin
 * emits `import * as … from '@happyvertical/smrt-agents/server'` into a
 * consumer project's generated `.smrt/register.js`. The `smrt` CLI loads that
 * file with a bare `import()` under plain Node for `db:migrate`, with no Vite
 * and no Svelte plugin in the loader chain.
 *
 * A single static import edge from a server entry into a barrel that also
 * re-exports `.svelte` single-file components therefore breaks `db:migrate`
 * for *every* object in the consuming app, not just this package's — and it
 * does so invisibly, because a Vite build of the same graph succeeds.
 * `@happyvertical/smrt-agents@0.51.6` shipped exactly that:
 * `src/server/sveltekit-data-surface-routes.ts` imported
 * `DATA_SURFACE_MAX_REQUEST_BYTES` from `@happyvertical/smrt-ui/data`
 * (a Svelte component barrel) instead of the Svelte-free
 * `@happyvertical/smrt-ui/data-surface` entry, and the CLI crashed with
 * `ERR_UNKNOWN_FILE_EXTENSION` for `CollectionList.svelte`.
 *
 * This gate resolves each server-side subpath through the package's own
 * published `exports` map and imports it in a fresh plain-Node process, so
 * nothing in the Vitest/Vite loader chain can mask the regression.
 *
 * Requires a built `dist/` (turbo's `test` task depends on `build`).
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, '../../..');

interface ServerEntry {
  /** `exports` subpath as it appears in package.json. */
  subpath: string;
  /** A named export that must survive the plain-Node import. */
  expectedExport: string;
}

/**
 * Entry points a consumer may load outside a bundler: the package root and
 * `./server` are both stamped as manifest `importPath`s and land in a
 * generated `.smrt/register.js`; `./vite` is loaded by a consumer's
 * `vite.config.ts`, which Vite itself evaluates in Node. The Svelte surfaces
 * (`./ui`, `./svelte`, `./svelte/admin`, `./playground`) are deliberately
 * excluded — they are bundler-only by design.
 */
const SERVER_ENTRIES: ServerEntry[] = [
  { subpath: '.', expectedExport: 'Agent' },
  { subpath: './server', expectedExport: 'createDataSurfaceActionAdapter' },
  { subpath: './vite', expectedExport: 'vitePluginAgentRoutes' },
];

function resolveExportTarget(subpath: string): string {
  const packageJson = JSON.parse(
    readFileSync(path.join(packageDir, 'package.json'), 'utf8'),
  ) as { exports?: Record<string, unknown> };
  const condition = packageJson.exports?.[subpath];
  const target =
    typeof condition === 'string'
      ? condition
      : ((condition as Record<string, string> | undefined)?.import ??
        (condition as Record<string, string> | undefined)?.default);

  if (!target) {
    throw new Error(
      `package.json "exports" has no import target for subpath "${subpath}"`,
    );
  }
  return path.resolve(packageDir, target);
}

describe('server entry points load under plain Node (#2924)', () => {
  it.each(
    SERVER_ENTRIES,
  )('imports "$subpath" with no bundler in the loader chain', async ({
    subpath,
    expectedExport,
  }) => {
    const distFile = resolveExportTarget(subpath);
    expect(
      existsSync(distFile),
      `${distFile} is missing — build the package before running this gate`,
    ).toBe(true);

    const script = `
        const ns = await import(${JSON.stringify(pathToFileURL(distFile).href)});
        if (!(${JSON.stringify(expectedExport)} in ns)) {
          throw new Error('missing export ${expectedExport}');
        }
        console.log('loaded');
      `;

    // A fresh `node` with no Vite, no Svelte plugin, and no Vitest loader:
    // exactly the environment the `smrt` CLI uses for `.smrt/register.js`.
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '--eval', script],
      { cwd: packageDir },
    ).catch((error: Error & { stderr?: string }) => {
      throw new Error(
        `plain-Node import of "${subpath}" failed. A server entry must not ` +
          `reach a Svelte component barrel (import the Svelte-free ` +
          `@happyvertical/smrt-ui/data-surface entry instead of ` +
          `@happyvertical/smrt-ui/data).\n${error.stderr ?? error.message}`,
      );
    });

    expect(stdout.trim()).toBe('loaded');
  }, 60_000);
});
