/**
 * Browser reachability of non-model entries (#5000).
 *
 * `@happyvertical/smrt-planner/core` is imported dynamically from client
 * modules of consumer apps, so it must build for a browser without reaching
 * any Node built-in (0.61.0 shipped a bundler `createRequire` shim importing
 * `node:module`). Run `pnpm build` first; turbo's `test` already depends on
 * `^build`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildPackageForBrowser } from '../browser-gate/build.js';

const plannerDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../planner',
);

describe('browser reachability of smrt-planner ./core', () => {
  it('reaches no Node built-in or Node-only module', async () => {
    const findings = await buildPackageForBrowser({
      name: '@happyvertical/smrt-planner/core',
      dir: plannerDir,
      entry: path.join(plannerDir, 'dist/core/index.js'),
    });
    expect(findings, findings.map((f) => JSON.stringify(f)).join('\n')).toEqual(
      [],
    );
  }, 120_000);
});
