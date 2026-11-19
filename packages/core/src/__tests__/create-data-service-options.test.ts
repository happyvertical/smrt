/**
 * Data never configures a service of the object it becomes.
 *
 * A model is built from one options bag that holds service configuration
 * (`db`, `ai`, ...) beside field values. On every path where a collection
 * builds a model, and on every request-facing write path, the services are the
 * collection's own: a create input, a request body or a stored row sets fields
 * and nothing else, whatever its keys are called.
 *
 * Real SQLite files; nothing is mocked. `SMRT_VITEST_AUTO_SCHEMA=0` keeps the
 * shared test setup from creating application tables in any database a test
 * did not prepare itself, which is how a deployed runtime behaves.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { MCPGenerator } from '../generators/mcp.js';
import { APIGenerator } from '../generators/rest.js';
import { GlobalInterceptors } from '../interceptors.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import {
  SMRT_SERVICE_OPTION_KEYS,
  type SmrtServiceOptionKey,
} from '../service-options.js';
import { applySyncWritablePolicy } from '../sync/apply.js';
import { getTestDatabase } from '../testing/database.js';

@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
class ServiceOptionNote extends SmrtObject {
  @field({ type: 'text' })
  label: string = '';
}
class ServiceOptionNoteCollection extends SmrtCollection<ServiceOptionNote> {
  static readonly _itemClass = ServiceOptionNote;
}

// The same model behind an `api.writable` allowlist.
@smrt({
  api: { include: ['list', 'get', 'create', 'update'], writable: ['label'] },
})
class ServiceOptionListed extends SmrtObject {
  @field({ type: 'text' })
  label: string = '';
}
class ServiceOptionListedCollection extends SmrtCollection<ServiceOptionListed> {
  static readonly _itemClass = ServiceOptionListed;
}

// A model that declares a real field named like a service option.
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
class ServiceOptionReport extends SmrtObject {
  @field({ type: 'text' })
  title: string = '';

  /** Row data: a JSON-encoded list, unrelated to the `metrics` service. */
  @field({ type: 'text' })
  metrics: string = '[]';

  // `any`: mirrors models that re-type a service option key as a field.
  constructor(options: any = {}) {
    super(options);
    if (options.title !== undefined) this.title = options.title;
    if (typeof options.metrics === 'string') this.metrics = options.metrics;
  }
}
class ServiceOptionReportCollection extends SmrtCollection<ServiceOptionReport> {
  static readonly _itemClass = ServiceOptionReport;
}

// One STI table, to cover polymorphic creation and `_meta_data` hydration.
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update'] },
})
class ServiceOptionAsset extends SmrtObject {
  @field({ type: 'text' })
  label: string = '';
}
@smrt()
class ServiceOptionImage extends ServiceOptionAsset {}
class ServiceOptionAssetCollection extends SmrtCollection<ServiceOptionAsset> {
  static readonly _itemClass = ServiceOptionAsset;
}
class ServiceOptionImageCollection extends SmrtCollection<ServiceOptionImage> {
  static readonly _itemClass = ServiceOptionImage;
}

const CLASSES = [
  'ServiceOptionNote',
  'ServiceOptionListed',
  'ServiceOptionReport',
  'ServiceOptionAsset',
  'ServiceOptionImage',
];

const CONFIGURED_AI_URL = 'http://127.0.0.1:9/configured/v1';
const OTHER_AI_URL = 'http://127.0.0.1:9/other/v1';

/** Reads private runtime state the assertions below need. */
interface Probe {
  db: DatabaseInterface;
  options: Record<string, unknown>;
  _aiClientConfig?: { baseUrl?: string; apiKey?: string };
  ensureRuntimeServicesInitialized(): Promise<void>;
}
const probe = (instance: unknown) => instance as Probe;

describe('data never configures a service', () => {
  let dir: string;
  let db: DatabaseInterface;
  let otherDbPath: string;
  let notes: ServiceOptionNoteCollection;
  let listed: ServiceOptionListedCollection;
  let reports: ServiceOptionReportCollection;
  let assets: ServiceOptionAssetCollection;
  let images: ServiceOptionImageCollection;
  let handler: (req: Request) => Promise<Response>;
  let saved: SmrtObject[] = [];
  let fresh = 0;
  const previousEnv: Record<string, string | undefined> = {};

  /** A path nothing has created; a service built from data would create it. */
  const freshDbPath = () => join(dir, `unprepared-${++fresh}.db`);
  const unpreparedPaths = () =>
    Array.from({ length: fresh }, (_, index) =>
      join(dir, `unprepared-${index + 1}.db`),
    ).filter((path) => existsSync(path));

  /** One value per service option key; a new key must be given one here. */
  const samples: Record<SmrtServiceOptionKey, () => unknown> = {
    db: () => `file:${otherDbPath}`,
    persistence: () => ({ type: 'sqlite', url: freshDbPath() }),
    fs: () => ({ type: 'local', basePath: join(dir, 'files') }),
    ai: () => ({ baseUrl: OTHER_AI_URL }),
    decisions: () => ({ provider: 'openai', baseUrl: OTHER_AI_URL }),
    inference: () => ({
      tiers: { cheap: { provider: 'openai', baseUrl: OTHER_AI_URL } },
    }),
    usage: () => ({ persist: false }),
    logging: () => ({ level: 'debug' }),
    metrics: () => ({ enabled: true }),
    pubsub: () => ({ enabled: true }),
    sanitization: () => false,
    signals: () => ({ adapters: [] }),
  };
  /** The same keys under `options`, the instance property that holds them. */
  const optionsBag = () => ({
    db: { type: 'sqlite', url: freshDbPath() },
    ai: { baseUrl: OTHER_AI_URL },
  });
  const KEYS = [...SMRT_SERVICE_OPTION_KEYS, 'options'] as const;
  const sample = (key: (typeof KEYS)[number]) =>
    key === 'options' ? optionsBag() : samples[key]();

  const rowsIn = async (
    database: DatabaseInterface,
    table: string,
    label: string,
  ) =>
    (await database.query(`SELECT id FROM ${table} WHERE label = $1`, [label]))
      .rows.length;
  const rowsInOtherDb = async (table: string, label: string) => {
    const other = await getTestDatabase({ type: 'sqlite', url: otherDbPath });
    try {
      return await rowsIn(other, table, label);
    } finally {
      await other.close?.();
    }
  };

  /** The object written by the last request, with services initialized. */
  const lastSaved = async (): Promise<Probe> => {
    const instance = probe(saved.at(-1));
    expect(instance).toBeDefined();
    await instance.ensureRuntimeServicesInitialized();
    return instance;
  };

  /** Every service of `instance` is the collection's, not the data's. */
  const expectOwnServices = async (key: string) => {
    const instance = await lastSaved();
    expect(instance.db).toBe(db);
    expect(instance.options.db).toBe(db);
    for (const service of SMRT_SERVICE_OPTION_KEYS) {
      if (service === 'db') continue;
      expect(instance.options[service]).toBeUndefined();
    }
    expect(instance._aiClientConfig?.baseUrl).toBe(CONFIGURED_AI_URL);
    // `options` itself is the instance's own bag; every other key must not
    // have become a property of the instance.
    if (key !== 'db' && key !== 'options') {
      expect(Object.hasOwn(instance, key)).toBe(false);
    }
    expect(unpreparedPaths()).toEqual([]);
  };

  beforeAll(async () => {
    for (const name of [
      'SMRT_VITEST_AUTO_SCHEMA',
      'SMRT_AI_PROVIDER',
      'SMRT_AI_API_KEY',
      'SMRT_AI_BASE_URL',
    ]) {
      previousEnv[name] = process.env[name];
    }
    process.env.SMRT_VITEST_AUTO_SCHEMA = '0';
    // Server-side AI configuration the instances are expected to keep.
    process.env.SMRT_AI_PROVIDER = 'openai';
    process.env.SMRT_AI_API_KEY = 'configured-fixture-key';
    process.env.SMRT_AI_BASE_URL = CONFIGURED_AI_URL;

    for (const [name, collection] of [
      ['ServiceOptionNote', ServiceOptionNoteCollection],
      ['ServiceOptionListed', ServiceOptionListedCollection],
      ['ServiceOptionReport', ServiceOptionReportCollection],
      ['ServiceOptionAsset', ServiceOptionAssetCollection],
      ['ServiceOptionImage', ServiceOptionImageCollection],
    ] as const) {
      ObjectRegistry.registerCollection(name, collection as never);
    }

    dir = mkdtempSync(join(tmpdir(), 'smrt-service-options-'));
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: CLASSES,
    });
    // A second database that already holds the same tables: a row written
    // through a database taken from data would land here.
    otherDbPath = join(dir, 'other.db');
    const other = await getTestDatabase({
      type: 'sqlite',
      url: otherDbPath,
      classes: CLASSES,
    });
    await other.close?.();

    notes = await ServiceOptionNoteCollection.create({ db });
    listed = await ServiceOptionListedCollection.create({ db });
    reports = await ServiceOptionReportCollection.create({ db });
    assets = await ServiceOptionAssetCollection.create({ db });
    images = await ServiceOptionImageCollection.create({ db });

    const api = new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (req: Request) => req },
      { db },
    );
    api.registerCollection('notes', notes as never);
    api.registerCollection('listed', listed as never);
    api.registerCollection('reports', reports as never);
    api.registerCollection('assets', assets as never);
    handler = api.generateHandler();
  });

  beforeEach(() => {
    saved = [];
    GlobalInterceptors.register({
      name: 'create-data-service-options',
      afterSave(instance) {
        saved.push(instance);
      },
    });
  });

  afterEach(() => {
    GlobalInterceptors.unregister('create-data-service-options');
  });

  afterAll(async () => {
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const send = (method: string, path: string, body: unknown) =>
    handler(
      new Request(`http://local/api/${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  describe('the assertions can tell the difference', () => {
    it('direct construction still reads its options bag as before', async () => {
      const direct = new ServiceOptionNote({
        db,
        ai: { baseUrl: OTHER_AI_URL },
      });
      await direct.initialize();
      const instance = probe(direct);
      await instance.ensureRuntimeServicesInitialized();
      expect(instance._aiClientConfig?.baseUrl).toBe(OTHER_AI_URL);
    });
  });

  describe('collection create paths', () => {
    it.each(KEYS)('create() ignores %s in the data', async (key) => {
      const label = `create-${key}`;
      const created = await notes.create({ label, [key]: sample(key) });
      expect(created.label).toBe(label);
      expect(await rowsIn(db, notes.tableName, label)).toBe(1);
      expect(await rowsInOtherDb(notes.tableName, label)).toBe(0);
      if (key === 'options') {
        const instance = await lastSaved();
        expect(instance.db).toBe(db);
        expect(instance._aiClientConfig?.baseUrl).toBe(CONFIGURED_AI_URL);
        expect(unpreparedPaths()).toEqual([]);
      } else {
        await expectOwnServices(key);
      }
    });

    it('createMany() ignores every service option key in each input', async () => {
      const inputs = SMRT_SERVICE_OPTION_KEYS.map((key) => ({
        label: `many-${key}`,
        [key]: samples[key](),
      }));
      const created = await notes.createMany(inputs);
      expect(created.map((row) => row.label)).toEqual(
        inputs.map((input) => input.label),
      );
      for (const row of created) {
        // A batch runs in the collection's own transaction, so the handle is
        // the collection's or one derived from it, never a value from data.
        expect(typeof probe(row).options.db).toBe('object');
        expect(probe(row).options.db).toHaveProperty('query');
        expect(probe(row).options.persistence).toBeUndefined();
        expect(probe(row).options.ai).toBeUndefined();
        expect(await rowsIn(db, notes.tableName, row.label)).toBe(1);
        expect(await rowsInOtherDb(notes.tableName, row.label)).toBe(0);
      }
      expect(unpreparedPaths()).toEqual([]);
    });

    it.each(
      KEYS,
    )('STI creation by discriminator ignores %s in the data', async (key) => {
      const label = `sti-${key}`;
      const created = await assets.create({
        label,
        _meta_type: 'ServiceOptionImage',
        [key]: sample(key),
      });
      expect(created).toBeInstanceOf(ServiceOptionImage);
      expect(probe(created).db).toBe(db);
      expect(probe(created).options.db).toBe(db);
      expect(probe(created).options.ai).toBeUndefined();
      expect(await rowsIn(db, assets.tableName, label)).toBe(1);
      expect(await rowsInOtherDb(assets.tableName, label)).toBe(0);
      expect(unpreparedPaths()).toEqual([]);
    });

    it('a collection bound to another handle is the way to choose one', async () => {
      const other = await getTestDatabase({ type: 'sqlite', url: otherDbPath });
      try {
        const bound = await ServiceOptionNoteCollection.create({ db: other });
        const created = await bound.create({ label: 'bound-collection' });
        expect(probe(created).db).toBe(other);
        expect(await rowsIn(other, notes.tableName, 'bound-collection')).toBe(
          1,
        );
        expect(await rowsIn(db, notes.tableName, 'bound-collection')).toBe(0);
      } finally {
        await other.close?.();
      }
    });
  });

  describe('services a collection binds', () => {
    const BOUND_AI_URL = 'http://127.0.0.1:9/bound/v1';
    const boundAi = () => ({
      provider: 'openai',
      apiKey: 'bound-fixture-key',
      baseUrl: BOUND_AI_URL,
    });

    /** Every way the collection hands out an object: create, get and list. */
    const objectsOf = async (
      collection: ServiceOptionNoteCollection,
      label: string,
    ): Promise<Array<[string, Probe]>> => {
      const created = await collection.create({ label });
      const reloaded = await collection.get(created.id as string);
      const listed = (await collection.list({ where: { label } }))[0];
      const objects: Array<[string, Probe]> = [
        ['create', probe(created)],
        ['get', probe(reloaded)],
        ['list', probe(listed)],
      ];
      for (const [, object] of objects) {
        expect(object).toBeDefined();
        await object.ensureRuntimeServicesInitialized();
      }
      return objects;
    };

    it('reach every object it creates and loads, over the ambient configuration', async () => {
      const fsA = { type: 'local', basePath: join(dir, 'bound-files-a') };
      const fsB = { type: 'local', basePath: join(dir, 'bound-files-b') };
      const boundA = await ServiceOptionNoteCollection.create({
        db,
        fs: fsA,
        ai: boundAi(),
      } as never);
      const boundB = await ServiceOptionNoteCollection.create({
        db,
        fs: fsB,
      } as never);

      for (const [path, object] of await objectsOf(boundA, 'bound-a')) {
        expect([path, object.options.fs]).toEqual([path, fsA]);
        expect([path, (object as unknown as { fs: unknown }).fs]).not.toEqual([
          path,
          undefined,
        ]);
        expect([path, object._aiClientConfig?.baseUrl]).toEqual([
          path,
          BOUND_AI_URL,
        ]);
      }
      // Another collection's binding is its own; it binds no AI client, so
      // its objects keep the ambient one.
      for (const [path, object] of await objectsOf(boundB, 'bound-b')) {
        expect([path, object.options.fs]).toEqual([path, fsB]);
        expect([path, object._aiClientConfig?.baseUrl]).toEqual([
          path,
          CONFIGURED_AI_URL,
        ]);
      }
      // A collection that binds neither leaves both to configuration.
      for (const [path, object] of await objectsOf(notes, 'unbound')) {
        expect([path, object.options.fs]).toEqual([path, undefined]);
        expect([path, (object as unknown as { fs: unknown }).fs]).toEqual([
          path,
          undefined,
        ]);
        expect([path, object._aiClientConfig?.baseUrl]).toEqual([
          path,
          CONFIGURED_AI_URL,
        ]);
      }
    });

    it('win over a service key in the data', async () => {
      const fsBound = { type: 'local', basePath: join(dir, 'bound-files-c') };
      const bound = await ServiceOptionNoteCollection.create({
        db,
        fs: fsBound,
        ai: boundAi(),
      } as never);
      const created = probe(
        await bound.create({
          label: 'bound-over-data',
          fs: { type: 'local', basePath: join(dir, 'data-files') },
          ai: { baseUrl: OTHER_AI_URL },
        } as never),
      );
      await created.ensureRuntimeServicesInitialized();
      expect(created.options.fs).toEqual(fsBound);
      expect(created._aiClientConfig?.baseUrl).toBe(BOUND_AI_URL);
    });
  });

  describe('hydration from stored data', () => {
    it('keys stored in an STI metadata blob never become services', async () => {
      const created = await images.create({ label: 'stored-metadata' });
      await db.query(
        `UPDATE ${images.tableName} SET _meta_data = $1 WHERE id = $2`,
        [
          JSON.stringify({
            db: { type: 'sqlite', url: freshDbPath() },
            persistence: `file:${otherDbPath}`,
            ai: { baseUrl: OTHER_AI_URL },
            usage: { persist: false },
            sanitization: false,
          }),
          created.id,
        ],
      );

      const loaded = [
        await images.get(String(created.id)),
        (await images.list({ where: { label: 'stored-metadata' } }))[0],
        (await assets.list({ where: { label: 'stored-metadata' } }))[0],
      ];
      for (const row of loaded) {
        const instance = probe(row);
        expect(row).toBeInstanceOf(ServiceOptionImage);
        expect(instance.db).toBe(db);
        expect(instance.options.db).toBe(db);
        for (const key of ['persistence', 'ai', 'usage', 'sanitization']) {
          expect(instance.options[key]).toBeUndefined();
        }
        await instance.ensureRuntimeServicesInitialized();
        expect(instance._aiClientConfig?.baseUrl).toBe(CONFIGURED_AI_URL);
      }
      // A later write goes to the database the row was read from.
      const reloaded = (await images.get(
        String(created.id),
      )) as ServiceOptionImage;
      reloaded.label = 'stored-metadata-saved';
      await reloaded.save();
      expect(await rowsIn(db, images.tableName, 'stored-metadata-saved')).toBe(
        1,
      );
      expect(
        await rowsInOtherDb(images.tableName, 'stored-metadata-saved'),
      ).toBe(0);
      expect(unpreparedPaths()).toEqual([]);
    });
  });

  describe('a model field named like a service option', () => {
    const storedMetrics = async (title: string) =>
      (
        await db.query(
          `SELECT metrics FROM ${reports.tableName} WHERE title = $1`,
          [title],
        )
      ).rows.map((row: Record<string, unknown>) => String(row.metrics));

    it('is stored and hydrated as row data and configures nothing', async () => {
      const created = await reports.create({
        title: 'weekly',
        metrics: '["sessions"]',
      } as never);
      expect(created.metrics).toBe('["sessions"]');
      expect(probe(created).options.metrics).toBeUndefined();
      expect(await storedMetrics('weekly')).toEqual(['["sessions"]']);

      const loaded = await reports.get(String(created.id));
      expect(loaded?.metrics).toBe('["sessions"]');
      expect(probe(loaded).options.metrics).toBeUndefined();
      const [listedRow] = await reports.list({ where: { title: 'weekly' } });
      expect(listedRow.metrics).toBe('["sessions"]');

      // The field default applies when the data does not carry the field.
      const plain = await reports.create({ title: 'defaulted' } as never);
      expect(plain.metrics).toBe('[]');
    });

    it('is written through REST create and update', async () => {
      const post = await send('POST', 'reports', {
        title: 'rest-report',
        metrics: '["users"]',
        usage: { persist: false },
      });
      expect(post.status).toBe(201);
      const body = await post.json();
      expect(body.metrics).toBe('["users"]');
      expect(await storedMetrics('rest-report')).toEqual(['["users"]']);
      expect(probe(saved.at(-1)).options.metrics).toBeUndefined();
      expect(probe(saved.at(-1)).options.usage).toBeUndefined();

      const put = await send('PUT', `reports/${body.id}`, {
        metrics: '["users","sessions"]',
      });
      expect(put.status).toBe(200);
      expect(await storedMetrics('rest-report')).toEqual([
        '["users","sessions"]',
      ]);
    });

    it('is written through MCP create and update', async () => {
      const generator = new MCPGenerator(
        { classNames: ['ServiceOptionReport'] } as never,
        { db, user: { id: 'writer' } } as never,
      );
      const call = (name: string, args: Record<string, unknown>) =>
        generator.handleToolCall({
          method: 'tools/call',
          params: { name, arguments: args },
        } as never);
      const created = await call('serviceoptionreport_create', {
        title: 'mcp-report',
        metrics: '["users"]',
      });
      expect(created.isError).toBeFalsy();
      const { id } = JSON.parse(created.content[0].text as string);
      expect(await storedMetrics('mcp-report')).toEqual(['["users"]']);

      const updated = await call('serviceoptionreport_update', {
        id,
        metrics: '["sessions"]',
      });
      expect(updated.isError).toBeFalsy();
      expect(await storedMetrics('mcp-report')).toEqual(['["sessions"]']);
    });

    it('keeps working when a model is constructed directly', async () => {
      const direct = new ServiceOptionReport({
        db,
        title: 'direct',
        metrics: '["direct"]',
      });
      await direct.initialize();
      expect(direct.metrics).toBe('["direct"]');
    });
  });

  describe('runtime REST', () => {
    it.each(KEYS)('create saves normally with %s in the body', async (key) => {
      const label = `rest-create-${key}`;
      const response = await send('POST', 'notes', {
        label,
        [key]: sample(key),
      });
      expect(response.status).toBe(201);
      expect((await response.json()).label).toBe(label);
      expect(await rowsIn(db, notes.tableName, label)).toBe(1);
      expect(await rowsInOtherDb(notes.tableName, label)).toBe(0);
      await expectOwnServices(key);
    });

    it.each(KEYS)('update saves normally with %s in the body', async (key) => {
      const created = await notes.create({ label: `rest-before-${key}` });
      const label = `rest-update-${key}`;
      const response = await send('PUT', `notes/${created.id}`, {
        label,
        [key]: sample(key),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).label).toBe(label);
      expect(await rowsIn(db, notes.tableName, label)).toBe(1);
      expect(await rowsInOtherDb(notes.tableName, label)).toBe(0);
      await expectOwnServices(key);
    });

    it.each(
      KEYS,
    )('create of a selected subtype saves normally with %s in the body', async (key) => {
      const label = `rest-create-type-${key}`;
      const response = await send('POST', 'assets', {
        label,
        // The public selector is the subtype's qualified name.
        createType:
          ObjectRegistry.getClass('ServiceOptionImage')?.qualifiedName,
        [key]: sample(key),
      });
      expect(response.status).toBe(201);
      expect(saved.at(-1)).toBeInstanceOf(ServiceOptionImage);
      expect(await rowsIn(db, assets.tableName, label)).toBe(1);
      expect(await rowsInOtherDb(assets.tableName, label)).toBe(0);
      await expectOwnServices(key);
    });

    it('refuses underscore control keys in create and update bodies', async () => {
      const controls = {
        _insertOnly: true,
        _adoptNaturalKey: true,
        _className: 'Other',
        _reuseInitializedDb: true,
        _deferRuntimeInitialization: true,
        _skipAutoEmbeddings: true,
      };
      const savesBefore = saved.length;
      const refusedCreate = await send('POST', 'notes', {
        label: 'rest-controls',
        ...controls,
      });
      expect(refusedCreate.status).toBe(400);
      expect((await refusedCreate.json()).error).toMatchObject({
        code: 'VALIDATION_FIELD_NOT_WRITABLE',
        details: { field: '_insertOnly' },
      });
      expect(saved.length).toBe(savesBefore);
      expect(await rowsIn(db, notes.tableName, 'rest-controls')).toBe(0);

      // Negative control: the same body without the control keys is saved.
      const post = await send('POST', 'notes', { label: 'rest-controls' });
      expect(post.status).toBe(201);
      const { id } = await post.json();

      const refusedUpdate = await send('PUT', `notes/${id}`, {
        label: 'rest-controls-updated',
        ...controls,
      });
      expect(refusedUpdate.status).toBe(400);
      expect((await refusedUpdate.json()).error.code).toBe(
        'VALIDATION_FIELD_NOT_WRITABLE',
      );
      expect(await rowsIn(db, notes.tableName, 'rest-controls-updated')).toBe(
        0,
      );

      const put = await send('PUT', `notes/${id}`, {
        label: 'rest-controls-updated',
      });
      expect(put.status).toBe(200);
      const updated = saved.at(-1) as SmrtObject;
      const state = updated as unknown as Record<string, unknown>;
      expect(state._insertOnly).not.toBe(true);
      expect(state._className).toBe('ServiceOptionNote');
      expect(await rowsIn(db, notes.tableName, 'rest-controls-updated')).toBe(
        1,
      );
    });

    it('a model with an api.writable allowlist skips service keys and refuses other keys', async () => {
      const refused = await send('POST', 'listed', {
        label: 'allowlisted',
        other: 'not writable',
      });
      expect(refused.status).toBe(400);
      expect((await refused.json()).error.details).toEqual({ field: 'other' });

      const response = await send('POST', 'listed', {
        label: 'allowlisted',
        db: `file:${otherDbPath}`,
        ai: { baseUrl: OTHER_AI_URL },
      });
      expect(response.status).toBe(201);
      expect(await rowsIn(db, listed.tableName, 'allowlisted')).toBe(1);
      expect(await rowsInOtherDb(listed.tableName, 'allowlisted')).toBe(0);
      expect(probe(saved.at(-1)).options.other).toBeUndefined();
    });

    it.each(
      KEYS,
    )('sync apply saves normally with %s in a payload', async (key) => {
      const id = crypto.randomUUID();
      const label = `sync-create-${key}`;
      const apply = (items: unknown[]) => send('POST', 'sync/apply', { items });
      const created = await apply([
        {
          itemId: 'create',
          object: 'notes',
          op: 'create',
          id,
          payload: { label, [key]: sample(key) },
        },
      ]);
      expect(created.status).toBe(200);
      expect((await created.json()).results[0].status).toBe('applied');
      expect(await rowsIn(db, notes.tableName, label)).toBe(1);
      expect(await rowsInOtherDb(notes.tableName, label)).toBe(0);
      await expectOwnServices(key);

      const updatedLabel = `sync-update-${key}`;
      const updated = await apply([
        {
          itemId: 'update',
          object: 'notes',
          op: 'update',
          id,
          payload: { label: updatedLabel, [key]: sample(key) },
        },
      ]);
      expect((await updated.json()).results[0].status).toBe('applied');
      expect(await rowsIn(db, notes.tableName, updatedLabel)).toBe(1);
      await expectOwnServices(key);
    });
  });

  describe('in-process MCP', () => {
    let call: (name: string, args: Record<string, unknown>) => Promise<any>;

    beforeAll(() => {
      const generator = new MCPGenerator(
        { classNames: ['ServiceOptionNote'] } as never,
        { db, user: { id: 'writer' } } as never,
      );
      call = (name, args) =>
        generator.handleToolCall({
          method: 'tools/call',
          params: { name, arguments: args },
        } as never);
    });

    it.each(
      KEYS,
    )('create saves normally with %s in the arguments', async (key) => {
      const label = `mcp-create-${key}`;
      const result = await call('serviceoptionnote_create', {
        label,
        [key]: sample(key),
      });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.content[0].text).label).toBe(label);
      expect(await rowsIn(db, notes.tableName, label)).toBe(1);
      expect(await rowsInOtherDb(notes.tableName, label)).toBe(0);
      await expectOwnServices(key);
    });

    it.each(
      KEYS,
    )('update saves normally with %s in the arguments', async (key) => {
      const created = await notes.create({ label: `mcp-before-${key}` });
      const label = `mcp-update-${key}`;
      const result = await call('serviceoptionnote_update', {
        id: created.id,
        label,
        [key]: sample(key),
      });
      expect(result.isError).toBeFalsy();
      expect(await rowsIn(db, notes.tableName, label)).toBe(1);
      expect(await rowsInOtherDb(notes.tableName, label)).toBe(0);
      await expectOwnServices(key);
    });

    it('drops underscore control keys from create arguments', async () => {
      const result = await call('serviceoptionnote_create', {
        label: 'mcp-controls',
        _insertOnly: true,
        _className: 'Other',
        _reuseInitializedDb: true,
      });
      expect(result.isError).toBeFalsy();
      const created = probe(saved.at(-1));
      for (const key of ['_insertOnly', '_className', '_reuseInitializedDb']) {
        expect(created.options[key]).toBeUndefined();
      }
    });
  });

  describe('the sync writable policy', () => {
    it('drops every service option key unless the model declares it', () => {
      const payload = Object.fromEntries([
        ['label', 'kept'],
        ['options', {}],
        ['_insertOnly', true],
        ...SMRT_SERVICE_OPTION_KEYS.map((key) => [key, samples[key]()]),
      ]);
      expect(applySyncWritablePolicy(payload)).toEqual({ label: 'kept' });
      expect(
        applySyncWritablePolicy(payload, {
          isServiceOptionInput: (key) =>
            ObjectRegistry.isServiceOptionInput('ServiceOptionReport', key),
        }),
      ).toEqual({ label: 'kept', metrics: { enabled: true } });
      expect(unpreparedPaths()).toEqual([]);
    });
  });
});
