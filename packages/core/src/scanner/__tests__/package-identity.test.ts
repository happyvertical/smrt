/**
 * A parent, relationship target, report source or collection item imported
 * from another package is that package's model, proven by identity and by the
 * entry it is imported from, or generation fails.
 *
 * Each case builds real provider packages (scanned and generated like any
 * dependency, so they carry `importPath` and schemas) and an app that imports
 * from them beside a competing class of the same name, then asserts what the
 * app's manifest actually gets: table, fields, effective CRUD, DDL.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManifestBuilder } from '../../manifest/generator.js';
import { resolveStandardCrudActions } from '../../vite-plugin/web-collections.js';
import { ManifestGenerator } from '../manifest-generator.js';
import type { ScanResult, SmartObjectDefinition } from '../types.js';

const APP = '@fixture/identity-app';
const VENDOR = '@fixture/identity-vendor';
const OTHER = '@fixture/identity-other';
const CORE = `import { SmrtObject, SmrtCollection, smrt, foreignKey, report } from '@happyvertical/smrt-core';`;
const OPEN_API = { include: ['list', 'get', 'create', 'update', 'delete'] };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function write(base: string, files: Record<string, string>) {
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), source);
  }
}

function buildOptions(extra: Record<string, unknown> = {}) {
  return {
    include: ['src/**/*.ts'],
    discoverExternalPackages: true,
    outputMode: 'dev' as const,
    outputDir: '.smrt',
    generateTypeStub: false,
    ...extra,
  };
}

/**
 * An app root with providers installed. Each provider is scanned and
 * generated as a package (its own sources, its `exports`), and its manifest
 * written where discovery reads it.
 */
async function project(options: {
  providers: Record<
    string,
    {
      files: Record<string, string>;
      exports?: Record<string, string>;
      dependencies?: string[];
      /** Edit the generated manifest before it is installed. */
      edit?: (manifest: Record<string, unknown>) => void;
    }
  >;
  app: Record<string, string>;
}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-identity-')));
  roots.push(root);
  for (const [name, provider] of Object.entries(options.providers)) {
    const dir = join(root, 'node_modules', name);
    write(dir, {
      'package.json': JSON.stringify({
        name,
        version: '1.0.0',
        type: 'module',
        exports: {
          '.': './dist/index.js',
          './manifest': './dist/manifest.json',
          ...provider.exports,
        },
        dependencies: Object.fromEntries(
          (provider.dependencies ?? []).map((d) => [d, '*']),
        ),
      }),
      'dist/index.js': 'export {};\n',
      ...provider.files,
    });
    const manifest = (await new ManifestBuilder(dir).generate(
      buildOptions({ discoverExternalPackages: false }),
    )) as unknown as Record<string, unknown>;
    provider.edit?.(manifest);
    write(dir, { 'dist/manifest.json': JSON.stringify(manifest) });
  }
  write(root, {
    'package.json': JSON.stringify({
      name: APP,
      version: '0.0.0',
      dependencies: Object.fromEntries(
        Object.keys(options.providers).map((d) => [d, '*']),
      ),
    }),
    ...options.app,
  });
  return root;
}

function build(root: string, extra: Record<string, unknown> = {}) {
  return new ManifestBuilder(root).generate(buildOptions(extra));
}

const crud = (obj: SmartObjectDefinition | undefined) =>
  resolveStandardCrudActions(obj?.decoratorConfig.api).sort();

const CLOSED_EVENT = `${CORE}
@smrt({ tableStrategy: 'sti', tableName: 'vendor_events', api: { include: ['list', 'get'] } })
export class Event extends SmrtObject {
  startsAt = '';
}
`;
const meeting = (specifier: string) => `${CORE}
import { Event } from '${specifier}';
@smrt()
export class Meeting extends Event {
  room = '';
}
`;

describe('the entry a package parent is imported from', () => {
  it('confirms a parent imported from a declared package subpath at its entry', async () => {
    const root = await project({
      providers: {
        [VENDOR]: {
          files: { 'src/models/Event.ts': CLOSED_EVENT },
          exports: { './models': './dist/models.js' },
        },
      },
      app: { 'src/Meeting.ts': meeting(`${VENDOR}/models`) },
    });

    const manifest = await build(root);
    const child = manifest.objects[`${APP}:Meeting`];
    expect(child?.extendsQualified).toBe(`${VENDOR}:Event`);
    expect(child?.extendsImportPath).toBe(`${VENDOR}/models`);
    expect(child?.decoratorConfig.tableName).toBe('vendor_events');
    expect(crud(child)).toEqual(['get', 'list']);
  });

  it.each([
    ['a subpath that exports a plain class of the name', './legacy'],
    ['a subpath that re-exports another package', './compat'],
  ])('fails for %s, whatever the manifest declares at the root', async (_label, subpath) => {
    const root = await project({
      providers: {
        [VENDOR]: {
          files: { 'src/Event.ts': CLOSED_EVENT },
          exports: {
            './legacy': './dist/legacy.js',
            './compat': './dist/compat.js',
          },
        },
      },
      app: { 'src/Meeting.ts': meeting(`${VENDOR}/${subpath.slice(2)}`) },
    });

    await expect(build(root)).rejects.toMatchObject({
      code: 'CONFIG_UNRESOLVED_IMPORTED_PARENT',
      message: expect.stringContaining(`import Event from '${VENDOR}'`),
    });
  });

  it('fails when the provider manifest does not record the entry', async () => {
    const root = await project({
      providers: {
        [VENDOR]: {
          files: { 'src/Event.ts': CLOSED_EVENT },
          edit: (manifest) => {
            for (const obj of Object.values(
              manifest.objects as Record<string, Record<string, unknown>>,
            )) {
              delete obj.importPath;
            }
          },
        },
      },
      app: { 'src/Meeting.ts': meeting(VENDOR) },
    });

    await expect(build(root)).rejects.toMatchObject({
      code: 'CONFIG_UNRESOLVED_IMPORTED_PARENT',
      message: expect.stringContaining('does not record the entry'),
    });
  });

  it('fails for a class imported from a package that only re-exports it, naming the declaring package', async () => {
    const root = await project({
      providers: {
        [OTHER]: { files: { 'src/Event.ts': CLOSED_EVENT } },
        [VENDOR]: {
          files: {
            'src/Plain.ts': `${CORE}\n@smrt()\nexport class Plain extends SmrtObject {}\n`,
            'src/index.ts': `export { Event } from '${OTHER}';\n`,
          },
          dependencies: [OTHER],
        },
      },
      app: { 'src/Meeting.ts': meeting(VENDOR) },
    });

    await expect(build(root)).rejects.toMatchObject({
      code: 'CONFIG_UNRESOLVED_IMPORTED_PARENT',
      message: expect.stringContaining(
        'import it from the package that declares it',
      ),
    });
  });
});

describe('framework names and configured bases keep their identity', () => {
  const RESTRICTED = `${CORE}
@smrt({ api: false })
export class RestrictedBase extends SmrtObject {
  secret = '';
}
`;
  const OPEN_NAMESAKE = `${CORE}
@smrt({ tableName: 'local_restricted' })
export class RestrictedBase extends SmrtObject {
  open = '';
}
`;

  it('keeps the package identity of a configured external base beside an open namesake', async () => {
    const root = await project({
      providers: {
        [VENDOR]: { files: { 'src/RestrictedBase.ts': RESTRICTED } },
      },
      app: {
        'src/local/RestrictedBase.ts': OPEN_NAMESAKE,
        'src/Child.ts': `import { RestrictedBase } from '${VENDOR}';\nexport class Child extends RestrictedBase {\n  note = '';\n}\n`,
      },
    });

    const manifest = await build(root, { includeExternalBaseClasses: true });
    const child = manifest.objects[`${APP}:Child`];
    expect(child?.extendsQualified).toBe(`${VENDOR}:RestrictedBase`);
    expect(crud(child)).toEqual([]);
  });

  it('keeps the local identity of a child that extends the local namesake', async () => {
    const root = await project({
      providers: {
        [VENDOR]: { files: { 'src/RestrictedBase.ts': RESTRICTED } },
      },
      app: {
        'src/local/RestrictedBase.ts': OPEN_NAMESAKE,
        'src/local/Child.ts': `${CORE}\nimport { RestrictedBase } from './RestrictedBase';\n@smrt()\nexport class Child extends RestrictedBase {\n  note = '';\n}\n`,
      },
    });

    const manifest = await build(root, { includeExternalBaseClasses: true });
    const child = manifest.objects[`${APP}:Child`];
    expect(child?.extendsQualified).toBeUndefined();
    expect(crud(child).length).toBe(5);
  });

  it('inherits exposure from a confirmed provider model named SmrtReport', async () => {
    const root = await project({
      providers: {
        [VENDOR]: {
          files: {
            'src/SmrtReport.ts': `${CORE}\n@smrt({ api: false })\nexport class SmrtReport extends SmrtObject {\n  hidden = '';\n}\n`,
          },
        },
      },
      app: {
        'src/Summary.ts': `${CORE}\nimport { SmrtReport } from '${VENDOR}';\n@smrt()\nexport class Summary extends SmrtReport {}\n`,
      },
    });

    const manifest = await build(root);
    const child = manifest.objects[`${APP}:Summary`];
    expect(child?.extendsQualified).toBe(`${VENDOR}:SmrtReport`);
    expect(crud(child)).toEqual([]);
  });

  it('inherits exposure from a local model named like a framework base', async () => {
    const root = await project({
      providers: {},
      app: {
        'src/SmrtReport.ts': `${CORE}\n@smrt({ api: false })\nexport class SmrtReport extends SmrtObject {\n  hidden = '';\n}\n`,
        'src/Summary.ts': `${CORE}\nimport { SmrtReport } from './SmrtReport';\n@smrt()\nexport class Summary extends SmrtReport {}\n`,
      },
    });

    const manifest = await build(root);
    const child = manifest.objects[`${APP}:Summary`];
    expect(child?.extendsQualified).toBe(`${APP}:SmrtReport`);
    expect(crud(child)).toEqual([]);
  });

  it('throws for an extendsQualified that is not a qualified name', () => {
    const scanResults: ScanResult[] = [
      {
        filePath: '/app/src',
        objects: [
          {
            name: 'meeting',
            className: 'Meeting',
            collection: 'meetings',
            filePath: '/app/src/Meeting.ts',
            fields: {},
            methods: {},
            decoratorConfig: {},
            packageName: APP,
            extends: 'BaseEvent',
            extendsQualified: 'models:BaseEvent',
          } as SmartObjectDefinition,
        ],
        errors: [],
      },
    ];

    expect(() =>
      new ManifestGenerator().generateManifest(scanResults, {
        packageName: APP,
        projectRoot: '/nonexistent/identity-app',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'CONFIG_UNRESOLVED_IMPORTED_PARENT',
        message: expect.stringContaining('not a qualified name'),
      }),
    );
  });
});

describe('ancestors reached through a provider parent', () => {
  it('takes the provider’s single-table root, not an app class of the root’s name', async () => {
    const root = await project({
      providers: {
        [VENDOR]: {
          files: {
            'src/Root.ts': `${CORE}\n@smrt({ tableStrategy: 'sti', tableName: 'vendor_roots' })\nexport class Root extends SmrtObject {\n  vendorOnly = '';\n}\n`,
            'src/Mid.ts': `${CORE}\nimport { Root } from './Root';\n@smrt()\nexport class Mid extends Root {\n  middle = '';\n}\n`,
          },
        },
      },
      app: {
        'src/Root.ts': `${CORE}\n@smrt({ tableStrategy: 'sti', tableName: 'app_roots' })\nexport class Root extends SmrtObject {\n  appOnly = '';\n}\n`,
        'src/Leaf.ts': `${CORE}\nimport { Mid } from '${VENDOR}';\n@smrt()\nexport class Leaf extends Mid {\n  leaf = '';\n}\n`,
      },
    });

    const manifest = await build(root);
    const leaf = manifest.objects[`${APP}:Leaf`];
    expect(leaf?.decoratorConfig.tableName).toBe('vendor_roots');
    expect(leaf?.schema?.tableName).toBe('vendor_roots');
    expect(Object.keys(leaf?.fields ?? {})).toEqual(
      expect.arrayContaining(['vendorOnly', 'middle', 'leaf']),
    );
    expect(Object.keys(leaf?.fields ?? {})).not.toContain('appOnly');
    expect(leaf?.schema?.ddl).toContain('vendor_roots');
    expect(leaf?.schema?.ddl).not.toContain('app_roots');
  });
});

describe('relationship targets imported from a package', () => {
  const RUN = `${CORE}\n@smrt({ tableName: 'production_runs' })\nexport class ProductionRun extends SmrtObject {\n  code = '';\n}\n`;
  const order = (extra = '') => `${CORE}
import { ProductionRun } from '${VENDOR}';
@smrt()
export class WorkOrder extends SmrtObject {
  @foreignKey(ProductionRun, { onDelete: 'RESTRICT' }) productionRunId = '';
${extra}}
`;

  it('confirms a package target before schemas and references the provider table', async () => {
    const root = await project({
      providers: { [VENDOR]: { files: { 'src/ProductionRun.ts': RUN } } },
      app: { 'src/WorkOrder.ts': order() },
    });

    const manifest = await build(root);
    const field = manifest.objects[`${APP}:WorkOrder`]?.fields.productionRunId;
    expect(field?.relatedQualified).toBe(`${VENDOR}:ProductionRun`);
    expect(field?.related).toBe('ProductionRun');
    const column =
      manifest.objects[`${APP}:WorkOrder`]?.schema?.columns.production_run_id;
    // The constraint migrations create (`ALTER TABLE ... REFERENCES`) is
    // read from the column's foreignKey.
    expect(column?.foreignKey).toMatchObject({
      table: 'production_runs',
      column: 'id',
      onDelete: 'RESTRICT',
    });
  });

  it('fails a package target that a local model’s name shadows, before any DDL', async () => {
    const root = await project({
      providers: { [VENDOR]: { files: { 'src/ProductionRun.ts': RUN } } },
      app: {
        'src/ProductionRun.ts': `${CORE}\n@smrt({ tableName: 'app_runs' })\nexport class ProductionRun extends SmrtObject {}\n`,
        'src/WorkOrder.ts': order(),
      },
    });

    await expect(build(root)).rejects.toMatchObject({
      code: 'CONFIG_AMBIGUOUS_RELATIONSHIP_TARGET',
      message: expect.stringContaining(`${APP}:ProductionRun`),
    });
  });

  it('fails a package target that another dependency also declares', async () => {
    const root = await project({
      providers: {
        [VENDOR]: { files: { 'src/ProductionRun.ts': RUN } },
        [OTHER]: {
          files: {
            'src/ProductionRun.ts': RUN.replace(
              'production_runs',
              'other_runs',
            ),
          },
        },
      },
      app: { 'src/WorkOrder.ts': order() },
    });

    await expect(build(root)).rejects.toMatchObject({
      code: 'CONFIG_AMBIGUOUS_RELATIONSHIP_TARGET',
      message: expect.stringContaining(OTHER),
    });
  });

  it('accepts a package target that an app replacement shares its table with', async () => {
    const root = await project({
      providers: { [VENDOR]: { files: { 'src/ProductionRun.ts': RUN } } },
      app: {
        'src/ProductionRun.ts': `${CORE}\nimport { ProductionRun as BaseRun } from '${VENDOR}';\n@smrt({ tableName: 'production_runs' })\nexport class ProductionRun extends BaseRun {\n  appNote = '';\n}\n`,
        'src/WorkOrder.ts': order(),
      },
    });

    const manifest = await build(root);
    expect(
      manifest.objects[`${APP}:WorkOrder`]?.schema?.columns.production_run_id
        ?.foreignKey?.table,
    ).toBe('production_runs');
  });

  it('ignores a namesake in a package generation does not read', () => {
    // `@fixture/unread` declares ProductionRun but is neither a dependency
    // nor a parent's package: no bare-name lookup can reach it.
    const generator = new ManifestGenerator();
    const scanResults: ScanResult[] = [
      {
        filePath: '/app/src',
        objects: [
          {
            name: 'workorder',
            className: 'WorkOrder',
            collection: 'workorders',
            filePath: '/app/src/WorkOrder.ts',
            fields: {
              productionRunId: {
                type: 'foreignKey',
                related: 'ProductionRun',
                relatedQualified: `${VENDOR}:ProductionRun`,
                relatedImportPath: VENDOR,
              },
            },
            methods: {},
            decoratorConfig: {},
            packageName: APP,
          } as SmartObjectDefinition,
        ],
        errors: [],
      },
    ];
    const loaded = {
      [VENDOR]: {
        version: '1.0.0',
        packageName: VENDOR,
        objects: {
          [`${VENDOR}:ProductionRun`]: {
            name: 'productionrun',
            className: 'ProductionRun',
            qualifiedName: `${VENDOR}:ProductionRun`,
            packageName: VENDOR,
            importPath: VENDOR,
            collection: 'productionruns',
            filePath: 'src/ProductionRun.ts',
            fields: {},
            methods: {},
            decoratorConfig: { tableName: 'production_runs' },
            schema: {
              tableName: 'production_runs',
              columns: { id: { type: 'UUID', primaryKey: true } },
            },
          },
        },
      },
    } as Record<string, unknown>;
    const internal = generator as unknown as {
      loadDependencyManifest: (name: string) => unknown;
    };
    internal.loadDependencyManifest = (name: string) => loaded[name] ?? null;

    const manifest = generator.generateManifest(scanResults, {
      packageName: APP,
      projectRoot: '/nonexistent/identity-app',
    });
    expect(
      manifest.objects[`${APP}:WorkOrder`]?.fields.productionRunId?.related,
    ).toBe('ProductionRun');
  });

  it.each([
    ['no schema for the target', undefined, 'records no schema for it'],
    [
      'no column the target names',
      {
        tableName: 'production_runs',
        columns: { id: { type: 'UUID', primaryKey: true } },
      },
      'has no column code',
    ],
  ])('fails generation for a confirmed package target whose manifest gives %s, keeping no unenforced constraint', (_label, schema, reason) => {
    const generator = new ManifestGenerator();
    const scanResults: ScanResult[] = [
      {
        filePath: '/app/src',
        objects: [
          {
            name: 'workorder',
            className: 'WorkOrder',
            collection: 'workorders',
            filePath: '/app/src/WorkOrder.ts',
            fields: {
              productionRunId: {
                type: 'foreignKey',
                related: schema ? 'ProductionRun.code' : 'ProductionRun',
                relatedQualified: `${VENDOR}:ProductionRun`,
                relatedImportPath: VENDOR,
                _meta: { onDelete: 'RESTRICT' },
              },
            },
            methods: {},
            decoratorConfig: { tableName: 'work_orders' },
            packageName: APP,
          } as SmartObjectDefinition,
        ],
        errors: [],
      },
    ];
    const loaded = {
      [VENDOR]: {
        version: '1.0.0',
        packageName: VENDOR,
        objects: {
          [`${VENDOR}:ProductionRun`]: {
            name: 'productionrun',
            className: 'ProductionRun',
            qualifiedName: `${VENDOR}:ProductionRun`,
            packageName: VENDOR,
            importPath: VENDOR,
            collection: 'productionruns',
            filePath: 'src/ProductionRun.ts',
            fields: {},
            methods: {},
            decoratorConfig: { tableName: 'production_runs' },
            ...(schema ? { schema } : {}),
          },
        },
      },
    } as Record<string, unknown>;
    const internal = generator as unknown as {
      loadDependencyManifest: (name: string) => unknown;
    };
    internal.loadDependencyManifest = (name: string) => loaded[name] ?? null;

    expect(() =>
      generator.generateManifest(scanResults, {
        packageName: APP,
        projectRoot: '/nonexistent/identity-app',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'CONFIG_UNKNOWN_RELATIONSHIP_TARGET',
        message: expect.stringContaining(reason),
      }),
    );
  });

  it('references the provider table for a target a provider parent contributes', async () => {
    const root = await project({
      providers: {
        [VENDOR]: {
          files: {
            'src/Room.ts': `${CORE}\n@smrt({ tableName: 'vendor_rooms' })\nexport class Room extends SmrtObject {}\n`,
            'src/Booking.ts': `${CORE}\nimport { Room } from './Room';\n@smrt({ tableStrategy: 'sti', tableName: 'vendor_bookings' })\nexport class Booking extends SmrtObject {\n  @foreignKey(Room) roomId = '';\n}\n`,
          },
        },
      },
      app: {
        'src/Session.ts': `${CORE}\nimport { Booking } from '${VENDOR}';\n@smrt()\nexport class Session extends Booking {\n  topic = '';\n}\n`,
      },
    });

    const manifest = await build(root);
    const session = manifest.objects[`${APP}:Session`];
    expect(session?.fields.roomId?.relatedQualified).toBe(`${VENDOR}:Room`);
    expect(session?.schema?.columns.room_id?.foreignKey?.table).toBe(
      'vendor_rooms',
    );
  });

  it('keeps the referenced column of a target a provider parent names with a column', async () => {
    const root = await project({
      providers: {
        [VENDOR]: {
          files: {
            'src/Room.ts': `import { SmrtObject, smrt, field } from '@happyvertical/smrt-core';\n@smrt({ tableName: 'vendor_rooms' })\nexport class Room extends SmrtObject {\n  @field({ unique: true }) code = 0;\n}\n`,
            'src/Booking.ts': `${CORE}\n@smrt({ tableStrategy: 'sti', tableName: 'vendor_bookings' })\nexport class Booking extends SmrtObject {\n  @foreignKey('Room.code') roomCode = 0;\n}\n`,
          },
        },
      },
      app: {
        'src/Session.ts': `${CORE}\nimport { Booking } from '${VENDOR}';\n@smrt()\nexport class Session extends Booking {\n  topic = '';\n}\n`,
      },
    });

    const manifest = await build(root);
    const session = manifest.objects[`${APP}:Session`];
    expect(session?.fields.roomCode?.relatedQualified).toBe(`${VENDOR}:Room`);
    expect(session?.fields.roomCode?.related).toBe('Room.code');
    // Migrations render `REFERENCES vendor_rooms (code)` from this.
    const column = session?.schema?.columns.room_code;
    expect(column?.foreignKey).toMatchObject({
      table: 'vendor_rooms',
      column: 'code',
    });
    // The child column keeps the referenced column's type, not the key's.
    expect(column?.type).toBe('INTEGER');
  });

  it('fails for a target a provider parent contributes when an app model shares its name', async () => {
    const root = await project({
      providers: {
        [VENDOR]: {
          files: {
            'src/Room.ts': `${CORE}\n@smrt({ tableName: 'vendor_rooms' })\nexport class Room extends SmrtObject {}\n`,
            'src/Booking.ts': `${CORE}\nimport { Room } from './Room';\n@smrt({ tableStrategy: 'sti', tableName: 'vendor_bookings' })\nexport class Booking extends SmrtObject {\n  @foreignKey(Room) roomId = '';\n}\n`,
          },
        },
      },
      app: {
        'src/Room.ts': `${CORE}\n@smrt({ tableName: 'app_rooms' })\nexport class Room extends SmrtObject {}\n`,
        'src/Session.ts': `${CORE}\nimport { Booking } from '${VENDOR}';\n@smrt()\nexport class Session extends Booking {\n  topic = '';\n}\n`,
      },
    });

    await expect(build(root)).rejects.toMatchObject({
      code: 'CONFIG_AMBIGUOUS_RELATIONSHIP_TARGET',
    });
  });
});

describe('a collection of a package model', () => {
  it('takes its item, and the item’s exposure, by identity beside an open app namesake', async () => {
    const root = await project({
      providers: {
        [VENDOR]: {
          files: {
            'src/Account.ts': `${CORE}\n@smrt({ api: false, tableName: 'vendor_accounts' })\nexport class Account extends SmrtObject {\n  secret = '';\n}\n`,
          },
        },
      },
      app: {
        'src/Account.ts': `${CORE}\n@smrt({ tableName: 'app_accounts' })\nexport class Account extends SmrtObject {}\n`,
        'src/VendorAccounts.ts': `${CORE}\nimport { Account } from '${VENDOR}';\nexport class VendorAccountCollection extends SmrtCollection<Account> {}\n`,
      },
    });

    const manifest = await build(root);
    const collection = manifest.objects[`${APP}:VendorAccountCollection`];
    expect(collection?.extendsTypeArgQualified).toBe(`${VENDOR}:Account`);
    expect(collection?.collectionOf).toBe(`${VENDOR}:Account`);
    expect(crud(collection)).toEqual([]);
    expect(crud(manifest.objects[`${APP}:Account`]).length).toBe(5);
  });

  it('takes an item named by a type-only import by identity, with a runtime alias for _itemClass', async () => {
    const root = await project({
      providers: {
        [VENDOR]: {
          files: {
            'src/Account.ts': `${CORE}\n@smrt({ api: false, tableName: 'vendor_accounts' })\nexport class Account extends SmrtObject {\n  secret = '';\n}\n`,
          },
        },
      },
      app: {
        'src/Account.ts': `${CORE}\n@smrt({ tableName: 'app_accounts' })\nexport class Account extends SmrtObject {}\n`,
        'src/VendorAccounts.ts': `${CORE}\nimport type { Account } from '${VENDOR}';\nimport { Account as RuntimeAccount } from '${VENDOR}';\nexport class VendorAccountCollection extends SmrtCollection<Account> {\n  static readonly _itemClass = RuntimeAccount;\n}\n`,
      },
    });

    const manifest = await build(root);
    const collection = manifest.objects[`${APP}:VendorAccountCollection`];
    expect(collection?.extendsTypeArgQualified).toBe(`${VENDOR}:Account`);
    expect(collection?.collectionOf).toBe(`${VENDOR}:Account`);
    expect(crud(collection)).toEqual([]);
  });
});

describe('open control', () => {
  it('leaves an open provider parent open', async () => {
    const root = await project({
      providers: {
        [VENDOR]: {
          files: {
            'src/Event.ts': `${CORE}\n@smrt({ api: ${JSON.stringify(OPEN_API)} })\nexport class Event extends SmrtObject {}\n`,
          },
        },
      },
      app: { 'src/Meeting.ts': meeting(VENDOR) },
    });

    const manifest = await build(root);
    expect(crud(manifest.objects[`${APP}:Meeting`]).length).toBe(5);
  });
});
