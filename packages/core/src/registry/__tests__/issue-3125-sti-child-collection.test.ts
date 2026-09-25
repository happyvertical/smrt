/**
 * #3125: an STI subtype decorated before its manifest loads keeps the
 * collection the manifest gives it.
 *
 * In a consumer's production (bundled) SSR build the Vite plugin does not
 * inject `_manifest` at the decorator, and the app manifest registers only
 * after the model chunks have evaluated. An STI subtype there registered with
 * `collection = pluralize(className)` (`networks`) while its table was
 * correctly its STI base's (`tenants`), and the later manifest did not
 * reconcile `collection`. Permission slugs derived from `collection`
 * (`networks.update`) then named nothing the manifest-derived catalog lists,
 * and operation guards denied everyone.
 *
 * The workspace mirrors that shape: an installed dependency's STI base
 * (`Tenant`, with its own manifest registered first as a library dist does),
 * and the app's bundled server chunk declaring `Network extends Tenant`, with
 * the app manifest registered afterwards.
 */
import { pathToFileURL } from 'node:url';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { getManifestCache } from '../../manifest/store.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry, smrt } from '../../registry.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import {
  type ConsumerWorkspace,
  createConsumerWorkspace,
  manifestEntry,
} from './helpers/consumer-workspace.js';

type Deps = { smrt: typeof smrt; SmrtObject: typeof SmrtObject };
type Define = (deps: Deps, parent: typeof SmrtObject) => typeof SmrtObject;

async function defineFrom(
  file: string,
  parent: typeof SmrtObject = SmrtObject,
): Promise<typeof SmrtObject> {
  const module = (await import(
    /* @vite-ignore */ pathToFileURL(file).href
  )) as { define: Define };
  return module.define({ smrt, SmrtObject }, parent);
}

const registration = (ctor: typeof SmrtObject) =>
  ObjectRegistry.getClassByConstructor(ctor);

/** A fixture module declaring `class <name> extends <parent>`. */
function subclassModule(className: string, config: Record<string, unknown>) {
  return [
    'export function define({ smrt }, Parent) {',
    `  return smrt(${JSON.stringify(config)})(class ${className} extends Parent {});`,
    '}',
    '',
  ].join('\n');
}

/** The app manifest entry the scanner writes for an STI subtype of Tenant. */
function stiSubtypeEntry(className: string) {
  const entry = manifestEntry({
    className,
    packageName: '@fixture/app',
    filePath: `apps/app/src/models/${className}.ts`,
    tableName: 'tenants',
    fields: { slug: { type: 'text' } },
  });
  return {
    ...entry,
    extends: 'Tenant',
    collection: 'tenants',
    decoratorConfig: { tableStrategy: 'sti', tableName: 'tenants' },
  };
}

function appManifest(objects: Record<string, unknown>) {
  return {
    version: '1',
    timestamp: 0,
    packageName: '@fixture/app',
    objects,
  } as unknown as Parameters<typeof ObjectRegistry.registerPackageManifest>[0];
}

describe('#3125: STI subtype collection in a consumer production build', () => {
  let ws: ConsumerWorkspace;
  let previousCwd: string;
  let restoreRegistry: () => void;
  const chunk = (name: string) =>
    ws.path(`apps/app/build/server/chunks/${name}.js`);

  beforeAll(() => {
    ws = createConsumerWorkspace('smrt-3125-consumer');
    ws.writePackage('apps/app', '@fixture/app');
    ws.writePackage('node_modules/@fixture/users', '@fixture/users');
    ws.writeModel('node_modules/@fixture/users/dist/tenant.js', 'Tenant', {
      tableStrategy: 'sti',
    });
    ws.write(
      'apps/app/build/server/chunks/network.js',
      subclassModule('Network', { tableStrategy: 'sti' }),
    );
    // Implicit STI: no `tableStrategy` of its own, inherited from the base.
    ws.write(
      'apps/app/build/server/chunks/publication.js',
      subclassModule('Publication', {}),
    );
    ws.write(
      'apps/app/build/server/chunks/regional-network.js',
      subclassModule('RegionalNetwork', { tableStrategy: 'sti' }),
    );
    // A CTI subtype of a non-STI base keeps its own collection.
    ws.writeModel('apps/app/build/server/chunks/account.js', 'Account');
    ws.write(
      'apps/app/build/server/chunks/partner-account.js',
      subclassModule('PartnerAccount', {}),
    );
    // A dependency class that shares the STI base's simple name but is not
    // in Network's prototype chain.
    ws.writePackage('node_modules/@fixture/other', '@fixture/other');
    ws.writeModel('node_modules/@fixture/other/dist/tenant.js', 'Tenant', {
      tableStrategy: 'sti',
      tableName: 'other_tenants',
    });
    previousCwd = process.cwd();
    process.chdir(ws.path('apps/app'));
  });

  afterAll(() => {
    process.chdir(previousCwd);
    ws.dispose();
  });

  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();
  });

  afterEach(() => {
    restoreRegistry();
    for (const pkg of ['@fixture/app', '@fixture/users', '@fixture/other']) {
      getManifestCache().delete(pkg);
    }
  });

  const loadTenant = () =>
    defineFrom(ws.path('node_modules/@fixture/users/dist/tenant.js'));

  it("gives an STI subtype decorated with no manifest its base's collection", async () => {
    const Tenant = await loadTenant();
    const Network = await defineFrom(chunk('network'), Tenant);

    expect(registration(Tenant)?.collection).toBe('tenants');
    expect(registration(Network)?.qualifiedName).toBe('@fixture/app:Network');
    expect(registration(Network)?.config.tableName).toBe('tenants');
    expect(registration(Network)?.collection).toBe('tenants');
  });

  /** A library dist registers its manifest before its classes (#1132). */
  const registerUsersManifest = () =>
    ObjectRegistry.registerPackageManifest({
      version: '1',
      timestamp: 0,
      packageName: '@fixture/users',
      objects: {
        '@fixture/users:Tenant': {
          ...manifestEntry({
            className: 'Tenant',
            packageName: '@fixture/users',
            filePath: 'node_modules/@fixture/users/dist/tenant.js',
            tableName: 'tenants',
            fields: { name: { type: 'text' } },
          }),
          collection: 'workspaces',
          decoratorConfig: { tableStrategy: 'sti', tableName: 'tenants' },
        },
      },
    } as unknown as Parameters<
      typeof ObjectRegistry.registerPackageManifest
    >[0]);

  it("uses the base's manifest collection when the dependency manifest loaded first", async () => {
    registerUsersManifest();
    const Tenant = await loadTenant();
    const Network = await defineFrom(chunk('network'), Tenant);

    expect(registration(Tenant)?.collection).toBe('workspaces');
    expect(registration(Network)?.collection).toBe('workspaces');
  });

  it('inherits the collection for an implicit STI subtype and through an intermediate subtype', async () => {
    const Tenant = await loadTenant();
    const Publication = await defineFrom(chunk('publication'), Tenant);
    const Network = await defineFrom(chunk('network'), Tenant);
    const Regional = await defineFrom(chunk('regional-network'), Network);

    expect(registration(Publication)?.collection).toBe('tenants');
    expect(registration(Regional)?.config.tableName).toBe('tenants');
    expect(registration(Regional)?.collection).toBe('tenants');
  });

  it('keeps a CTI subtype on its own collection', async () => {
    const Account = await defineFrom(chunk('account'));
    const PartnerAccount = await defineFrom(chunk('partner-account'), Account);

    expect(registration(PartnerAccount)?.collection).toBe('partneraccounts');
  });

  it("resolves the base by constructor, not another package's same-named class", async () => {
    registerUsersManifest();
    const Tenant = await loadTenant();
    const OtherTenant = await defineFrom(
      ws.path('node_modules/@fixture/other/dist/tenant.js'),
    );
    const Network = await defineFrom(chunk('network'), OtherTenant);

    expect(registration(Tenant)?.collection).toBe('workspaces');
    expect(registration(OtherTenant)?.qualifiedName).toBe(
      '@fixture/other:Tenant',
    );
    expect(registration(Network)?.config.tableName).toBe('other_tenants');
    expect(registration(Network)?.collection).toBe('tenants');
  });

  it('keeps the base collection after the app manifest registers', async () => {
    const Tenant = await loadTenant();
    const Network = await defineFrom(chunk('network'), Tenant);

    ObjectRegistry.registerPackageManifest(
      appManifest({ '@fixture/app:Network': stiSubtypeEntry('Network') }),
    );

    expect(registration(Network)?.qualifiedName).toBe('@fixture/app:Network');
    expect(registration(Network)?.collection).toBe('tenants');
    expect(registration(Network)?.fields.has('slug')).toBe(true);
  });

  it("reconciles a registered class's collection from a manifest registered after it", async () => {
    const Account = await defineFrom(chunk('account'));
    expect(registration(Account)?.collection).toBe('accounts');

    ObjectRegistry.registerPackageManifest(
      appManifest({
        '@fixture/app:Account': {
          ...manifestEntry({
            className: 'Account',
            packageName: '@fixture/app',
            filePath: 'apps/app/src/models/Account.ts',
            tableName: 'accounts',
            fields: { email: { type: 'text' } },
          }),
          collection: 'member_accounts',
        },
      }),
    );

    expect(registration(Account)?.qualifiedName).toBe('@fixture/app:Account');
    expect(registration(Account)?.collection).toBe('member_accounts');
  });

  it("does not take another package's manifest collection", async () => {
    const Tenant = await loadTenant();
    const Network = await defineFrom(chunk('network'), Tenant);

    ObjectRegistry.registerPackageManifest({
      version: '1',
      timestamp: 0,
      packageName: '@fixture/other',
      objects: {
        '@fixture/other:Network': {
          ...manifestEntry({
            className: 'Network',
            packageName: '@fixture/other',
            filePath: 'node_modules/@fixture/other/dist/network.js',
            tableName: 'other_networks',
            fields: {},
          }),
          collection: 'other_networks',
        },
      },
    } as unknown as Parameters<
      typeof ObjectRegistry.registerPackageManifest
    >[0]);

    expect(registration(Network)?.qualifiedName).toBe('@fixture/app:Network');
    expect(registration(Network)?.collection).toBe('tenants');
  });
});
