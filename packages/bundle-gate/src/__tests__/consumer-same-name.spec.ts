/**
 * Bundled-consumer regression gate for same-named classes (#3106).
 *
 * A consumer's own `LicenseSale` (ergot's marketplace model, `license_sales`)
 * and smrt-commerce's `LicenseSale` (`Contract` STI subtype on `contracts`)
 * must keep separate identities in a production server bundle. Before #3106
 * the bundled consumer class was accepted into commerce's registration as a
 * "bundled duplicate", binding the consumer model to commerce's table and
 * dropping commerce's constructor. The app's own code is bundled; SMRT
 * packages stay external, as SvelteKit consumers configure them so their
 * package identity is stable.
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
const fixture = path.resolve(here, 'fixtures/consumer-same-name.ts');

interface SameNameResult {
  consumer: {
    qualifiedName?: string;
    tableName?: string;
    constructorMatches: boolean;
  };
  provider: {
    qualifiedName?: string;
    tableName?: string;
    constructorMatches: boolean;
  };
  tables: string[];
}

describe('bundled consumer class next to a same-named package class (#3106)', () => {
  let tempRoot: string;
  let entryPath: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'smrt-same-name-gate-'));
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
        external: ['@happyvertical/smrt-core', '@happyvertical/smrt-commerce'],
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

  for (const order of ['provider-first', 'consumer-first'] as const) {
    it(`keeps both LicenseSale classes on their own identity and table (${order})`, async () => {
      const { stdout } = await execFileAsync(process.execPath, [entryPath], {
        cwd: path.dirname(entryPath),
        env: { ...process.env, SMRT_GATE_ORDER: order },
        maxBuffer: 10 * 1024 * 1024,
      });
      const line = stdout
        .split('\n')
        .find((candidate) => candidate.startsWith('SMRT_SAME_NAME_RESULT='));
      expect(line, `bundle output:\n${stdout}`).toBeDefined();
      const result = JSON.parse(
        line?.slice('SMRT_SAME_NAME_RESULT='.length) ?? '{}',
      ) as SameNameResult;

      expect(result.consumer).toEqual({
        qualifiedName: '@test/consumer:LicenseSale',
        tableName: 'license_sales',
        constructorMatches: true,
      });
      expect(result.provider).toEqual({
        qualifiedName: '@happyvertical/smrt-commerce:LicenseSale',
        tableName: 'contracts',
        constructorMatches: true,
      });
      expect(result.tables).toEqual(['contracts', 'license_sales']);
    }, 60_000);
  }
});
