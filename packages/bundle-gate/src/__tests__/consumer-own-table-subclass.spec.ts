/**
 * Consumer-package gate for #4922: an app class with the SAME name as an
 * own-table package class it extends (smrt-messages' `Attachment`) keeps the
 * parent's fields in its table definition, with the app's override and added
 * field applied, and enforces the overridden `required` rule on save.
 *
 * The app model is scanned into `.smrt/manifest.json` with the real scanner
 * and manifest generator (the consumer manifest pipeline of the smrt Vite
 * plugin), then registered from that manifest next to the installed package,
 * as the CLI's manifest discovery does, in a process run from the app root.
 * (Which constructor a bundled same-named class registers is #4921.)
 */
import { execFile } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const appFixtures = path.resolve(
  here,
  'fixtures/consumer-own-table-subclass-app',
);
const gateNodeModules = path.resolve(here, '../../node_modules');
const MESSAGES_ATTACHMENT = '@happyvertical/smrt-messages:Attachment';
const CONSUMER = '@test/consumer:Attachment';

describe('scanned consumer subclass of a same-named own-table package class (#4922)', () => {
  let appRoot: string;

  beforeAll(async () => {
    appRoot = await mkdtemp(path.join(tmpdir(), 'smrt-own-table-subclass-'));
    const packageJson = {
      name: '@test/consumer',
      version: '0.0.0',
      type: 'module',
      dependencies: {
        '@happyvertical/smrt-core': 'workspace:*',
        '@happyvertical/smrt-messages': 'workspace:*',
      },
    };
    await writeFile(
      path.join(appRoot, 'package.json'),
      JSON.stringify(packageJson),
    );
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
      include: ['src/Attachment.ts'],
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
        external: ['@happyvertical/smrt-core', '@happyvertical/smrt-messages'],
      },
    });
  }, 180_000);

  afterAll(async () => {
    if (appRoot) await rm(appRoot, { recursive: true, force: true });
  });

  it("puts the parent's fields in the app manifest entry and table definition", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(appRoot, '.smrt/manifest.json'), 'utf8'),
    );
    const entry = manifest.objects[CONSUMER];
    expect(entry.extendsQualified).toBe(MESSAGES_ATTACHMENT);
    expect(Object.keys(entry.fields)).toEqual(
      expect.arrayContaining([
        'contentType',
        'size',
        'filename',
        'virusScanned',
      ]),
    );
    expect(entry.schema.columns.content_type).toBeDefined();
    expect(entry.schema.columns.filename.notNull).toBe(true);
    expect(entry.schema.columns.virus_scanned).toBeDefined();
  });

  it('keeps the inherited columns in the registry, enforces the override and stores inherited values', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(appRoot, 'build/server/server.js')],
      { cwd: appRoot, maxBuffer: 10 * 1024 * 1024 },
    );
    const line = stdout
      .split('\n')
      .find((candidate) =>
        candidate.startsWith('SMRT_OWN_TABLE_SUBCLASS_RESULT='),
      );
    expect(line, `server output:\n${stdout}`).toBeDefined();
    const result = JSON.parse(
      line?.slice('SMRT_OWN_TABLE_SUBCLASS_RESULT='.length) ?? '{}',
    );

    expect(result.consumer).toBe(CONSUMER);
    expect(result.fields).toEqual(
      expect.arrayContaining([
        'contentType',
        'size',
        'filename',
        'virusScanned',
      ]),
    );
    expect(result.registryFields).toEqual(
      expect.arrayContaining([
        'contentType',
        'size',
        'filename',
        'virusScanned',
      ]),
    );
    // Inherited column, overridden NOT NULL, added column.
    expect(result.columns).toHaveProperty('content_type');
    expect(result.columns.filename).toBe(true);
    expect(result.columns).toHaveProperty('virus_scanned');
    // One table: the app's class replaced the parent's, columns are single.
    expect(result.rows).toEqual([
      {
        filename: 'a.txt',
        content_type: 'text/plain',
        size: 1,
        virus_scanned: 1,
      },
    ]);
    // The overridden `required` rule is enforced on save.
    expect(result.refusal, 'saving without filename must be refused').toMatch(
      /filename/i,
    );
    expect(result.rowCount).toBe(1);
  }, 60_000);
});
