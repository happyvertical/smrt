/** #4869/A2: installed package declarations, effective app identities, SQLite I/O. */
import { readFileSync } from 'node:fs';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import { foreignKey } from '../decorators';
import { MCPGenerator } from '../generators/mcp';
import { APIGenerator } from '../generators/rest';
import { buildDomainKnowledgeManifest } from '../knowledge';
import { annotateModelReplacements } from '../manifest/model-replacements';
import { generateSchemaDiff } from '../migrations/differ';
import { collectStatementsFromDiff } from '../migrations/orchestrate';
import { SmrtObject } from '../object';
import { ObjectRegistry } from '../registry';
import { createConsumerWorkspace } from '../registry/__tests__/helpers/consumer-workspace';
import { ManifestGenerator } from '../scanner/manifest-generator';
import type { SmartObjectManifest } from '../scanner/types';
import { SchemaAggregator } from '../schema/schema-aggregator';
import { snapshotObjectRegistryState } from '../test-utils';
import { generateSvelteKitRoutes } from '../vite-plugin/sveltekit-generator';
import {
  buildWebMcpToolDefinitions,
  selectWebCollectionEntries,
} from '../vite-plugin/web-collections';

const UP = '@fixture/a2-upstream';
const APP = '@fixture/a2-app';
const upstreamSource = `import { smrt, SmrtObject, foreignKey } from '@happyvertical/smrt-core';
@smrt({ tableName: 'a2_customers', previousQualifiedNames: ['@fixture/a2-old:Customer'], api: { public: true }, cli: true, mcp: true })
export class Customer extends SmrtObject { tenantId = ''; profileId = ''; title = ''; greeting() { return 'upstream'; } }
@smrt({ tableName: 'a2_invoices', api: { public: true } })
export class Invoice extends SmrtObject { @foreignKey(Customer) customerId = ''; }
@smrt({ tableName: 'a2_profiles', tableStrategy: 'sti' })
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
export class AppCustomer extends CustomerBase { ${custom ? "favoritePose = '';" : ''} greeting() { return 'app'; } }
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
    dialect: 'sqlite',
  });
  return Object.fromEntries(
    [...aggregate.tables].map(([name, table]) => [name, table.definition]),
  );
}
async function migrate(manifest: SmartObjectManifest) {
  if (!db) throw new Error('SQLite fixture not initialized');
  const diff = await generateSchemaDiff(db, schemas(manifest), {
    engineHint: 'sqlite',
  });
  const statements = collectStatementsFromDiff(diff, db, 'sqlite');
  for (const sql of statements) await db.query(sql);
  return statements;
}

describe('same-name app subclass', () => {
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

  it('dispatches shared STI creates to the app root even with children first', async () => {
    const f = runtime(up, app);
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
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

  it('keeps declared STI and CTI bases while resolving I/O to the app constructor', async () => {
    const f = runtime(up, app);
    expect(
      ObjectRegistry.getClassByQualifiedName(`${UP}:Customer`)?.constructor,
    ).toBe(f.AppCustomer);
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
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await migrate(merged);
    const customers = await f.Customers.create({ db });
    expect(customers.getItemClass()).toBe(f.AppCustomer);
    const customer = await customers.create({
      title: 'Maya',
      tenantId: 'tenant',
      profileId: 'profile',
      favoritePose: 'tree',
    });
    expect(customer).toBeInstanceOf(f.AppCustomer);
    expect(customer.greeting()).toBe('app');
    expect((await customers.get(customer.id!))?.toJSON()).toMatchObject({
      favoritePose: 'tree',
      tenantId: 'tenant',
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

  it('migrates a custom column onto the existing upstream table and serves REST CRUD', async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    await migrate(up);
    runtime(up, app);
    const statements = await migrate(merged);
    expect(statements.join('\n')).toMatch(
      /ALTER TABLE.*a2_customers.*ADD COLUMN.*favorite_pose/,
    );
    expect(statements.join('\n')).not.toContain('CREATE TABLE');
    expect(await migrate(merged)).toEqual([]);
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
      tenantId: 'tenant',
      profileId: 'profile',
    });
    expect(created.status).toBe(201);
    const row = (await created.json()) as { id: string; favoritePose: string };
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
      expect(
        ObjectRegistry.getClassByQualifiedName(`${UP}:Profile`)?.qualifiedName,
      ).toBe(`${APP}:Profile`);
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
