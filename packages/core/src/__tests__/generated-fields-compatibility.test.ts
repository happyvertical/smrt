/**
 * No-generated-field compatibility contract for #4915/#4972.
 * Byte digests and SQLite deployment SQL were captured by executing this test
 * with the production sources of the data-shape release branch (#4920) just
 * before #4972 was merged into it, 0f16192e1b3b5d64b639cce688aaa35075a71464.
 * No output normalization is applied. Fixture provenance lives beside the JSON.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../decorators/index.js';
import { MCPGenerator } from '../generators/mcp.js';
import { generateOpenAPISpec } from '../generators/swagger.js';
import { SchemaComparer } from '../migrations/differ.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { registerRuntimeModel, runtimeModelEntry } from '../runtime-model.js';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { getDDLStrategy } from '../schema/ddl/index.js';
import { SchemaGenerator } from '../schema/generator.js';
import { manifestSchemaToDefinition } from '../schema/manifest-schema.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';
import { generateSvelteKitRoutes } from '../vite-plugin/sveltekit-generator.js';

const BASELINE = '0f16192e1b3b5d64b639cce688aaa35075a71464';
const fixturePath = join(
  import.meta.dirname,
  'fixtures/generated-fields-origin-main.json',
);
interface Expectation {
  sqliteDeployment: string[];
  sha256: Record<string, string>;
}
interface Fixture {
  sourceRevision: string;
  cases: Record<string, Expectation>;
}
function captureRequested(): boolean {
  if (process.env.SMRT_CAPTURE_ORIGIN_MAIN !== BASELINE) return false;
  // Check the worktree against the actual source commit, including new/deleted
  // production files. A matching env string alone is never provenance.
  try {
    execFileSync(
      'git',
      [
        'diff',
        '--quiet',
        BASELINE,
        '--',
        'packages/core/src',
        ':(exclude)packages/core/src/__tests__/**',
        ':(exclude)packages/core/src/**/__tests__/**',
        ':(exclude)packages/core/src/**/*.test.ts',
        ':(exclude)packages/core/src/**/*.spec.ts',
        ':(exclude)packages/core/src/test-utils.ts',
        ':(exclude)packages/core/src/testing/**',
      ],
      { cwd: join(import.meta.dirname, '../../../..'), stdio: 'pipe' },
    );
  } catch (cause) {
    throw new Error(
      `Capture requires baseline sources from ${BASELINE}; restore production sources from that commit before recapturing`,
      { cause },
    );
  }
  return true;
}

async function sources(
  directory: string,
  prefix = '',
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const item of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const path = join(directory, item.name);
    const key = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) Object.assign(files, await sources(path, key));
    else if (item.name.endsWith('.ts'))
      files[key] = await readFile(path, 'utf8');
  }
  return files;
}

describe('plain-model byte compatibility with origin/main #4972 round2', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
  });
  afterEach(() => restore());

  for (const kind of ['plain', 'sti'] as const) {
    it(`${kind}: manifest, DDL, migration diff, OpenAPI and generated source match pre-PR bytes`, async () => {
      const updating = captureRequested();
      const entries: SmartObjectDefinition[] = [];
      const pkg = '@test/generated-compat';
      if (kind === 'plain') {
        const def = {
          name: 'CompatPlain',
          packageName: pkg,
          tableName: 'compat_plain',
          fields: {
            title: { type: 'text' as const, required: true },
            qty: { type: 'integer' as const },
          },
        };
        entries.push(runtimeModelEntry(def));
        registerRuntimeModel(def);
      } else {
        const Root = class CompatRoot extends SmrtObject {};
        field({ type: 'integer', required: true })(Root.prototype, 'qty');
        smrt({
          packageName: pkg,
          tableStrategy: 'sti',
          tableName: 'compat_roots',
          api: { public: true },
        })(Root);
        const Middle = class CompatMiddle extends Root {};
        field({ type: 'text', unique: true, required: true })(
          Middle.prototype,
          'serial',
        );
        smrt({ packageName: pkg })(Middle);
        const def = {
          name: 'CompatLeaf',
          packageName: pkg,
          extends: `${pkg}:CompatMiddle`,
          fields: {},
        };
        entries.push(runtimeModelEntry(def));
        registerRuntimeModel(def);
        // Include the real root/middle declarations in generated route fixtures.
        for (const ctor of [Root, Middle]) {
          const info = ObjectRegistry.getClassByConstructor(ctor)!;
          entries.unshift({
            name: info.name.toLowerCase(),
            className: info.name,
            qualifiedName: info.qualifiedName,
            packageName: pkg,
            collection: info.collection!,
            filePath: `fixtures/${info.name}.ts`,
            fields: Object.fromEntries(info.fields),
            methods: {},
            decoratorConfig: info.config,
            ...(info.extends
              ? {
                  extends: info.extends.split(':').at(-1),
                  ...(info.extends.includes(':')
                    ? { extendsQualified: info.extends }
                    : {}),
                }
              : {}),
          });
        }
      }
      const manifest = {
        packageName: pkg,
        version: '1',
        timestamp: 0,
        objects: Object.fromEntries(
          entries.map((entry) => [entry.qualifiedName!, entry]),
        ),
      } as SmartObjectManifest;
      if (kind === 'sti')
        expect(
          manifest.objects[`${pkg}:CompatMiddle`].fields.serial._meta?.unique,
        ).toBe(true);
      const tables = kind === 'plain' ? ['compat_plain'] : ['compat_roots'];
      const registrySchemas = ObjectRegistry.getAllSchemasAsDefinitions({
        tables,
      });
      const schemas =
        kind === 'sti'
          ? {
              compat_roots: manifestSchemaToDefinition(
                new SchemaGenerator().generateSTISchemaFromManifest(
                  `${pkg}:CompatRoot`,
                  'compat_roots',
                  {},
                  manifest,
                ),
              ),
            }
          : registrySchemas;
      const artifacts: Record<string, string> = {
        manifest: JSON.stringify(entries, null, 2),
        schema: JSON.stringify(schemas, null, 2),
        registrySchema: JSON.stringify(registrySchemas, null, 2),
        openapi: JSON.stringify(generateOpenAPISpec(), null, 2),
      };
      for (const engine of ['sqlite', 'postgres', 'duckdb'] as const) {
        const strategy = getDDLStrategy(engine);
        artifacts[`ddl/${engine}`] = Object.values(schemas)
          .flatMap((schema) => [
            strategy.generateCreateTable(schema),
            ...strategy.generateIndexes(schema),
          ])
          .join('\n');
      }
      const currentDeployment = Object.values(schemas).flatMap((schema) => [
        getDDLStrategy('sqlite').generateCreateTable(schema),
        ...getDDLStrategy('sqlite').generateIndexes(schema),
      ]);
      const fixture: Fixture = updating
        ? await readFile(fixturePath, 'utf8')
            .then(JSON.parse)
            .catch(() => ({ sourceRevision: BASELINE, cases: {} }))
        : JSON.parse(await readFile(fixturePath, 'utf8'));
      expect(fixture.sourceRevision).toBe(BASELINE);
      const deployment = updating
        ? currentDeployment
        : fixture.cases[kind].sqliteDeployment;
      const db = await getTestDatabase({
        type: 'sqlite',
        classes: [],
        includeSystemTables: false,
      });
      const root = await mkdtemp(join(tmpdir(), 'smrt-generated-compat-'));
      try {
        for (const sql of deployment) await db.query(sql);
        artifacts.migration = JSON.stringify(
          await new SchemaComparer(db, { engineHint: 'sqlite' }).compare(
            schemas,
          ),
          null,
          2,
        );
        const generator = new MCPGenerator({
          name: 'compat',
          version: '1',
          classNames: [...ObjectRegistry.getAllClasses().keys()],
        });
        await generator.generateServer({
          outputPath: join(root, 'single/index.ts'),
        });
        await generator.generateServer({
          outputPath: join(root, 'modular/index.ts'),
          modular: true,
        });
        await generateSvelteKitRoutes(join(root, 'sveltekit'), manifest, {
          enabled: true,
          routesDir: 'src/routes/api',
          objectsDir: 'src/lib/objects',
          configPath: 'src/lib/server',
          configFileName: 'smrt.ts',
        });
        for (const [path, source] of Object.entries(await sources(root)))
          artifacts[`source/${path}`] = source;
        const sha256 = Object.fromEntries(
          Object.entries(artifacts).map(([name, content]) => [
            name,
            createHash('sha256').update(content).digest('hex'),
          ]),
        );
        if (updating) {
          fixture.cases[kind] = { sqliteDeployment: currentDeployment, sha256 };
          await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
        } else {
          expect(sha256).toEqual(fixture.cases[kind].sha256);
        }
      } finally {
        await db.close?.();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

describe('compatibility fixture capture provenance #4972 round3', () => {
  it('permits capture only from verified baseline production sources', () => {
    // The explicit capture lane also executes this positive check against the
    // real baseline tree. Ordinary validation exercises feature-tree refusal.
    if (process.env.SMRT_CAPTURE_ORIGIN_MAIN === BASELINE) {
      expect(captureRequested()).toBe(true);
      return;
    }
    const previous = process.env.SMRT_CAPTURE_ORIGIN_MAIN;
    process.env.SMRT_CAPTURE_ORIGIN_MAIN = BASELINE;
    try {
      expect(() => captureRequested()).toThrow(/baseline sources/i);
    } finally {
      if (previous === undefined) delete process.env.SMRT_CAPTURE_ORIGIN_MAIN;
      else process.env.SMRT_CAPTURE_ORIGIN_MAIN = previous;
    }
  });
});
