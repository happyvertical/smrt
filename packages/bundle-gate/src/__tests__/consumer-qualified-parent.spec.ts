/**
 * Bundled-consumer regression gate for a subclass of a class name two
 * packages declare (#4145).
 *
 * smrt-commerce and smrt-sales both export `Agreement`. A consumer model
 * extending commerce's must register with commerce's qualified parent, so its
 * inheritance chain, STI descendants, and every other STI model's `toJSON()`
 * stop failing with "Ambiguous class name Agreement". The app's own code is
 * bundled; SMRT packages stay external, as SvelteKit consumers configure them.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build, type Rollup } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, 'fixtures/consumer-qualified-parent.ts');

describe('bundled consumer subclass of a same-named package class (#4145)', () => {
  let tempRoot: string;
  let entryPath: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'smrt-qualified-parent-'));
    const outDir = path.join(tempRoot, 'build', 'server');
    const output = (await build({
      configFile: false,
      logLevel: 'error',
      build: {
        ssr: true,
        outDir,
        emptyOutDir: true,
        minify: false,
        sourcemap: false,
        target: 'node24',
        rollupOptions: { input: { server: fixture } },
      },
      ssr: {
        external: [
          '@happyvertical/smrt-core',
          '@happyvertical/smrt-commerce',
          '@happyvertical/smrt-sales',
        ],
      },
    })) as Rollup.RollupOutput;
    const entry = output.output.find(
      (item): item is Rollup.OutputChunk =>
        item.type === 'chunk' && item.isEntry,
    );
    entryPath = path.join(outDir, entry?.fileName ?? '');
    await writeFile(
      path.join(tempRoot, 'package.json'),
      JSON.stringify({ name: '@test/consumer', type: 'module' }),
    );
    await symlink(
      path.resolve(here, '../../node_modules'),
      path.join(tempRoot, 'node_modules'),
      'dir',
    );
  }, 120_000);

  afterAll(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it("registers the subclass under commerce's Agreement, not sales'", async () => {
    const { stdout } = await execFileAsync(process.execPath, [entryPath], {
      cwd: path.dirname(entryPath),
      maxBuffer: 10 * 1024 * 1024,
    });
    const line = stdout
      .split('\n')
      .find((candidate) =>
        candidate.startsWith('SMRT_QUALIFIED_PARENT_RESULT='),
      );
    expect(line, `bundle output:\n${stdout}`).toBeDefined();
    const result = JSON.parse(
      line?.slice('SMRT_QUALIFIED_PARENT_RESULT='.length) ?? '{}',
    );

    expect(result).toMatchObject({
      consumer: '@test/consumer:AdvertisingProductContract',
      extends: '@happyvertical/smrt-commerce:Agreement',
      commerceDescendant: true,
      salesDescendant: false,
      salesQualifiedName: '@happyvertical/smrt-sales:Agreement',
      toJSONError: null,
    });
    expect(result.chain).toEqual(
      expect.arrayContaining([
        '@happyvertical/smrt-commerce:Agreement',
        '@test/consumer:AdvertisingProductContract',
      ]),
    );
    expect(result.chain.at(-1)).toBe(
      '@test/consumer:AdvertisingProductContract',
    );
  }, 60_000);
});
