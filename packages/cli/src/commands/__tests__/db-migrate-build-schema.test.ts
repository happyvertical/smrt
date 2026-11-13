/**
 * rv1 (#4929 F1, #4928 F2) through the real `db:migrate` handler and real
 * manifest discovery: the project manifest is the build, whatever else is
 * installed, and a production start reads that build, not its own imports.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  assertDatabaseMigratedForBuild,
  ObjectRegistry,
  readLastMigrateRecord,
  registerBuildSchema,
  type SmartObjectDefinition,
  type SmartObjectManifest,
  tryComputeManifestSchemaFingerprint,
} from '@happyvertical/smrt-core';
import { generateManifest } from '@happyvertical/smrt-core/scanner';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';
import { parseCliCommandArgs } from '../../cli-generator.js';
import { utilityCommands } from '../utilities.js';

function packageManifest(name: string, table: string): SmartObjectManifest {
  const className = `${table[4].toUpperCase()}${table.slice(5)}`;
  const definition = {
    name: className.toLowerCase(),
    className,
    collection: table,
    filePath: `src/${table}.ts`,
    extends: 'SmrtObject',
    fields: { label: { type: 'text' } },
    methods: {},
    decoratorConfig: { tableName: table },
    packageName: name,
  } as SmartObjectDefinition;
  return generateManifest(
    [{ filePath: definition.filePath, objects: [definition], errors: [] }],
    { packageName: name },
  );
}

const A = packageManifest('@rv1/smrt-a', 'rv1_widgets');
const B = packageManifest('@rv1/smrt-b', 'rv1_gadgets');
const C = packageManifest('@rv1/smrt-c', 'rv1_gizmos');

describe('db:migrate records the build, not the install (rv1, real SQLite)', () => {
  let project: string;
  let dbUrl: string;
  let cwd: string;
  let build: SmartObjectManifest;
  let logs: ReturnType<typeof vi.spyOn>;

  function install(manifest: SmartObjectManifest): void {
    const dir = join(project, 'node_modules', manifest.packageName as string);
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: manifest.packageName,
        version: '1.0.0',
        dependencies: { '@happyvertical/smrt-core': '*' },
      }),
    );
    writeFileSync(join(dir, 'dist/manifest.json'), JSON.stringify(manifest));
  }
  async function migrate(): Promise<string> {
    process.exitCode = undefined;
    logs.mockClear();
    ObjectRegistry.clear();
    const command = utilityCommands['db:migrate'];
    const parsed = parseCliCommandArgs(['db:migrate'], [command]);
    await requireCommandHandler(command)(parsed.args, parsed.options);
    return logs.mock.calls.map((call) => call.join(' ')).join('\n');
  }
  async function withDb<T>(
    work: (db: DatabaseInterface) => Promise<T>,
  ): Promise<T> {
    const db = await getDatabase({ type: 'sqlite', url: dbUrl });
    try {
      return await work(db);
    } finally {
      await db.close?.();
    }
  }

  beforeEach(() => {
    cwd = process.cwd();
    project = mkdtempSync(join(tmpdir(), 'rv1-cli-build-'));
    dbUrl = join(project, 'app.db');
    // The app's build aggregates A and B; C is installed (a dev dependency the
    // build does not include, or a hoisted transitive package).
    build = {
      version: '1.0.0',
      timestamp: 0,
      packageName: 'rv1-app',
      objects: { ...A.objects, ...B.objects },
      smrtDependencies: ['@rv1/smrt-a', '@rv1/smrt-b'],
    } as SmartObjectManifest;
    build.schemaFingerprint = tryComputeManifestSchemaFingerprint(build);
    mkdirSync(join(project, '.smrt'));
    writeFileSync(join(project, '.smrt/manifest.json'), JSON.stringify(build));
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({ name: 'rv1-app', version: '1.0.0' }),
    );
    for (const manifest of [A, B, C]) install(manifest);
    process.chdir(project);
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: dbUrl } } },
    });
    logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(cwd);
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    registerBuildSchema(undefined);
    ObjectRegistry.clear();
    clearCache();
    rmSync(project, { recursive: true, force: true });
  });

  it('probe: after the CLI migrate, a production process that loaded only A starts', async () => {
    await migrate();
    expect(process.exitCode ?? 0).toBe(0);
    // A new process: nothing registered, only A imported, the build on disk.
    registerBuildSchema(undefined);
    ObjectRegistry.clear();
    for (const [key, definition] of Object.entries(A.objects))
      ObjectRegistry.registerFromManifest(key, definition, '@rv1/smrt-a');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SMRT_ALLOW_UNMIGRATED_START', '');
    vi.stubEnv('SMRT_BUILD_MANIFEST', join(project, '.smrt/manifest.json'));
    await withDb(async (db) => {
      await expect(assertDatabaseMigratedForBuild(db)).resolves.toBe(undefined);
    });
  });
});
