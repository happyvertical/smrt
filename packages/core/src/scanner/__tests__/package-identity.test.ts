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
import { selectApiClientEntries } from '../../vite-plugin/api-client-entries.js';
import {
  resolveCollectionItemObject,
  resolveCollectionItemTypeName,
  resolveStandardCrudActions,
} from '../../vite-plugin/web-collections.js';
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
      /** Package name, when the key only labels a second installed copy. */
      name?: string;
      /** Install directory below the root (default `node_modules/<name>`). */
      at?: string;
    }
  >;
  app: Record<string, string>;
}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-identity-')));
  roots.push(root);
  for (const [key, provider] of Object.entries(options.providers)) {
    const name = provider.name ?? key;
    const dir = join(root, provider.at ?? join('node_modules', name));
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
        Object.entries(options.providers)
          .filter(([, provider]) => !provider.at)
          .map(([key, provider]) => [provider.name ?? key, '*']),
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

  // A provider model may export one name and publish another
  // (`@smrt({ name })`); the import names the export, and the parent is the
  // model its manifest keys under the public name.
  it('confirms a parent and a collection item imported by an export name that differs from the public name', async () => {
    const root = await project({
      providers: {
        [VENDOR]: {
          files: {
            'src/InvoiceRecord.ts': `${CORE}\n@smrt({ name: 'Invoice', tableStrategy: 'sti', tableName: 'vendor_invoices', api: false })\nexport class InvoiceRecord extends SmrtObject {\n  total = 0;\n}\n`,
          },
        },
      },
      app: {
        'src/Invoice.ts': `${CORE}\n@smrt({ tableName: 'app_invoices' })\nexport class Invoice extends SmrtObject {}\n`,
        'src/CreditNote.ts': `${CORE}\nimport { InvoiceRecord } from '${VENDOR}';\n@smrt()\nexport class CreditNote extends InvoiceRecord {\n  reason = '';\n}\n`,
        'src/Invoices.ts': `${CORE}\nimport { InvoiceRecord } from '${VENDOR}';\nexport class VendorInvoiceCollection extends SmrtCollection<InvoiceRecord> {}\n`,
      },
    });

    const manifest = await build(root);
    const note = manifest.objects[`${APP}:CreditNote`];
    expect(note?.extendsQualified).toBe(`${VENDOR}:Invoice`);
    expect(note?.schema?.tableName).toBe('vendor_invoices');
    expect(crud(note)).toEqual([]);
    const collection = manifest.objects[`${APP}:VendorInvoiceCollection`];
    expect(collection?.collectionOf).toBe(`${VENDOR}:Invoice`);
    expect(crud(collection)).toEqual([]);
  });

  it('fails for a parent whose export name matches a provider model only in another case', async () => {
    const root = await project({
      providers: {
        [VENDOR]: {
          files: {
            'src/Account.ts': `${CORE}\n@smrt({ tableStrategy: 'sti', tableName: 'vendor_accounts', api: false })\nexport class Account extends SmrtObject {\n  secret = '';\n}\n`,
            'src/helpers.ts': `export class ACCOUNT {\n  label = '';\n}\n`,
          },
        },
      },
      app: {
        'src/Child.ts': `${CORE}\nimport { ACCOUNT } from '${VENDOR}';\n@smrt()\nexport class Child extends ACCOUNT {}\n`,
      },
    });

    await expect(build(root)).rejects.toMatchObject({
      code: 'CONFIG_UNRESOLVED_IMPORTED_PARENT',
      message: expect.stringContaining('does not declare ACCOUNT'),
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

  // Code that reads a manifest classifies an entry by its parent's bare
  // name, so a class of another package named like a framework base is a
  // scan error rather than a model that could be read as that base.
  it('fails the provider build for a provider model named SmrtReport', async () => {
    await expect(
      project({
        providers: {
          [VENDOR]: {
            files: {
              'src/SmrtReport.ts': `${CORE}\n@smrt({ api: false })\nexport class SmrtReport extends SmrtObject {\n  hidden = '';\n}\n`,
            },
          },
        },
        app: {},
      }),
    ).rejects.toThrow('the framework reserves this class name');
  });

  it('fails generation for a local model named like a framework base', async () => {
    const root = await project({
      providers: {},
      app: {
        'src/SmrtReport.ts': `${CORE}\n@smrt({ api: false })\nexport class SmrtReport extends SmrtObject {\n  hidden = '';\n}\n`,
        'src/Summary.ts': `${CORE}\nimport { SmrtReport } from './SmrtReport';\n@smrt()\nexport class Summary extends SmrtReport {}\n`,
      },
    });

    await expect(build(root)).rejects.toThrow(
      'the framework reserves this class name',
    );
  });

  it('fails generation for an undecorated generic local class named SmrtCollection', async () => {
    const root = await project({
      providers: {},
      app: {
        'src/SmrtCollection.ts': `import { SmrtObject } from '@happyvertical/smrt-core';\nexport class SmrtCollection<T> extends SmrtObject {\n  item?: T;\n}\n`,
        'src/Ledger.ts': `import { smrt } from '@happyvertical/smrt-core';\nimport { SmrtCollection } from './SmrtCollection';\n@smrt()\nexport class Ledger extends SmrtCollection<string> {}\n`,
      },
    });

    await expect(build(root)).rejects.toThrow(
      'the framework reserves this class name',
    );
  });

  it('fails generation for a local model published under a framework base name by its name option', async () => {
    const root = await project({
      providers: {},
      app: {
        'src/InternalBase.ts': `${CORE}\n@smrt({ name: 'SmrtClass', api: false })\nexport class InternalBase extends SmrtObject {\n  hidden = '';\n}\n`,
        'src/Child.ts': `${CORE}\nimport { InternalBase } from './InternalBase';\n@smrt()\nexport class Child extends InternalBase {}\n`,
      },
    });

    await expect(build(root)).rejects.toThrow(
      'the framework reserves this class name',
    );
  });

  it('fails generation for a manifest entry renamed to a framework base name', () => {
    const scanResults: ScanResult[] = [
      {
        filePath: '/app/src',
        objects: [
          {
            name: 'internalbase',
            className: 'InternalBase',
            collection: 'internalbases',
            filePath: '/app/src/InternalBase.ts',
            fields: {},
            methods: {},
            decoratorConfig: { name: 'SmrtClass' },
            packageName: APP,
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
    ).toThrow(expect.objectContaining({ code: 'CONFIG_RESERVED_CLASS_NAME' }));
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

  // The provider was built against its own copy of a third package (v1,
  // nested under it); the app root installs another version (v2) that
  // exports the same class at the same specifier with another table.
  const twoCopies = (other: (table: string) => Record<string, string>) => ({
    'other-v1': {
      name: OTHER,
      at: join('node_modules', VENDOR, 'node_modules', OTHER),
      files: other('rooms_v1'),
    },
    'other-v2': { name: OTHER, files: other('rooms_v2') },
  });

  it('fails for an inherited foreign key whose target package the provider loads in another copy', async () => {
    const root = await project({
      providers: {
        ...twoCopies((table) => ({
          'src/Room.ts': `${CORE}\n@smrt({ tableName: '${table}' })\nexport class Room extends SmrtObject {}\n`,
        })),
        [VENDOR]: {
          dependencies: [OTHER],
          files: {
            'src/Booking.ts': `${CORE}\nimport { Room } from '${OTHER}';\n@smrt({ tableStrategy: 'sti', tableName: 'vendor_bookings' })\nexport class Booking extends SmrtObject {\n  @foreignKey(Room) roomId = '';\n}\n`,
          },
        },
      },
      app: {
        'src/Session.ts': `${CORE}\nimport { Booking } from '${VENDOR}';\n@smrt()\nexport class Session extends Booking {\n  topic = '';\n}\n`,
      },
    });

    await expect(build(root)).rejects.toMatchObject({
      code: 'CONFIG_UNKNOWN_RELATIONSHIP_TARGET',
      message: expect.stringContaining(`${VENDOR} loads ${OTHER} from`),
    });
  });

  it('fails for an inherited ancestor whose package the provider loads in another copy', async () => {
    const root = await project({
      providers: {
        ...twoCopies((table) => ({
          'src/Reservation.ts': `${CORE}\n@smrt({ tableStrategy: 'sti', tableName: '${table}' })\nexport class Reservation extends SmrtObject {}\n`,
        })),
        [VENDOR]: {
          dependencies: [OTHER],
          files: {
            'src/Booking.ts': `${CORE}\nimport { Reservation } from '${OTHER}';\n@smrt()\nexport class Booking extends Reservation {}\n`,
          },
        },
      },
      app: {
        'src/Session.ts': `${CORE}\nimport { Booking } from '${VENDOR}';\n@smrt()\nexport class Session extends Booking {}\n`,
      },
    });

    await expect(build(root)).rejects.toMatchObject({
      code: 'CONFIG_UNRESOLVED_IMPORTED_PARENT',
      message: expect.stringContaining(`${VENDOR} loads ${OTHER} from`),
    });
  });

  // pnpm installs one version of a package in two store directories when its
  // peers resolve differently: same name, version and manifest, two paths.
  it('accepts an inherited foreign key whose target package is installed twice as the same version and manifest', async () => {
    let shipped: Record<string, unknown> | undefined;
    const room = {
      'src/Room.ts': `${CORE}\n@smrt({ tableName: 'rooms' })\nexport class Room extends SmrtObject {}\n`,
    };
    const root = await project({
      providers: {
        'other-peer-a': {
          name: OTHER,
          at: join('node_modules', VENDOR, 'node_modules', OTHER),
          files: room,
          edit: (manifest) => {
            shipped = structuredClone(manifest);
          },
        },
        'other-peer-b': {
          name: OTHER,
          files: room,
          edit: (manifest) => {
            for (const key of Object.keys(manifest)) delete manifest[key];
            Object.assign(manifest, structuredClone(shipped));
          },
        },
        [VENDOR]: {
          dependencies: [OTHER],
          files: {
            'src/Booking.ts': `${CORE}\nimport { Room } from '${OTHER}';\n@smrt({ tableStrategy: 'sti', tableName: 'vendor_bookings' })\nexport class Booking extends SmrtObject {\n  @foreignKey(Room) roomId = '';\n}\n`,
          },
        },
      },
      app: {
        'src/Session.ts': `${CORE}\nimport { Booking } from '${VENDOR}';\n@smrt()\nexport class Session extends Booking {}\n`,
      },
    });

    const manifest = await build(root);
    expect(
      manifest.objects[`${APP}:Session`]?.schema?.columns.room_id?.foreignKey
        ?.table,
    ).toBe('rooms');
  });

  // Only a constrained foreign key names the target's table in this table's
  // DDL; a one-to-many or an unconstrained key keeps no reference to it.
  it.each([
    ['one-to-many', `@oneToMany(Room) rooms = [];`],
    [
      'foreign key without a constraint',
      `@foreignKey(Room, { constraint: false }) roomId = '';`,
    ],
  ])('accepts an inherited %s whose target package the provider loads in another copy', async (_label, field) => {
    const root = await project({
      providers: {
        ...twoCopies((table) => ({
          'src/Room.ts': `${CORE}\n@smrt({ tableName: '${table}' })\nexport class Room extends SmrtObject {}\n`,
        })),
        [VENDOR]: {
          dependencies: [OTHER],
          files: {
            'src/Booking.ts': `${CORE.replace('report }', 'report, oneToMany }')}\nimport { Room } from '${OTHER}';\n@smrt({ tableStrategy: 'sti', tableName: 'vendor_bookings' })\nexport class Booking extends SmrtObject {\n  ${field}\n}\n`,
          },
        },
      },
      app: {
        'src/Session.ts': `${CORE}\nimport { Booking } from '${VENDOR}';\n@smrt()\nexport class Session extends Booking {\n  topic = '';\n}\n`,
      },
    });

    const manifest = await build(root);
    const session = manifest.objects[`${APP}:Session`];
    expect(session?.schema?.tableName).toBe('vendor_bookings');
    expect(session?.schema?.ddl).not.toContain('rooms_v');
  });

  // A provider chain deeper than any fixed limit: the check walks to its end,
  // as the single-table walk that picks the table does.
  const deepChain = (length: number) =>
    Object.fromEntries(
      Array.from({ length }, (_, index) => [
        `src/Level${index}.ts`,
        index === 0
          ? `${CORE}\nimport { Reservation } from '${OTHER}';\n@smrt()\nexport class Level0 extends Reservation {}\n`
          : `${CORE}\nimport { Level${index - 1} } from './Level${index - 1}';\n@smrt()\nexport class Level${index} extends Level${index - 1} {}\n`,
      ]),
    );
  const RESERVATION = (table: string) => ({
    'src/Reservation.ts': `${CORE}\n@smrt({ tableStrategy: 'sti', tableName: '${table}' })\nexport class Reservation extends SmrtObject {}\n`,
  });

  it('fails for an ancestor 40 provider levels up whose package the provider loads in another copy', async () => {
    const root = await project({
      providers: {
        ...twoCopies(RESERVATION),
        [VENDOR]: { dependencies: [OTHER], files: deepChain(40) },
      },
      app: {
        'src/Session.ts': `${CORE}\nimport { Level39 } from '${VENDOR}';\n@smrt()\nexport class Session extends Level39 {}\n`,
      },
    });

    await expect(build(root)).rejects.toMatchObject({
      code: 'CONFIG_UNRESOLVED_IMPORTED_PARENT',
      message: expect.stringContaining(`${VENDOR} loads ${OTHER} from`),
    });
  });

  it('takes the single-table root 40 provider levels up when the provider and the root load one copy', async () => {
    const root = await project({
      providers: {
        [OTHER]: { files: RESERVATION('rooms_v2') },
        [VENDOR]: { dependencies: [OTHER], files: deepChain(40) },
      },
      app: {
        'src/Session.ts': `${CORE}\nimport { Level39 } from '${VENDOR}';\n@smrt()\nexport class Session extends Level39 {}\n`,
      },
    });

    const manifest = await build(root);
    expect(manifest.objects[`${APP}:Session`]?.schema?.tableName).toBe(
      'rooms_v2',
    );
  });

  it('accepts an inherited foreign key when the provider and the root load one copy', async () => {
    const root = await project({
      providers: {
        [OTHER]: {
          files: {
            'src/Room.ts': `${CORE}\n@smrt({ tableName: 'rooms_v2' })\nexport class Room extends SmrtObject {}\n`,
          },
        },
        [VENDOR]: {
          dependencies: [OTHER],
          files: {
            'src/Booking.ts': `${CORE}\nimport { Room } from '${OTHER}';\n@smrt({ tableStrategy: 'sti', tableName: 'vendor_bookings' })\nexport class Booking extends SmrtObject {\n  @foreignKey(Room) roomId = '';\n}\n`,
          },
        },
      },
      app: {
        'src/Session.ts': `${CORE}\nimport { Booking } from '${VENDOR}';\n@smrt()\nexport class Session extends Booking {\n  topic = '';\n}\n`,
      },
    });

    const manifest = await build(root);
    const session = manifest.objects[`${APP}:Session`];
    expect(session?.schema?.columns.room_id?.foreignKey?.table).toBe(
      'rooms_v2',
    );
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

  it('references the provider table for an imported package target beside a local model of its name', async () => {
    const root = await project({
      providers: { [VENDOR]: { files: { 'src/ProductionRun.ts': RUN } } },
      app: {
        'src/ProductionRun.ts': `${CORE}\n@smrt({ tableName: 'app_runs' })\nexport class ProductionRun extends SmrtObject {}\n`,
        'src/WorkOrder.ts': order(),
      },
    });

    const manifest = await build(root);
    const field = manifest.objects[`${APP}:WorkOrder`]?.fields.productionRunId;
    expect(field?.relatedQualified).toBe(`${VENDOR}:ProductionRun`);
    expect(
      manifest.objects[`${APP}:WorkOrder`]?.schema?.columns.production_run_id
        ?.foreignKey?.table,
    ).toBe('production_runs');
  });

  // Two installed packages with a model of one name (smrt-ledgers and
  // smrt-messages both declare `Account`): an imported class is one declaration.
  const twoRuns = {
    [VENDOR]: { files: { 'src/ProductionRun.ts': RUN } },
    [OTHER]: {
      files: {
        'src/ProductionRun.ts': RUN.replace('production_runs', 'other_runs'),
      },
    },
  };

  it('references the imported provider table when another dependency declares a model of its name', async () => {
    const root = await project({
      providers: twoRuns,
      app: { 'src/WorkOrder.ts': order() },
    });

    const manifest = await build(root);
    const field = manifest.objects[`${APP}:WorkOrder`]?.fields.productionRunId;
    expect(field?.relatedQualified).toBe(`${VENDOR}:ProductionRun`);
    expect(
      manifest.objects[`${APP}:WorkOrder`]?.schema?.columns.production_run_id
        ?.foreignKey?.table,
    ).toBe('production_runs');
  });

  it('fails a bare-name target that models of two dependencies share, listing both and the imports that qualify it', async () => {
    const root = await project({
      providers: twoRuns,
      app: {
        'src/WorkOrder.ts': `${CORE}\n@smrt()\nexport class WorkOrder extends SmrtObject {\n  @foreignKey('ProductionRun') productionRunId = '';\n}\n`,
      },
    });

    const failure = build(root);
    await expect(failure).rejects.toMatchObject({
      code: 'CONFIG_AMBIGUOUS_RELATIONSHIP_TARGET',
    });
    const message = await failure.catch((error: Error) => error.message);
    expect(message).toContain(`${VENDOR}:ProductionRun`);
    expect(message).toContain(`${OTHER}:ProductionRun`);
    expect(message).toContain(`import { ProductionRun } from '${VENDOR}'`);
    expect(message).toContain(`import { ProductionRun } from '${OTHER}'`);
  });

  it('fails a bare-name report source that models of two dependencies share', async () => {
    const root = await project({
      providers: twoRuns,
      app: {
        'src/RunReport.ts': `${CORE}\n@report({ source: 'ProductionRun' })\nexport class RunReport extends SmrtObject {\n  total = 0;\n}\n`,
      },
    });

    await expect(build(root)).rejects.toMatchObject({
      code: 'CONFIG_AMBIGUOUS_RELATIONSHIP_TARGET',
      message: expect.stringContaining(`${OTHER}:ProductionRun`),
    });
  });

  it('takes the own-package model for a bare-name target that two dependencies also declare', async () => {
    const root = await project({
      providers: twoRuns,
      app: {
        'src/ProductionRun.ts': `${CORE}\n@smrt({ tableName: 'app_runs' })\nexport class ProductionRun extends SmrtObject {}\n`,
        'src/WorkOrder.ts': `${CORE}\n@smrt()\nexport class WorkOrder extends SmrtObject {\n  @foreignKey('ProductionRun') productionRunId = '';\n}\n`,
      },
    });

    const manifest = await build(root);
    expect(
      manifest.objects[`${APP}:WorkOrder`]?.schema?.columns.production_run_id
        ?.foreignKey?.table,
    ).toBe('app_runs');
  });

  it('accepts a bare-name target that one dependency alone declares', async () => {
    const root = await project({
      providers: { [VENDOR]: twoRuns[VENDOR] },
      app: {
        'src/WorkOrder.ts': `${CORE}\n@smrt()\nexport class WorkOrder extends SmrtObject {\n  @foreignKey('ProductionRun') productionRunId = '';\n}\n`,
      },
    });

    const manifest = await build(root);
    expect(
      manifest.objects[`${APP}:WorkOrder`]?.fields.productionRunId?.related,
    ).toBe('ProductionRun');
  });

  // A bare name is matched as a class name lookup matches it: the exact
  // spelling, or another case of it when the manifest holds only that one.
  const bareOrder = (name: string) =>
    `${CORE}\n@smrt()\nexport class WorkOrder extends SmrtObject {\n  @foreignKey('${name}') productionRunId = '';\n}\n`;

  it('generates a bare-name target spelled in another case like its exact spelling when one dependency declares it', async () => {
    const exact = await build(
      await project({
        providers: { [VENDOR]: twoRuns[VENDOR] },
        app: { 'src/WorkOrder.ts': bareOrder('ProductionRun') },
      }),
    );
    const cased = await build(
      await project({
        providers: { [VENDOR]: twoRuns[VENDOR] },
        app: { 'src/WorkOrder.ts': bareOrder('productionrun') },
      }),
    );

    const column = (manifest: typeof exact) =>
      manifest.objects[`${APP}:WorkOrder`]?.schema?.columns.production_run_id;
    expect(column(cased)).toBeDefined();
    expect(column(cased)).toEqual(column(exact));
  });

  it('names the recorded entry and export name in the import that pins an ambiguous bare-name target', async () => {
    const root = await project({
      providers: {
        [VENDOR]: twoRuns[VENDOR],
        [OTHER]: {
          ...twoRuns[OTHER],
          edit: (manifest) => {
            const objects = manifest.objects as Record<
              string,
              Record<string, unknown>
            >;
            const run = objects[`${OTHER}:ProductionRun`];
            run.importPath = `${OTHER}/runs`;
            run.exportName = 'OtherRun';
          },
        },
      },
      app: { 'src/WorkOrder.ts': bareOrder('ProductionRun') },
    });

    const message = await build(root).catch((error: Error) => error.message);
    expect(message).toContain(`import { OtherRun } from '${OTHER}/runs'`);
    expect(message).toContain(`import { ProductionRun } from '${VENDOR}'`);
  });

  it('fails a bare-name target spelled in another case that models of two dependencies share', async () => {
    const root = await project({
      providers: twoRuns,
      app: { 'src/WorkOrder.ts': bareOrder('productionrun') },
    });

    const failure = build(root);
    await expect(failure).rejects.toMatchObject({
      code: 'CONFIG_AMBIGUOUS_RELATIONSHIP_TARGET',
    });
    const message = await failure.catch((error: Error) => error.message);
    expect(message).toContain(`${VENDOR}:ProductionRun`);
    expect(message).toContain(`${OTHER}:ProductionRun`);
  });

  it('accepts a package target that an app replacement shares its table with', async () => {
    const root = await project({
      providers: { [VENDOR]: { files: { 'src/ProductionRun.ts': RUN } } },
      app: {
        'src/ProductionRun.ts': `${CORE}\nimport { ProductionRun as BaseRun } from '${VENDOR}';\n@smrt({ replaceParent: true, tableName: 'production_runs' })\nexport class ProductionRun extends BaseRun {\n  appNote = '';\n}\n`,
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

  const PROVIDER_SCHEMA = (columns: Record<string, unknown>) => ({
    tableName: 'production_runs',
    columns,
  });
  const generateWorkOrder = (
    related: string,
    schema: Record<string, unknown> | undefined,
    meta: Record<string, unknown> = {},
  ) => {
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
                related,
                relatedQualified: `${VENDOR}:ProductionRun`,
                relatedImportPath: VENDOR,
                _meta: { onDelete: 'RESTRICT', ...meta },
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
    return () =>
      generator.generateManifest(scanResults, {
        packageName: APP,
        projectRoot: '/nonexistent/identity-app',
      });
  };

  it.each([
    [
      'neither a primary-key column nor id, for a plain target',
      'ProductionRun',
      PROVIDER_SCHEMA({ code: { type: 'TEXT' } }),
      'has no column id (its primary key, or id)',
    ],
    [
      'only the snake_case form of a camelCase column the target names',
      'ProductionRun.runCode',
      PROVIDER_SCHEMA({
        id: { type: 'UUID', primaryKey: true },
        run_code: { type: 'TEXT' },
      }),
      "write 'ProductionRun.run_code'",
    ],
  ])('fails generation for a confirmed package target whose schema has %s', (_label, related, schema, reason) => {
    expect(generateWorkOrder(related, schema)).toThrow(
      expect.objectContaining({
        code: 'CONFIG_UNKNOWN_RELATIONSHIP_TARGET',
        message: expect.stringContaining(reason),
      }),
    );
  });

  it('generates a confirmed package target without a referenced column when the field sets constraint: false', () => {
    const manifest = generateWorkOrder(
      'ProductionRun',
      PROVIDER_SCHEMA({ code: { type: 'TEXT' } }),
      { constraint: false },
    )();
    const column =
      manifest.objects[`${APP}:WorkOrder`]?.schema?.columns.production_run_id;
    expect(column).toBeDefined();
    expect(column?.foreignKey).toBeUndefined();
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

  it('references the provider table for a target a provider parent contributes beside an app model of its name', async () => {
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

    const manifest = await build(root);
    expect(
      manifest.objects[`${APP}:Session`]?.schema?.columns.room_id?.foreignKey
        ?.table,
    ).toBe('vendor_rooms');
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

  it('describes a collection of a package model with that model in the generated API client', async () => {
    const root = await project({
      providers: {
        [VENDOR]: {
          files: {
            'src/Account.ts': `${CORE}\n@smrt({ api: false, tableName: 'vendor_accounts' })\nexport class Account extends SmrtObject {\n  secret = '';\n}\n`,
          },
        },
      },
      app: {
        'src/Account.ts': `${CORE}\n@smrt({ tableName: 'app_accounts' })\nexport class Account extends SmrtObject {\n  appOnly = '';\n}\n`,
        'src/VendorAccounts.ts': `${CORE}\nimport { Account } from '${VENDOR}';\n@smrt({ api: { include: ['archiveAll'] } })\nexport class VendorAccountCollection extends SmrtCollection<Account> {\n  async archiveAll(): Promise<void> {}\n}\n`,
      },
    });

    const manifest = await build(root);
    const collection = manifest.objects[`${APP}:VendorAccountCollection`];
    const item = resolveCollectionItemObject(manifest, collection);
    expect(item).not.toBe(manifest.objects[`${APP}:Account`]);
    expect(resolveCollectionItemTypeName(manifest, collection)).toBe(
      `${VENDOR}:Account`,
    );
    const appEntry = selectApiClientEntries(manifest).find(
      (entry) => entry.obj === manifest.objects[`${APP}:Account`],
    );
    const entry = selectApiClientEntries(manifest).find(
      (candidate) => candidate.obj === collection,
    );
    expect(appEntry?.dataInterfaceName).toBeDefined();
    expect(entry?.customMethods).toEqual([
      expect.objectContaining({ name: 'archiveAll' }),
    ]);
    expect(entry?.dataInterfaceName).not.toBe(appEntry?.dataInterfaceName);
  });

  // A collection's own type parameter names no class, however it is
  // spelled: the item is the class `_itemClass` names, never an app model
  // that shares the parameter's name.
  it('takes the _itemClass model, not an app model named like its type parameter', async () => {
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
        'src/Closed.ts': `${CORE}\n@smrt({ api: false, tableName: 'closed_entries' })\nexport class ClosedEntry extends SmrtObject {\n  hidden = '';\n}\n`,
        'src/Ledger.ts': `${CORE}\nimport { ClosedEntry } from './Closed';\nexport class Ledger<Account extends ClosedEntry> extends SmrtCollection<Account> {\n  static readonly _itemClass = ClosedEntry;\n}\n`,
        'src/VendorLedger.ts': `${CORE}\nimport { Account as VendorAccount } from '${VENDOR}';\nexport class VendorLedger<Account extends VendorAccount> extends SmrtCollection<Account> {\n  static readonly _itemClass = VendorAccount;\n}\n`,
        'src/Journal.ts': `${CORE}\nexport class Journal<Account extends SmrtObject> extends SmrtCollection<Account> {}\n`,
      },
    });

    const manifest = await build(root);
    const ledger = manifest.objects[`${APP}:Ledger`];
    expect(ledger?.extendsTypeArg).toBe('ClosedEntry');
    expect(ledger?.collectionOf).toBe(`${APP}:ClosedEntry`);
    expect(crud(ledger)).toEqual([]);

    const vendorLedger = manifest.objects[`${APP}:VendorLedger`];
    expect(vendorLedger?.extendsTypeArgQualified).toBe(`${VENDOR}:Account`);
    expect(vendorLedger?.collectionOf).toBe(`${VENDOR}:Account`);
    expect(crud(vendorLedger)).toEqual([]);

    const journal = manifest.objects[`${APP}:Journal`];
    expect(journal?.extendsTypeArg).toBeUndefined();
    expect(journal?.collectionOf).not.toBe(`${APP}:Account`);
    expect(crud(manifest.objects[`${APP}:Account`]).length).toBe(5);
  });

  // The item is followed through the app's own generic collection to the
  // framework base: the type argument is a provider model, never the app
  // model that shares its name.
  it('takes a provider item named through an app-level generic collection by identity', async () => {
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
        'src/BaseCollection.ts': `${CORE}\nexport abstract class BaseCollection<T extends SmrtObject> extends SmrtCollection<T> {}\n`,
        'src/VendorAccounts.ts': `${CORE}\nimport { Account } from '${VENDOR}';\nimport { BaseCollection } from './BaseCollection';\nexport class VendorAccounts extends BaseCollection<Account> {\n  static readonly _itemClass = Account;\n}\n`,
      },
    });

    const manifest = await build(root);
    const vendorAccounts = manifest.objects[`${APP}:VendorAccounts`];
    expect(vendorAccounts?.extendsTypeArgQualified).toBe(`${VENDOR}:Account`);
    expect(vendorAccounts?.collectionOf).toBe(`${VENDOR}:Account`);
    expect(crud(vendorAccounts)).toEqual([]);
    expect(crud(manifest.objects[`${APP}:Account`]).length).toBe(5);
  });

  // A junction collection's row model is its item like any collection's.
  it('takes the provider row model of a junction collection by identity, not the app model that shares its name', async () => {
    const JUNCTIONS = `import { SmrtJunction, SmrtJunctionBase } from '@happyvertical/smrt-core';`;
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
        'src/AccountLinks.ts': `${JUNCTIONS}\nimport { Account } from '${VENDOR}';\nexport class AccountLinks extends SmrtJunction<Account> {}\nexport class AccountPairs extends SmrtJunctionBase<Account> {}\n`,
      },
    });

    const manifest = await build(root);
    for (const name of ['AccountLinks', 'AccountPairs']) {
      const links = manifest.objects[`${APP}:${name}`];
      expect(links?.extendsTypeArgQualified).toBe(`${VENDOR}:Account`);
      expect(links?.collectionOf).toBe(`${VENDOR}:Account`);
      expect(crud(links)).toEqual([]);
    }
    expect(crud(manifest.objects[`${APP}:Account`]).length).toBe(5);
  });

  // A subclass that names no item holds the item its ancestor fixes (it
  // inherits the static `_itemClass`), never a model its own name suggests.
  it('gives a collection named after an open model the closed item its ancestor fixes', async () => {
    const root = await project({
      providers: {},
      app: {
        'src/Account.ts': `${CORE}\n@smrt({ tableName: 'app_accounts' })\nexport class Account extends SmrtObject {}\n`,
        'src/PrivateEntry.ts': `${CORE}\n@smrt({ api: false, tableName: 'private_entries' })\nexport class PrivateEntry extends SmrtObject {\n  hidden = '';\n}\n`,
        'src/ClosedEntries.ts': `${CORE}\nimport { PrivateEntry } from './PrivateEntry';\nexport abstract class ClosedEntries extends SmrtCollection<PrivateEntry> {\n  static readonly _itemClass = PrivateEntry;\n}\n`,
        'src/AccountCollection.ts': `${CORE}\nimport { ClosedEntries } from './ClosedEntries';\nexport class AccountCollection extends ClosedEntries {}\n`,
      },
    });

    const manifest = await build(root);
    const accounts = manifest.objects[`${APP}:AccountCollection`];
    expect(accounts?.collectionOf).toBe(`${APP}:PrivateEntry`);
    expect(accounts?.decoratorConfig?.tableName).toBe('private_entries');
    expect(crud(accounts)).toEqual([]);
    expect(crud(manifest.objects[`${APP}:Account`]).length).toBe(5);
  });

  // A generic ancestor's static `_itemClass` is the constructor a subclass
  // inherits, whatever it passes for the ancestor's type parameter.
  it('takes the closed _itemClass a generic ancestor declares, not the open model a subclass passes for its parameter', async () => {
    const root = await project({
      providers: {},
      app: {
        'src/Account.ts': `${CORE}\n@smrt({ tableName: 'app_accounts' })\nexport class Account extends SmrtObject {}\n@smrt({ api: false })\nexport class PrivateAccount extends Account {\n  hidden = '';\n}\n`,
        'src/AccountBase.ts': `${CORE}\nimport { PrivateAccount } from './Account';\nexport abstract class AccountBase<T extends SmrtObject> extends SmrtCollection<T> {\n  static readonly _itemClass = PrivateAccount;\n}\n`,
        'src/OpenAccounts.ts': `${CORE}\nimport { Account } from './Account';\nimport { AccountBase } from './AccountBase';\nexport class OpenAccounts extends AccountBase<Account> {}\n`,
      },
    });

    const manifest = await build(root);
    const accounts = manifest.objects[`${APP}:OpenAccounts`];
    expect(accounts?.collectionOf).toBe(`${APP}:PrivateAccount`);
    expect(crud(accounts)).toEqual([]);
    expect(crud(manifest.objects[`${APP}:Account`]).length).toBe(5);
  });

  // A static `_itemClass` fixes the item before the position of the type
  // parameter an ancestor passes on is considered.
  it('gives a collection using the defaults of a generic ancestor the closed _itemClass it declares', async () => {
    const root = await project({
      providers: {},
      app: {
        'src/Account.ts': `${CORE}\n@smrt({ tableName: 'app_accounts' })\nexport class Account extends SmrtObject {}\n`,
        'src/PrivateEntry.ts': `${CORE}\n@smrt({ api: false, tableName: 'private_entries' })\nexport class PrivateEntry extends SmrtObject {\n  hidden = '';\n}\n`,
        'src/Pair.ts': `${CORE}\nimport { PrivateEntry } from './PrivateEntry';\nexport abstract class Pair<Tag = string, Row extends SmrtObject = PrivateEntry> extends SmrtCollection<Row> {\n  static readonly _itemClass = PrivateEntry;\n}\n`,
        'src/AccountCollection.ts': `${CORE}\nimport { Pair } from './Pair';\nexport class AccountCollection extends Pair {}\n`,
      },
    });

    const manifest = await build(root);
    const accounts = manifest.objects[`${APP}:AccountCollection`];
    expect(accounts?.collectionOf).toBe(`${APP}:PrivateEntry`);
    expect(accounts?.decoratorConfig?.tableName).toBe('private_entries');
    expect(crud(accounts)).toEqual([]);
    expect(crud(manifest.objects[`${APP}:Account`]).length).toBe(5);
  });

  it('fails generation for a collection naming no item below an ancestor that fixes no model', async () => {
    const root = await project({
      providers: {},
      app: {
        'src/Account.ts': `${CORE}\n@smrt({ tableName: 'app_accounts' })\nexport class Account extends SmrtObject {}\n`,
        'src/Entries.ts': `${CORE}\nexport abstract class EntryCollection extends SmrtCollection<any> {}\n`,
        'src/AccountCollection.ts': `${CORE}\nimport { EntryCollection } from './Entries';\nexport class AccountCollection extends EntryCollection {}\n`,
      },
    });

    await expect(build(root)).rejects.toThrow(
      'declare the item with a static _itemClass',
    );
  });

  // The runtime holds the constructor the ancestor's `_itemClass` names; a
  // type argument naming another model never reaches it.
  it('records the open _itemClass a generic ancestor declares for a subclass passing a closed model', async () => {
    const root = await project({
      providers: {},
      app: {
        'src/Account.ts': `${CORE}\n@smrt({ tableName: 'app_accounts' })\nexport class Account extends SmrtObject {}\n@smrt({ api: false })\nexport class PrivateAccount extends Account {\n  hidden = '';\n}\n`,
        'src/AccountBase.ts': `${CORE}\nimport { Account } from './Account';\nexport abstract class AccountBase<T extends SmrtObject> extends SmrtCollection<T> {\n  static readonly _itemClass = Account;\n}\n`,
        'src/PrivateAccounts.ts': `${CORE}\nimport { PrivateAccount } from './Account';\nimport { AccountBase } from './AccountBase';\nexport class PrivateAccounts extends AccountBase<PrivateAccount> {}\n`,
      },
    });

    const manifest = await build(root);
    const accounts = manifest.objects[`${APP}:PrivateAccounts`];
    expect(accounts?.collectionOf).toBe(`${APP}:Account`);
    expect(crud(accounts).length).toBe(5);
  });

  // A framework class names no item: the runtime holds the constructor the
  // static `_itemClass` names, never a model inferred from the class name.
  it.each([
    ['directly', '', 'SmrtCollection<SmrtObject>'],
    [
      'below a generic ancestor, under an alias',
      `import { SmrtObject as PublicNote } from '@happyvertical/smrt-core';\nimport { BaseCollection } from './BaseCollection';\n`,
      'BaseCollection<PublicNote>',
    ],
  ])('gives a collection naming a framework class %s the closed _itemClass it declares', async (_label, imports, parent) => {
    const root = await project({
      providers: {},
      app: {
        'src/PublicNote.ts': `${CORE}\n@smrt({ tableName: 'public_notes' })\nexport class PublicNote extends SmrtObject {}\n`,
        'src/PrivateNote.ts': `${CORE}\n@smrt({ api: false, tableName: 'private_notes' })\nexport class PrivateNote extends SmrtObject {\n  hidden = '';\n}\n`,
        'src/BaseCollection.ts': `${CORE}\nexport abstract class BaseCollection<T extends SmrtObject> extends SmrtCollection<T> {}\n`,
        'src/PublicNoteCollection.ts': `${CORE}\n${imports}import { PrivateNote } from './PrivateNote';\nexport class PublicNoteCollection extends ${parent} {\n  static readonly _itemClass = PrivateNote;\n}\n`,
      },
    });

    const manifest = await build(root);
    const notes = manifest.objects[`${APP}:PublicNoteCollection`];
    expect(notes?.collectionOf).toBe(`${APP}:PrivateNote`);
    expect(notes?.decoratorConfig?.tableName).toBe('private_notes');
    expect(crud(notes)).toEqual([]);
    expect(crud(manifest.objects[`${APP}:PublicNote`]).length).toBe(5);
  });

  it('fails generation for a concrete collection over a type keyword with no _itemClass', async () => {
    const root = await project({
      providers: {},
      app: {
        'src/Account.ts': `${CORE}\n@smrt({ tableName: 'app_accounts' })\nexport class Account extends SmrtObject {}\n`,
        'src/AccountCollection.ts': `${CORE}\nexport class AccountCollection extends SmrtCollection<any> {}\n`,
      },
    });

    await expect(build(root)).rejects.toThrow(
      'declare the item with a static _itemClass',
    );
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
