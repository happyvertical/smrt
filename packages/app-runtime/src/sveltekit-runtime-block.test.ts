/**
 * Runtime-block parity with `smrt app` (#3446).
 *
 * With no `runtime` option, the SvelteKit runtime resolves the profile from
 * the `smrt.config` found from the working directory. It must apply the same
 * rule as the operator CLI (`resolveEffectiveApplicationRuntime`): an absent
 * block is the `local` profile, and a present value that is not a block
 * (`null`, `false`, `0`, `''`) fails closed with the same error.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearCache,
  RuntimeProfileValidationError,
  resolveApplicationRuntime,
  resolveEffectiveApplicationRuntime,
  type SmrtConfig,
} from '@happyvertical/smrt-config';
import { afterEach, describe, expect, it } from 'vitest';
import { createSmrtSvelteKitRuntime } from './sveltekit.js';

const originalCwd = process.cwd();
const roots: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  clearCache();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A fresh directory per config: Node caches an imported config by URL. */
function appWithConfig(source: string | null): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-runtime-block-')));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'runtime-block-fixture', type: 'module' }),
  );
  if (source !== null) {
    writeFileSync(join(root, 'smrt.config.mjs'), source);
  }
  process.chdir(root);
  return root;
}

function sharedResolverError(value: unknown): string {
  try {
    resolveEffectiveApplicationRuntime({ runtime: value } as SmrtConfig);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the shared resolver to reject');
}

describe('configured runtime block (#3446)', () => {
  it.each([
    ['a config with no runtime block', 'export default { knowledge: {} };\n'],
    [
      'an explicitly undefined runtime',
      'export default { runtime: undefined };\n',
    ],
    ['no smrt.config at all', null],
  ])('selects the local profile for %s', async (_label, source) => {
    const sourceRoot = appWithConfig(source);
    const runtime = createSmrtSvelteKitRuntime({ sourceRoot, env: {} });
    expect(await runtime.resolvedRuntime()).toEqual(
      resolveApplicationRuntime({ profile: 'local' }),
    );
  });

  it('passes an explicit runtime block through', async () => {
    const sourceRoot = appWithConfig(
      "export default { runtime: { profile: 'self-hosted' } };\n",
    );
    const runtime = createSmrtSvelteKitRuntime({ sourceRoot, env: {} });
    expect((await runtime.resolvedRuntime()).profile).toBe('self-hosted');
  });

  it.each([
    ['null', null],
    ['false', false],
    ['0', 0],
    ["''", ''],
  ])('fails closed on a present but falsy runtime (runtime: %s), like smrt app', async (literal, value) => {
    const sourceRoot = appWithConfig(
      `export default { runtime: ${literal} };\n`,
    );
    const runtime = createSmrtSvelteKitRuntime({ sourceRoot, env: {} });
    const failure = await runtime.resolvedRuntime().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RuntimeProfileValidationError);
    expect((failure as Error).message).toBe(sharedResolverError(value));
  });
});
