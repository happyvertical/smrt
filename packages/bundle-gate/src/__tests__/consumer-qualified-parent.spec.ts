/**
 * Bundled-consumer regression gate for a subclass of a class name two
 * packages declare (#4145, #4176).
 *
 * smrt-commerce and smrt-sales both export `Agreement`. A consumer model
 * extending commerce's must register with commerce's qualified parent, so its
 * inheritance chain, STI descendants, and every other STI model's `toJSON()`
 * stop failing with "Ambiguous class name Agreement". The app's own code is
 * bundled; SMRT packages stay external, as SvelteKit consumers configure them.
 */
import { execFile } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build, type Rollup } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, 'fixtures/consumer-qualified-parent.ts');
const appFixtures = path.resolve(
  here,
  'fixtures/consumer-qualified-parent-app',
);
const gateNodeModules = path.resolve(here, '../../node_modules');
const smrtCli = path.join(
  gateNodeModules,
  '@happyvertical/smrt-cli/bin/smrt.js',
);
const COMMERCE_AGREEMENT = '@happyvertical/smrt-commerce:Agreement';

/** The JSON a fixture prints after `marker`, or a failure naming its output. */
function readResult(stdout: string, marker: string): Record<string, unknown> {
  const line = stdout
    .split('\n')
    .find((candidate) => candidate.startsWith(marker));
  expect(line, `bundle output:\n${stdout}`).toBeDefined();
  return JSON.parse(line?.slice(marker.length) ?? '{}');
}

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

/**
 * #4176: the same consumer as a real app — its model scanned into
 * `.smrt/manifest.json` with the import-qualified parent, bundled, and run
 * from the app root — through every server-side reader of the manifest's
 * parent. anytown.ai#1697 failed here: the first `getAllFields()` re-hydrated
 * the class from its manifest and replaced the qualified parent with the
 * bare `Agreement`, so table binding threw "Ambiguous class name".
 */
describe('scanned consumer app subclass of a same-named package class (#4176)', () => {
  let appRoot: string;

  beforeAll(async () => {
    appRoot = await mkdtemp(path.join(tmpdir(), 'smrt-qualified-parent-app-'));
    const packageJson = {
      name: '@test/consumer',
      version: '0.0.0',
      type: 'module',
      dependencies: {
        '@happyvertical/smrt-commerce': 'workspace:*',
        '@happyvertical/smrt-core': 'workspace:*',
        '@happyvertical/smrt-sales': 'workspace:*',
      },
    };
    await writeFile(
      path.join(appRoot, 'package.json'),
      JSON.stringify(packageJson),
    );
    // Install only what the app depends on, as a real app would: manifest
    // discovery and register generation then see these packages alone.
    await mkdir(path.join(appRoot, 'node_modules/@happyvertical'), {
      recursive: true,
    });
    for (const dependency of Object.keys(packageJson.dependencies)) {
      await symlink(
        await realpath(path.join(gateNodeModules, dependency)),
        path.join(appRoot, 'node_modules', dependency),
        'dir',
      );
    }
    await cp(appFixtures, path.join(appRoot, 'src'), { recursive: true });

    // The consumer manifest pipeline of the smrt Vite plugin (scanWithOxc).
    const { OxcScanner, ManifestAdapter } = await import(
      '@happyvertical/smrt-scanner'
    );
    const { ManifestGenerator } = await import(
      '@happyvertical/smrt-core/scanner'
    );
    const { discoverSmrtPackages } = await import(
      '@happyvertical/smrt-core/manifest/discover-smrt-packages'
    );
    const scanner = new OxcScanner({
      cwd: appRoot,
      include: ['src/AdvertisingProductContract.ts'],
    });
    const { results, resolved } = await scanner.scanAndResolve();
    expect(results.errors).toEqual([]);
    const manifest = new ManifestAdapter().toManifest(resolved, {
      packageName: packageJson.name,
      packageVersion: packageJson.version,
      typeAliases: results.typeAliases,
    });
    manifest.moduleType = 'smrt';
    manifest.smrtDependencies = discoverSmrtPackages({
      baseDir: appRoot,
      noCache: true,
    });
    new ManifestGenerator().applyGenerationPasses(manifest, {
      packageName: packageJson.name,
      packageJson,
    });
    await mkdir(path.join(appRoot, '.smrt'), { recursive: true });
    await writeFile(
      path.join(appRoot, '.smrt/manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    await build({
      configFile: false,
      root: appRoot,
      logLevel: 'error',
      oxc: { decorator: { legacy: true } },
      build: {
        ssr: true,
        outDir: path.join(appRoot, 'build/server'),
        emptyOutDir: true,
        minify: false,
        sourcemap: false,
        target: 'node24',
        rollupOptions: {
          input: { server: path.join(appRoot, 'src/server.ts') },
        },
      },
      ssr: {
        external: [
          '@happyvertical/smrt-core',
          '@happyvertical/smrt-commerce',
          '@happyvertical/smrt-sales',
        ],
      },
    });
  }, 180_000);

  afterAll(async () => {
    if (appRoot) await rm(appRoot, { recursive: true, force: true });
  });

  it('scans the import-qualified parent into the app manifest', async () => {
    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(
      await readFile(path.join(appRoot, '.smrt/manifest.json'), 'utf8'),
    );
    expect(
      manifest.objects['@test/consumer:AdvertisingProductContract'],
    ).toMatchObject({
      extends: 'Agreement',
      extendsQualified: COMMERCE_AGREEMENT,
    });
  });

  it("keeps commerce's Agreement through hydration, STI base and list()", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(appRoot, 'build/server/server.js')],
      { cwd: appRoot, maxBuffer: 10 * 1024 * 1024 },
    );
    const result = readResult(stdout, 'SMRT_QUALIFIED_PARENT_SERVER_RESULT=');

    expect(result).toMatchObject({
      consumer: '@test/consumer:AdvertisingProductContract',
      salesQualifiedName: '@happyvertical/smrt-sales:Agreement',
      registeredExtends: COMMERCE_AGREEMENT,
      hydratedExtends: COMMERCE_AGREEMENT,
      finalExtends: COMMERCE_AGREEMENT,
      appManifestLoaded: true,
      hydrationError: null,
      placementField: true,
      listError: null,
    });
    const chain = result.chain as { value?: string[]; error?: string };
    expect(chain.error).toBeUndefined();
    expect(chain.value).toContain(COMMERCE_AGREEMENT);
    expect(chain.value?.at(-1)).toBe(
      '@test/consumer:AdvertisingProductContract',
    );
    // The consumer joins commerce's STI family and table, not sales'.
    expect(result.stiBase).toEqual({ value: result.commerceStiBase });
    expect(result.commerceStiBase).toMatch(/^@happyvertical\/smrt-commerce:/);
    expect(result.tableName).toBe(result.commerceTable);
  }, 60_000);

  it('passes runtime:check without an ambiguous parent', async () => {
    // runtime:check requires the consumer registrations smrtConsumer() emits.
    await execFileAsync(process.execPath, [smrtCli, 'generate-register'], {
      cwd: appRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    const report = await execFileAsync(
      process.execPath,
      [smrtCli, 'runtime:check'],
      { cwd: appRoot, maxBuffer: 10 * 1024 * 1024 },
    ).then(
      ({ stdout }) => stdout,
      (error: { stdout?: string; stderr?: string }) =>
        `${error.stdout ?? ''}${error.stderr ?? ''}`,
    );

    expect(report, report).not.toMatch(/ambiguous-extends-reference/);
    expect(report, report).toMatch(/\b0 error\(s\)/);
  }, 120_000);
});
