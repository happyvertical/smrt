/** #4869/A2: installed declarations, effective app identities and portable I/O. */
import { readFileSync } from 'node:fs';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import type { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCookbookFieldPolicy } from '../../../fields/src/policy.js';
import { deriveScreenFields } from '../../../smrt-svelte/src/components/screens/fields.js';
import {
  screenRecordLabel,
  screenReferenceTarget,
} from '../../../smrt-svelte/src/components/screens/references.js';
import { createRecipeScreenReferences } from '../../../smrt-svelte/src/components/screens/source.js';
import {
  draftForCreate,
  parseDraft,
} from '../../../smrt-svelte/src/components/screens/values.js';
import { buildActivationManifest } from '../activation/generate.js';
import { createActivationCoordinator } from '../activation.js';
import { SmrtCollection } from '../collection';
import { createCookbookEngine } from '../cookbook/engine/engine.js';
import { foreignKey } from '../decorators';
import { MCPGenerator } from '../generators/mcp';
import { APIGenerator } from '../generators/rest';
import { buildDomainKnowledgeManifest } from '../knowledge';
import { clearManifestCache } from '../manifest/manifest-loader';
import { annotateModelReplacements } from '../manifest/model-replacements';
import { generateSchemaDiff } from '../migrations/differ';
import { createMigrationDefinition } from '../migrations/generator';
import { collectStatementsFromDiff } from '../migrations/orchestrate';
import { MigrationTracker } from '../migrations/tracker';
import { SmrtObject } from '../object';
import { ObjectRegistry } from '../registry';
import { createConsumerWorkspace } from '../registry/__tests__/helpers/consumer-workspace';
import {
  createCookbookRuntimeExposure,
  setRuntimeExposureGate,
} from '../runtime-exposure.js';
import { ManifestGenerator } from '../scanner/manifest-generator';
import type { SmartObjectManifest } from '../scanner/types';
import { SchemaAggregator } from '../schema/schema-aggregator';
import { snapshotObjectRegistryState } from '../test-utils';
import { getTestDatabase } from '../testing/database.js';
import { generateSvelteKitRoutes } from '../vite-plugin/sveltekit-generator';
import {
  buildWebCollectionDefinition,
  buildWebMcpToolDefinitions,
  selectWebCollectionEntries,
} from '../vite-plugin/web-collections';

const databaseType = process.env.SMRT_TEST_PGLITE === '1' ? 'pglite' : 'sqlite';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const dialect = databaseType === 'pglite' ? 'postgres' : 'sqlite';
const databaseUrl = databaseType === 'pglite' ? 'memory://' : ':memory:';

const UP = '@fixture/a2-upstream';
const APP = '@fixture/a2-app';
const upstreamSource = `import { smrt, SmrtObject, foreignKey } from '@happyvertical/smrt-core';
@smrt({ tableName: 'a2_customers', previousQualifiedNames: ['@fixture/a2-old:Customer'], api: { public: true }, cli: true, mcp: true })
export class Customer extends SmrtObject { tenantId = ''; profileId = ''; title = ''; greeting() { return 'upstream'; } }
@smrt({ tableName: 'a2_invoices', api: { public: true } })
export class Invoice extends SmrtObject { @foreignKey(Customer) customerId = ''; }
@smrt({ tableName: 'a2_profiles', tableStrategy: 'sti', api: true, mcp: true })
export class Profile extends SmrtObject { title = ''; }
@smrt({ api: false })
export class Person extends Profile { firstName = ''; }
@smrt({ tableName: 'a2_bases', tableStrategy: 'cti' })
export class Base extends SmrtObject { baseValue = ''; }
@smrt({ tableName: 'a2_leaves' })
export class Leaf extends Base { baseValue = ''; leafValue = ''; }
`;
const appSource = (
  custom = true,
) => `import { smrt, SmrtCollection } from '@happyvertical/smrt-core';
import { Customer as CustomerBase, Profile as ProfileBase, Base as BaseBase } from '${UP}';
@smrt({})
export class AppCustomer extends CustomerBase { ${custom ? "favoritePose = ''; visits = 0;" : ''} greeting() { return 'app'; } }
export { AppCustomer as Customer };
@smrt({})
export class Customers extends SmrtCollection<AppCustomer> { static readonly _itemClass = AppCustomer; }
@smrt({})
export class Profile extends ProfileBase { badge = ''; }
@smrt({})
export class Base extends BaseBase { extra = ''; }
`;

async function scan(root: string, pkg: string, deps: string[] = []) {
  const { results, resolved } = await new OxcScanner({
    cwd: root,
    include: ['src/**/*.ts'],
  }).scanAndResolve();
  expect(results.errors.filter((error) => error.severity === 'error')).toEqual(
    [],
  );
  const manifest = new ManifestAdapter().toManifest(resolved, {
    packageName: pkg,
  }) as SmartObjectManifest;
  manifest.smrtDependencies = deps;
  new ManifestGenerator().applyGenerationPasses(manifest, { packageName: pkg });
  return manifest;
}

function register(
  ctor: typeof SmrtObject,
  manifest: SmartObjectManifest,
  name = ctor.name,
) {
  const key = `${manifest.packageName}:${name}`;
  ObjectRegistry.register(ctor, {
    name,
    packageName: manifest.packageName,
    _manifest: { ...manifest, objects: { [key]: manifest.objects[key] } },
    _manifestKey: key,
  });
}

function runtime(up: SmartObjectManifest, app?: SmartObjectManifest) {
  class Customer extends SmrtObject {
    tenantId = '';
    profileId = '';
    title = '';
    greeting() {
      return 'upstream';
    }
  }
  class Invoice extends SmrtObject {
    customerId = '';
  }
  class Profile extends SmrtObject {
    title = '';
  }
  class Person extends Profile {
    firstName = '';
  }
  class Base extends SmrtObject {
    baseValue = '';
  }
  class Leaf extends Base {
    baseValue = '';
    leafValue = '';
  }
  if (up.objects[`${UP}:Customer`].decoratorConfig.display)
    foreignKey(Profile)(Customer.prototype, 'profileId');
  foreignKey(Customer)(Invoice.prototype, 'customerId');
  for (const ctor of [Customer, Invoice, Profile, Person, Base, Leaf])
    register(ctor, up);
  class Customers extends SmrtCollection<Customer> {
    static readonly _itemClass = Customer;
  }
  ObjectRegistry.registerCollection('Customer', Customers);
  if (!app)
    return { Customer, Invoice, Profile, Person, Base, Leaf, Customers };
  class AppCustomer extends Customer {
    favoritePose = '';
    visits = 0;
    override greeting() {
      return 'app';
    }
  }
  class AppProfile extends Profile {
    badge = '';
  }
  class AppBase extends Base {
    extra = '';
  }
  // Native decorators execute before generated isolated registrations.
  ObjectRegistry.register(AppCustomer, { packageName: APP });
  register(AppCustomer, app, 'Customer');
  register(AppProfile, app, 'Profile');
  register(AppBase, app, 'Base');
  return {
    Customer,
    Invoice,
    Profile,
    Person,
    Base,
    Leaf,
    Customers,
    AppCustomer,
    AppProfile,
    AppBase,
  };
}

let ws: ReturnType<typeof createConsumerWorkspace>;
let restore: () => void;
let cwd: string;
let up: SmartObjectManifest;
let app: SmartObjectManifest;
let merged: SmartObjectManifest;
let db: Awaited<ReturnType<typeof getDatabase>> | undefined;

beforeEach(async () => {
  restore = snapshotObjectRegistryState();
  ObjectRegistry.clear();
  ws = createConsumerWorkspace('smrt-a2');
  cwd = process.cwd();
  ws.writePackage('app', APP);
  ws.write(
    'node_modules/@fixture/a2-upstream/package.json',
    JSON.stringify({
      name: UP,
      type: 'module',
      exports: {
        '.': './dist/index.js',
        './manifest.json': './dist/manifest.json',
      },
    }),
  );
  ws.write('node_modules/@fixture/a2-upstream/dist/index.js', 'export {};');
  ws.write('node_modules/@fixture/a2-upstream/src/models.ts', upstreamSource);
  process.chdir(ws.path('app'));
  up = await scan(ws.path('node_modules/@fixture/a2-upstream'), UP);
  ws.write(
    'node_modules/@fixture/a2-upstream/dist/manifest.json',
    JSON.stringify(up),
  );
  ws.write('app/src/models.ts', appSource());
  app = await scan(ws.path('app'), APP, [UP]);
  merged = annotateModelReplacements({
    ...app,
    objects: { ...up.objects, ...app.objects },
  });
});
afterEach(async () => {
  await db?.close?.();
  db = undefined;
  process.chdir(cwd);
  ws.dispose();
  setRuntimeExposureGate(undefined);
  clearManifestCache();
  restore();
});

function schemas(manifest: SmartObjectManifest) {
  const file = ws.write(
    'app/migration-manifest.json',
    JSON.stringify(manifest),
  );
  const aggregate = new SchemaAggregator().aggregate({
    packages: [APP],
    localPaths: { [APP]: file },
    dialect,
  });
  return Object.fromEntries(
    [...aggregate.tables].map(([name, table]) => [name, table.definition]),
  );
}
async function migrate(manifest: SmartObjectManifest) {
  if (!db) throw new Error('Database fixture not initialized');
  const diff = await generateSchemaDiff(db, schemas(manifest), {
    engineHint: dialect,
  });
  const statements = collectStatementsFromDiff(diff, db, dialect);
  if (statements.length) {
    const results = await new MigrationTracker({
      db,
      engineHint: dialect,
    }).applyAll(
      [
        createMigrationDefinition(
          `a2_schema_${crypto.randomUUID()}`,
          statements,
          [],
          { packageName: APP, version: '1' },
        ),
      ],
      { atomic: true, postgresSafe: false },
    );
    const failed = results.find((result) => !result.success);
    if (failed) throw failed.error;
  }
  return statements;
}

describe('same-name app subclass', () => {
  // Both engines use the same lazy readiness and effective app identity contract.
  it('serves reference picker search and labels from the effective app model only after lazy activation', async () => {
    runtime(up, app);
    db = await getTestDatabase({
      type: databaseType,
      url: databaseUrl,
      includeSystemTables: false,
      classes: [],
    });
    merged.objects[`${APP}:Customer`].displayLabelField = 'title';
    const activation = createActivationCoordinator({
      scope: ws.root,
      db,
      packageName: APP,
      manifest: buildActivationManifest(
        merged,
        Object.fromEntries(
          Object.keys(merged.objects).map((id) => [
            id,
            { specifier: id, models: [id], dependencies: [] },
          ]),
        ),
      ),
      loaders: Object.fromEntries(
        Object.keys(merged.objects).map((id) => [id, async () => {}]),
      ),
      readEnabled: async () => [],
    });
    let components = true;
    const catalog = {
      models: [
        {
          id: `${UP}:Customer`,
          name: 'Customer',
          packageId: 'a2-upstream',
          exposed: true,
        },
      ],
      recipes: [],
    };
    const engine = createCookbookEngine({ catalog });
    const gate = createCookbookRuntimeExposure({
      catalog,
      engineFor: () => engine,
      predicate: () => components,
    });
    engine.run({ name: 'add_features', input: { ids: [`${UP}:Customer`] } });
    setRuntimeExposureGate(activation.gate(gate));
    await activation.boot();
    const entries = selectWebCollectionEntries(merged);
    const customerEntry = entries.find(
      (entry) => entry.obj.qualifiedName === `${APP}:Customer`,
    )!;
    const invoiceEntry = entries.find(
      (entry) => entry.obj.qualifiedName === `${UP}:Invoice`,
    )!;
    const customer = {
      ...buildWebCollectionDefinition(customerEntry, merged),
      endpoint: '/customers',
    };
    const invoice = buildWebCollectionDefinition(invoiceEntry, merged);
    const handler = new APIGenerator(
      { basePath: '/api' },
      { db, tenantId: TENANT_A },
    ).generateHandler();
    const fetcher: typeof fetch = async (input, init) =>
      handler(new Request(new URL(String(input), 'http://fixture'), init));
    const references = createRecipeScreenReferences(
      { customers: customer },
      { fetch: fetcher },
    );
    const target = screenReferenceTarget(
      invoice,
      { name: 'customerId' },
      references,
    )!;
    expect(target.definition.objectRef).toBe(`${APP}:Customer`);
    await expect(
      target.source.search!({ query: 'Maya', offset: 0, limit: 10 }),
    ).rejects.toThrow();
    // Invoice's FK closure activates the provider Customer and its app replacement.
    await activation.activate([`${UP}:Invoice`]);
    const customers = await ObjectRegistry.getCollection(`${UP}:Customer`, {
      db,
    });
    const row = await customers.create({
      title: 'Maya',
      favoritePose: 'tree',
    });
    const page = await target.source.search!({
      query: 'Maya',
      offset: 0,
      limit: 10,
    });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ favoritePose: 'tree' });
    expect(screenRecordLabel(target.definition, page.rows[0])).toBe('Maya');
    expect(await target.source.get!(row.id!)).toMatchObject({
      title: 'Maya',
      favoritePose: 'tree',
    });
    components = false;
    expect(await target.source.get!(row.id!)).toBeUndefined();
    expect(activation.isReady(`${APP}:Customer`)).toBe(true);
    gate.dispose();
  });
  it('preserves upstream storage and columns for plain, STI and CTI replacements', () => {
    for (const [name, table, inherited] of [
      ['Customer', 'a2_customers', 'tenant_id'],
      ['Profile', 'a2_profiles', 'title'],
      ['Base', 'a2_bases', 'base_value'],
    ]) {
      const entry = app.objects[`${APP}:${name}`];
      expect(entry.schema?.tableName).toBe(table);
      expect(entry.schema?.columns).toHaveProperty(inherited);
      expect(merged.objects[`${UP}:${name}`].replacedBy).toBe(`${APP}:${name}`);
    }
    expect(app.objects[`${APP}:Customer`].exportName).toBe('Customer');
    expect(app.objects[`${APP}:AppCustomer`]).toBeUndefined();
    expect(
      app.objects[`${APP}:Customer`].decoratorConfig.previousQualifiedNames,
    ).toBeUndefined();
    expect(app.objects[`${APP}:Customers`].collectionOf).toBe(
      `${APP}:Customer`,
    );
    expect(up.objects[`${UP}:Leaf`].schema?.tableName).toBe('a2_leaves');
    expect(up.objects[`${UP}:Leaf`].schema?.columns).toHaveProperty(
      'base_value',
    );
  });

  it('keeps provider cookbook defaults and hidden fields on generated app STI creates', async () => {
    runtime(up, app);
    db = await getTestDatabase({
      type: databaseType,
      url: databaseUrl,
      includeSystemTables: false,
      classes: [],
    });
    await migrate(merged);
    await ObjectRegistry.getCollection(`${UP}:Profile`, { db });
    const entry = selectWebCollectionEntries(merged).find(
      (e) => e.obj.qualifiedName === `${APP}:Profile`,
    )!;
    const definition = buildWebCollectionDefinition(entry, merged);
    expect(definition.objectRef).toBe(`${APP}:Profile`);
    expect(definition.replacedQualifiedNames).toEqual([`${UP}:Profile`]);
    const cookbook = {
      policies: [
        {
          objectRef: `${UP}:Profile`,
          fieldName: 'title',
          label: 'Customer name',
          defaultValue: '"New customer"',
        },
        {
          objectRef: `${UP}:Profile`,
          fieldName: 'badge',
          visibility: 'hidden',
          defaultValue: '"PRIVATE"',
        },
      ],
    } satisfies Parameters<typeof resolveCookbookFieldPolicy>[1];
    const policy = resolveCookbookFieldPolicy(definition, cookbook);
    const fields = deriveScreenFields(definition, policy, { mode: 'edit' });
    expect(fields.find((field) => field.name === 'badge')).toBeUndefined();
    expect(fields.find((field) => field.name === 'title')?.label).toBe(
      'Customer name',
    );
    const payload = parseDraft(fields, draftForCreate(fields, policy));
    expect(payload.errors).toEqual({});
    // EditForm adds hidden create defaults from the same policy; never synthesize a subtype discriminator.
    const values = {
      ...payload.values,
      badge: policy.fields.badge.defaultValue,
    };
    expect(values).not.toHaveProperty('_meta_type');
    const handler = new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (req) => req },
      { db, user: { id: 'test' }, permissions: ['profiles.create'] },
    ).generateHandler();
    const response = await handler(
      new Request(`http://localhost/api${definition.endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      }),
    );
    expect(response.status, await response.text()).toBe(201);
    expect(
      (await db.query('SELECT title, badge, _meta_type FROM a2_profiles')).rows,
    ).toEqual([
      { title: 'New customer', badge: 'PRIVATE', _meta_type: `${APP}:Profile` },
    ]);
  });

  it('dispatches shared STI creates to the app root even with children first', async () => {
    const f = runtime(up, app);
    db = await getTestDatabase({
      type: databaseType,
      url: databaseUrl,
      includeSystemTables: false,
      classes: [],
    });
    await migrate(merged);
    await ObjectRegistry.getCollection(`${UP}:Profile`, { db });
    await ObjectRegistry.getCollection(`${UP}:Person`, { db });
    const original = ObjectRegistry.getAllClasses();
    const order = vi
      .spyOn(ObjectRegistry, 'getAllClasses')
      .mockReturnValue(
        new Map(
          [...original].sort(
            (left, right) =>
              Number(right[1].name === 'Person') -
              Number(left[1].name === 'Person'),
          ),
        ),
      );
    try {
      const api = new APIGenerator(
        { basePath: '/api', authMiddleware: () => async (req) => req },
        { db, user: { id: 'test' }, permissions: ['profiles.create'] },
      ).generateHandler();
      const response = await api(
        new Request('http://localhost/api/profiles', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'REST base', badge: 'app' }),
        }),
      );
      expect(response.status, await response.text()).toBe(201);
      const mcp = new MCPGenerator(
        { classNames: [`${APP}:Profile`] },
        { db, user: { id: 'test' } },
      );
      for (const discriminator of [undefined, `${UP}:Person`]) {
        const result = await mcp.handleToolCall({
          method: 'tools/call',
          params: {
            name: 'profile_create',
            arguments: {
              title: discriminator ? 'Person' : 'MCP base',
              ...(discriminator ? { _meta_type: discriminator } : {}),
            },
          },
        });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
      }
      const { rows } = await db.query(
        'SELECT title, _meta_type FROM a2_profiles ORDER BY title',
      );
      expect(rows).toEqual([
        { title: 'MCP base', _meta_type: `${APP}:Profile` },
        { title: 'Person', _meta_type: `${UP}:Person` },
        { title: 'REST base', _meta_type: `${APP}:Profile` },
      ]);
      expect(
        (
          await ObjectRegistry.getCollection(`${UP}:Profile`, { db })
        ).getItemClass(),
      ).toBe(f.AppProfile);
    } finally {
      order.mockRestore();
    }
  });

  it.each([
    { replacement: false, lazy: false },
    { replacement: true, lazy: false },
    { replacement: false, lazy: true },
    { replacement: true, lazy: true },
  ])('agrees on gated STI collection ownership through REST and MCP: %j', async ({
    replacement,
    lazy,
  }) => {
    const fixture = runtime(up, replacement ? app : undefined);
    db = await getTestDatabase({
      type: databaseType,
      url: databaseUrl,
      includeSystemTables: false,
      classes: [],
    });
    const manifest = replacement ? merged : up;
    const activation = lazy
      ? createActivationCoordinator({
          scope: ws.root,
          db,
          packageName: APP,
          manifest: buildActivationManifest(
            manifest,
            Object.fromEntries(
              Object.keys(manifest.objects).map((id) => [
                id,
                { specifier: id, models: [id], dependencies: [] },
              ]),
            ),
          ),
          loaders: Object.fromEntries(
            Object.keys(manifest.objects).map((id) => [id, async () => {}]),
          ),
          readEnabled: async () => [],
        })
      : undefined;
    if (activation) await activation.boot();
    else await migrate(manifest);
    const provider = `${UP}:Profile`;
    const effective = `${replacement ? APP : UP}:Profile`;
    const catalog = {
      models: [
        {
          id: provider,
          name: 'Profile',
          packageId: 'a2-upstream',
          exposed: true,
        },
      ],
      recipes: [],
    };
    const engine = createCookbookEngine({ catalog });
    const gate = createCookbookRuntimeExposure({
      catalog,
      engineFor: () => engine,
    });
    if (!lazy) {
      await ObjectRegistry.getCollection(`${UP}:Profile`, { db });
      await ObjectRegistry.getCollection(`${UP}:Person`, { db });
    }
    const original = ObjectRegistry.getAllClasses.bind(ObjectRegistry);
    const order = vi
      .spyOn(ObjectRegistry, 'getAllClasses')
      .mockImplementation(
        () =>
          new Map(
            [...original()].sort(
              (a, b) =>
                Number(b[1].name === 'Person') - Number(a[1].name === 'Person'),
            ),
          ),
      );
    const observed: Array<string | undefined> = [];
    const observedGate = {
      isEnabled(model, context) {
        observed.push(model.qualifiedName);
        return gate.isEnabled(model, context);
      },
    } satisfies import('../runtime-exposure.js').RuntimeExposureGate;
    setRuntimeExposureGate(
      activation ? activation.gate(observedGate) : observedGate,
    );
    try {
      expect(ObjectRegistry.getExposureModel(provider)?.qualifiedName).toBe(
        effective,
      );
      const api = new APIGenerator(
        { basePath: '/api', authMiddleware: () => async (req) => req },
        {
          db,
          tenantId: TENANT_A,
          user: { id: 'test' },
          permissions: ['profiles.create'],
        },
      ).generateHandler();
      const request = () =>
        api(
          new Request('http://fixture/api/profiles', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Gated base' }),
          }),
        );
      const mcp = new MCPGenerator(
        { classNames: [effective] },
        {
          db,
          tenantId: TENANT_A,
          user: { id: 'test' },
        },
      );
      const call = () =>
        mcp.handleToolCall({
          method: 'tools/call',
          params: {
            name: 'profile_create',
            arguments: { title: 'MCP gated base' },
          },
        });
      const definitions = await mcp.generateToolDefinitions();
      expect(definitions.some((tool) => tool.name === 'profile_create')).toBe(
        true,
      );
      expect((await request()).status).toBe(404);
      expect(await mcp.generateTools()).toEqual([]);
      expect((await call()).isError).toBe(true);
      expect(
        engine.run({ name: 'add_features', input: { ids: [provider] } }).ok,
      ).toBe(true);
      if (activation) {
        expect((await request()).status).toBe(404);
        await activation.activate([provider]);
        expect(activation.isReady(`${UP}:Person`)).toBe(true);
        expect(
          (
            await db.query(
              databaseType === 'pglite'
                ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'a2_%'"
                : "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'a2_%'",
            )
          ).rows,
        ).toEqual([{ name: 'a2_profiles' }]);
      }
      expect((await request()).status).toBe(201);
      expect(
        (await mcp.generateTools()).some(
          (tool) => tool.name === 'profile_create',
        ),
      ).toBe(true);
      expect((await call()).isError).not.toBe(true);
      expect(
        (await db.query('SELECT _meta_type FROM a2_profiles')).rows,
      ).toEqual([{ _meta_type: effective }, { _meta_type: effective }]);
      expect(
        (await ObjectRegistry.getCollection(provider, { db })).getItemClass(),
      ).toBe(replacement ? fixture.AppProfile : fixture.Profile);
      // Discovery and dispatch gate the effective base; create offerings also gate each subtype.
      expect(new Set(observed)).toEqual(new Set([effective, `${UP}:Person`]));
      expect(
        engine.run({ name: 'remove_features', input: { ids: [provider] } }).ok,
      ).toBe(true);
      expect((await request()).status).toBe(404);
      expect(await mcp.generateTools()).toEqual([]);
      expect((await call()).isError).toBe(true);
      expect(await mcp.generateToolDefinitions()).toEqual(definitions);
      expect(
        (await db.query('SELECT COUNT(*) AS count FROM a2_profiles')).rows[0]
          .count,
      ).toBe(2);
    } finally {
      setRuntimeExposureGate(undefined);
      gate.dispose();
      order.mockRestore();
    }
  });

  it('keeps declared STI and CTI bases while resolving I/O to the app constructor', async () => {
    const f = runtime(up, app);
    expect(ObjectRegistry.getClass(`${UP}:Customer`)?.constructor).toBe(
      f.AppCustomer,
    );
    expect(ObjectRegistry.getClassByConstructor(f.Customer)?.constructor).toBe(
      f.AppCustomer,
    );
    expect(
      ObjectRegistry.getClassByQualifiedName('@fixture/a2-old:Customer')
        ?.constructor,
    ).toBe(f.AppCustomer);
    expect(ObjectRegistry.getInheritanceChain(`${UP}:Person`)).toEqual([
      `${UP}:Profile`,
      `${UP}:Person`,
    ]);
    expect(ObjectRegistry.getInheritanceChain(`${UP}:Leaf`)).toEqual([
      `${UP}:Base`,
      `${UP}:Leaf`,
    ]);
    expect(ObjectRegistry.getInheritanceChain(`${APP}:Profile`)).toEqual([
      `${UP}:Profile`,
      `${APP}:Profile`,
    ]);
    expect(ObjectRegistry.getTableName(`${UP}:Person`)).toBe('a2_profiles');
    expect(ObjectRegistry.getDescendants(`${APP}:Profile`)).toContain(
      `${UP}:Person`,
    );
    expect(ObjectRegistry.getTableName(`${UP}:Leaf`)).toBe('a2_leaves');
    db = await getTestDatabase({
      type: databaseType,
      url: databaseUrl,
      includeSystemTables: false,
      classes: [],
    });
    await migrate(merged);
    const customers = await f.Customers.create({ db });
    expect(customers.getItemClass()).toBe(f.AppCustomer);
    const customer = await customers.create({
      title: 'Maya',
      tenantId: TENANT_A,
      profileId: 'profile',
      favoritePose: 'tree',
    });
    expect(customer).toBeInstanceOf(f.AppCustomer);
    expect(customer.greeting()).toBe('app');
    expect((await customers.get(customer.id!))?.toJSON()).toMatchObject({
      favoritePose: 'tree',
      tenantId: TENANT_A,
      profileId: 'profile',
    });
    const invoices = await ObjectRegistry.getCollection(`${UP}:Invoice`, {
      db,
    });
    const invoice = await invoices.create({ customerId: customer.id });
    expect(await invoice.loadRelated('customerId')).toBeInstanceOf(
      f.AppCustomer,
    );
    expect((await invoice.loadRelated('customerId')).favoritePose).toBe('tree');
    const people = await ObjectRegistry.getCollection(`${UP}:Person`, { db });
    const person = await people.create({ title: 'Ada', firstName: 'Ada' });
    expect((await people.get(person.id!))?.toJSON()).toMatchObject({
      title: 'Ada',
      firstName: 'Ada',
    });
    const profiles = await ObjectRegistry.getCollection(`${UP}:Profile`, {
      db,
    });
    expect((await profiles.list()).some((row) => row instanceof f.Person)).toBe(
      true,
    );
    const bases = await ObjectRegistry.getCollection(`${UP}:Base`, { db });
    const base = await bases.create({ baseValue: 'parent', extra: 'app' });
    expect((await bases.get(base.id!))?.toJSON()).toMatchObject({
      baseValue: 'parent',
      extra: 'app',
    });
    const leaves = await ObjectRegistry.getCollection(`${UP}:Leaf`, { db });
    const leaf = await leaves.create({ leafValue: 'leaf' });
    expect((await leaves.get(leaf.id!))?.toJSON()).toMatchObject({
      leafValue: 'leaf',
    });
    expect(ObjectRegistry.getInheritanceChain(`${UP}:Leaf`)).toEqual([
      `${UP}:Base`,
      `${UP}:Leaf`,
    ]);
    expect((await ObjectRegistry.getAllFields(`${UP}:Leaf`)).has('extra')).toBe(
      false,
    );
  });

  it('keeps the provider cookbook identity when gating an app replacement', async () => {
    db = await getTestDatabase({
      type: databaseType,
      url: databaseUrl,
      includeSystemTables: false,
      classes: [],
    });
    const fixture = runtime(up, app);
    const Item = fixture.AppCustomer;
    if (!Item) throw new Error('App subclass fixture was not registered');
    class AppCustomers extends SmrtCollection<InstanceType<typeof Item>> {
      static readonly _itemClass = Item;
    }
    register(AppCustomers as unknown as typeof SmrtObject, app, 'Customers');
    ObjectRegistry.registerCollection(`${APP}:Customers`, AppCustomers);
    await migrate(merged);
    const id = `${UP}:Customer`;
    const catalog = {
      models: [
        { id, name: 'Customer', packageId: 'a2-upstream', exposed: true },
      ],
      recipes: [],
    };
    const engine = createCookbookEngine({ catalog });
    const gate = createCookbookRuntimeExposure({
      catalog,
      engineFor: () => engine,
    });
    setRuntimeExposureGate(gate);
    try {
      const customers = await ObjectRegistry.getCollection(id, { db });
      const api = new APIGenerator(
        { basePath: '/api' },
        { db, tenantId: TENANT_A },
      );
      api.registerCollection('customers', customers);
      const request = () =>
        api.generateHandler()(new Request('http://fixture/api/customers'));
      const mcp = new MCPGenerator(
        { classNames: [`${APP}:Customer`] },
        { db, tenantId: TENANT_A },
      );
      expect((await request()).status).toBe(404);
      expect(await mcp.generateTools()).toEqual([]);
      expect(
        engine.run({ name: 'add_features', input: { ids: [id] } }).ok,
      ).toBe(true);
      expect((await request()).status).toBe(200);
      expect(
        ObjectRegistry.getExposureModel(`${APP}:Customers`)?.qualifiedName,
      ).toBe(`${APP}:Customer`);
      expect(
        (
          await new MCPGenerator(
            { classNames: [`${APP}:Customers`] },
            { tenantId: TENANT_A },
          ).generateTools()
        ).some((tool) => tool.name === 'customers_list'),
      ).toBe(true);
      expect(
        (await mcp.generateTools()).some(
          (tool) => tool.name === 'customer_list',
        ),
      ).toBe(true);
    } finally {
      gate.dispose();
    }
  });

  it('migrates a custom column onto the existing upstream table and serves REST CRUD', async () => {
    db = await getTestDatabase({
      type: databaseType,
      url: databaseUrl,
      includeSystemTables: false,
      classes: [],
    });
    await migrate(up);
    runtime(up, app);
    const statements = await migrate(merged);
    expect(statements.join('\n')).toMatch(
      /ALTER TABLE.*a2_customers.*ADD COLUMN.*favorite_pose/,
    );
    expect(statements.join('\n')).not.toContain('CREATE TABLE');
    expect(await migrate(merged)).toEqual([]);
    const journal = await db.query(
      'SELECT status FROM _smrt_schema_migrations',
    );
    expect(journal.rows).toEqual([
      { status: 'completed' },
      { status: 'completed' },
    ]);
    const customers = await ObjectRegistry.getCollection(`${UP}:Customer`, {
      db,
    });
    const api = new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (req) => req },
      { db },
    );
    api.registerCollection('customers', customers);
    const handler = api.generateHandler();
    const request = (path = '', method = 'GET', body?: object) =>
      handler(
        new Request(`http://fixture/api/customers${path}`, {
          method,
          ...(body
            ? {
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              }
            : {}),
        }),
      );
    const created = await request('', 'POST', {
      title: 'Maya',
      favoritePose: 'tree',
      visits: 4_294_967_296,
      tenantId: TENANT_A,
      profileId: 'profile',
    });
    expect(created.status).toBe(201);
    const row = (await created.json()) as {
      id: string;
      favoritePose: string;
      visits: number;
    };
    expect(row.visits).toBe(4_294_967_296);
    expect(await (await request(`/${row.id}`)).json()).toMatchObject({
      visits: 4_294_967_296,
    });
    if (databaseType === 'pglite') {
      const { rows } = await db.query(
        "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'a2_customers' AND column_name IN ('id', 'visits') ORDER BY column_name",
      );
      expect(rows).toEqual([
        { column_name: 'id', data_type: 'uuid' },
        { column_name: 'visits', data_type: 'bigint' },
      ]);
    }
    expect(row.favoritePose).toBe('tree');
    expect(
      ((await (await request(`/${row.id}`)).json()) as { favoritePose: string })
        .favoritePose,
    ).toBe('tree');
    expect(
      (await request(`/${row.id}`, 'PUT', { favoritePose: 'lotus' })).status,
    ).toBe(200);
    expect(
      ((await (await request(`/${row.id}`)).json()) as { favoritePose: string })
        .favoritePose,
    ).toBe('lotus');
    expect((await request()).status).toBe(200);
    expect((await request(`/${row.id}`, 'DELETE')).status).toBe(204);
    expect((await request(`/${row.id}`)).status).toBe(404);
  });

  it('projects the current name through both app replacements without N+1 reads', async () => {
    ws.write(
      'node_modules/@fixture/a2-upstream/src/models.ts',
      upstreamSource
        .replace(
          "@smrt({ tableName: 'a2_customers',",
          "@smrt({ display: { label: { via: 'profileId', field: 'title', fallback: 'Unnamed customer' } }, tableName: 'a2_customers',",
        )
        .replace("profileId = '';", "@foreignKey('Profile') profileId = '';"),
    );
    up = await scan(ws.path('node_modules/@fixture/a2-upstream'), UP);
    ws.write(
      'node_modules/@fixture/a2-upstream/dist/manifest.json',
      JSON.stringify(up),
    );
    clearManifestCache();
    app = await scan(ws.path('app'), APP, [UP]);
    merged = annotateModelReplacements({
      ...app,
      objects: { ...up.objects, ...app.objects },
    });
    const models = runtime(up, merged);
    db = await getTestDatabase({
      type: databaseType,
      url: databaseUrl,
      includeSystemTables: false,
      classes: [],
    });
    await migrate(merged);
    const profiles = await ObjectRegistry.getCollection(`${UP}:Profile`, {
      db,
    });
    const customers = await ObjectRegistry.getCollection(`${UP}:Customer`, {
      db,
    });
    // REST without a selector creates through the effective STI root. Collection
    // create also supports explicit provider subtypes after app replacement.
    const api = new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (req) => req },
      { db, user: { id: 'owner' }, permissions: ['profiles.create'] },
    );
    api.registerCollection('profiles', profiles);
    api.registerCollection('customers', customers);
    const handler = api.generateHandler();
    const created = await handler(
      new Request('http://fixture/api/profiles', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'STI name',
          firstName: 'Person',
        }),
      }),
    );
    expect(created.status).toBe(201);
    const restProfile = (await created.json()) as { id: string };
    expect((await profiles.get(restProfile.id))?.constructor).toBe(
      models.AppProfile,
    );
    const person = await profiles.create({
      _meta_type: `${UP}:Person`,
      title: 'STI name',
    });
    await customers.create({ profileId: person.id, favoritePose: 'STI' });
    const subtypeRows = await customers.list({
      where: { displayLabel: 'STI name' },
    });
    expect(subtypeRows[0].toPublicJSON()).toMatchObject({
      displayLabel: 'STI name',
    });
    expect((await subtypeRows[0].loadRelated('profileId'))?.constructor).toBe(
      models.Person,
    );
    const profile = await profiles.create({ title: 'Maya', badge: 'app' });
    await customers.create({ profileId: profile.id, favoritePose: 'tree' });
    const rows = await customers.list({
      where: { 'displayLabel like': '%aya%' },
      orderBy: 'displayLabel ASC',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBeInstanceOf(models.AppCustomer);
    expect(rows[0].toPublicJSON()).toMatchObject({
      displayLabel: 'Maya',
      favoritePose: 'tree',
    });
    expect(await rows[0].loadRelated('profileId')).toBeInstanceOf(
      models.AppProfile,
    );
    const catalog = {
      models: [
        {
          id: `${UP}:Customer`,
          name: 'Customer',
          packageId: 'a2-upstream',
          exposed: true,
        },
      ],
      recipes: [],
    };
    const engine = createCookbookEngine({ catalog });
    engine.run({ name: 'add_features', input: { ids: [`${UP}:Customer`] } });
    const gate = createCookbookRuntimeExposure({
      catalog,
      engineFor: () => engine,
      allowWithoutTenant: true,
    });
    setRuntimeExposureGate(gate);
    try {
      const response = await handler(
        new Request(
          'http://fixture/api/customers?displayLabel[like]=%25aya%25',
        ),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject([{ displayLabel: 'Maya' }]);
    } finally {
      gate.dispose();
    }
  });

  it('generates one canonical REST/web/MCP surface and retains ancestry provenance', async () => {
    runtime(up, app);
    await generateSvelteKitRoutes(ws.path('app'), merged, {
      enabled: true,
      routesDir: 'src/routes/api',
      objectsDir: 'src',
      rejectRouteCollisions: true,
    });
    const route = readFileSync(
      ws.path('app/src/routes/api/customers/+server.ts'),
      'utf8',
    );
    expect(route).toContain(`${APP}:Customer`);
    expect(
      selectWebCollectionEntries(merged).filter(
        (entry) => entry.obj.className === 'Customer',
      ),
    ).toHaveLength(1);
    expect(
      buildWebMcpToolDefinitions(merged).filter(
        (tool) => tool.name === 'customer_list',
      ),
    ).toHaveLength(1);
    const knowledge = buildDomainKnowledgeManifest({
      manifest: merged,
      packageJson: { name: APP },
      rootDir: ws.path('app'),
    });
    expect(
      knowledge.objects.filter((entry) => entry.name === 'Customer'),
    ).toHaveLength(1);
    const mcp = new MCPGenerator({ name: 'fixture', version: '1' });
    const tools = await mcp.generateTools();
    expect(
      tools.filter((tool) => tool.name === 'customer_create'),
    ).toHaveLength(1);
    expect(
      tools.find((tool) => tool.name === 'customer_create')?.inputSchema
        .properties,
    ).toHaveProperty('favoritePose');
  });

  for (const order of ['app-first', 'upstream-first'] as const) {
    it(`retains declared bases with manifest-only registration (${order})`, () => {
      const manifests = order === 'app-first' ? [app, up] : [up, app];
      for (const manifest of manifests) {
        for (const [key, entry] of Object.entries(manifest.objects)) {
          ObjectRegistry.registerFromManifest(key, entry, manifest.packageName);
        }
      }
      expect(ObjectRegistry.getClass(`${UP}:Profile`)?.qualifiedName).toBe(
        `${APP}:Profile`,
      );
      expect(
        ObjectRegistry.getClassByQualifiedName(`${UP}:Profile`),
      ).toBeUndefined();
      expect(ObjectRegistry.getInheritanceChain(`${UP}:Person`)).toEqual([
        `${UP}:Profile`,
        `${UP}:Person`,
      ]);
      expect(ObjectRegistry.getInheritanceChain(`${APP}:Profile`)).toEqual([
        `${UP}:Profile`,
        `${APP}:Profile`,
      ]);
      expect(ObjectRegistry.getInheritanceChain(`${UP}:Leaf`)).toEqual([
        `${UP}:Base`,
        `${UP}:Leaf`,
      ]);
    });
  }

  it('removes upstream registrations from exact lookups while resolving runtime identities', () => {
    const f = runtime(up, app);
    const provider = `${UP}:Customer`;
    const effective = `${APP}:Customer`;
    expect(ObjectRegistry.getClassByQualifiedName(provider)).toBeUndefined();
    expect(ObjectRegistry.getClassInPackage(UP, 'Customer')).toBeUndefined();
    expect(ObjectRegistry.getAllClasses().has(provider)).toBe(false);
    expect(ObjectRegistry.getClassByQualifiedName(effective)?.constructor).toBe(
      f.AppCustomer,
    );
    expect(ObjectRegistry.getClass(provider)?.constructor).toBe(f.AppCustomer);
    expect(ObjectRegistry.resolveType(provider)).toBe(effective);
    expect(ObjectRegistry.resolveQualifiedName(provider)).toBe(effective);
  });

  it('keeps an app without replacements unchanged and an empty replacement schema identical', async () => {
    const f = runtime(up);
    expect(
      ObjectRegistry.getClassByQualifiedName(`${UP}:Customer`)?.constructor,
    ).toBe(f.Customer);
    expect(annotateModelReplacements(up)).toEqual(up);
    ws.write('app/src/models.ts', appSource(false));
    const empty = await scan(ws.path('app'), APP, [UP]);
    expect(empty.objects[`${APP}:Customer`].schema?.columns).toEqual(
      up.objects[`${UP}:Customer`].schema?.columns,
    );
    expect(
      selectWebCollectionEntries(up).filter(
        (entry) => entry.obj.className === 'Customer',
      ),
    ).toHaveLength(1);
  });
});
