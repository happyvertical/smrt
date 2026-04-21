import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { field } from '../decorators/index.js';
import type { ConfigurationError } from '../errors.js';
import { clearManifestCache } from '../manifest/manifest-loader.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';
import { createQualifiedName } from '../utils/qualified-names.js';

function writeScopedPackage(
  appDir: string,
  packageName: string,
  manifest: Record<string, unknown>,
): void {
  const [, scope, pkg] = packageName.match(/^@([^/]+)\/(.+)$/) || [];
  const packageDir = join(appDir, 'node_modules', `@${scope}`, pkg);

  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify(
      {
        name: packageName,
        version: '1.0.0',
        type: 'module',
        exports: {
          './manifest.json': './dist/manifest.json',
          './manifest': './dist/manifest.json',
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(packageDir, 'dist', 'manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
}

function fixtureManifest(
  packageName: string,
  objects: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const qualifiedObjects = Object.fromEntries(
    Object.entries(objects).map(([className, objectDef]) => [
      `${packageName}:${className}`,
      {
        className,
        ...objectDef,
      },
    ]),
  );

  return {
    version: '1.0.0',
    timestamp: Date.now(),
    moduleType: 'smrt',
    packageName,
    objects: qualifiedObjects,
  };
}

function stripPackageIdentity(...classNames: string[]): void {
  for (const className of classNames) {
    const registered = ObjectRegistry.findClass(className);
    if (!registered) {
      continue;
    }

    registered.packageName = undefined;
    registered.qualifiedName = undefined;
  }

  ObjectRegistry.invalidateAllInheritanceCaches();
}

describe('external runtime field hydration', () => {
  const originalCwd = process.cwd();
  let restoreRegistry: () => void;
  let tempRoot = '';
  let appDir = '';

  beforeAll(() => {
    restoreRegistry = snapshotObjectRegistryState();
  });

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'smrt-runtime-hydration-'));
    appDir = join(tempRoot, 'app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: 'runtime-hydration-app', version: '1.0.0' }),
    );
    process.chdir(appDir);
    ObjectRegistry.clear();
    clearManifestCache();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    ObjectRegistry.clear();
    clearManifestCache();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  afterAll(() => {
    restoreRegistry();
    clearManifestCache();
  });

  it('hydrates sparse registered fields from installed manifests when package identity is missing', async () => {
    const packageName = '@happyvertical/smrt-runtime-fixture-email';

    writeScopedPackage(
      appDir,
      packageName,
      fixtureManifest(packageName, {
        FixtureAccount: {
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'fixture_accounts',
            tenantScoped: true,
            api: false,
            cli: false,
            mcp: false,
          },
          fields: {
            tenantId: {
              type: 'text',
              required: false,
              _meta: {
                __tenancy: {
                  isTenantIdField: true,
                  mode: 'required',
                  field: 'tenantId',
                  autoFilter: true,
                  autoPopulate: true,
                  allowSuperAdminBypass: false,
                },
              },
            },
            name: { type: 'text' },
            providerType: { type: 'text' },
          },
        },
        FixtureEmailAccount: {
          extends: 'FixtureAccount',
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'fixture_accounts',
            api: false,
            cli: false,
            mcp: false,
          },
          fields: {
            email: { type: 'text' },
            isActive: { type: 'boolean' },
          },
        },
      }),
    );

    @smrt({
      tableStrategy: 'sti',
      tableName: 'fixture_accounts',
      tenantScoped: true,
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureAccount extends SmrtObject {}

    @smrt({
      tableStrategy: 'sti',
      tableName: 'fixture_accounts',
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureEmailAccount extends FixtureAccount {}

    stripPackageIdentity('FixtureAccount', 'FixtureEmailAccount');

    const fields = await ObjectRegistry.getAllFields('FixtureEmailAccount');

    expect(fields.has('tenantId')).toBe(true);
    expect(fields.has('name')).toBe(true);
    expect(fields.has('providerType')).toBe(true);
    expect(fields.has('isActive')).toBe(true);
    expect(fields.has('email')).toBe(true);

    const db = await getTestDatabase({
      classes: ['FixtureAccount', 'FixtureEmailAccount'],
    });
    const collection = await ObjectRegistry.getCollection(
      'FixtureEmailAccount',
      {
        db,
      },
    );

    await expect(
      collection.list({
        where: { isActive: true, email: 'alerts@example.com' },
      }),
    ).resolves.toEqual([]);
  });

  it('auto-loads unregistered external classes by qualified name', async () => {
    const packageName = '@happyvertical/smrt-runtime-fixture-event-types';
    const qualifiedClassName = createQualifiedName(
      packageName,
      'FixtureRuntimeEventType',
    );

    writeScopedPackage(
      appDir,
      packageName,
      fixtureManifest(packageName, {
        FixtureRuntimeEventType: {
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'fixture_runtime_event_types',
            api: false,
            cli: false,
            mcp: false,
          },
          fields: {
            label: { type: 'text' },
            priority: { type: 'number' },
          },
        },
      }),
    );

    await ObjectRegistry.ensureManifestLoaded(qualifiedClassName);

    const registered =
      ObjectRegistry.getClassByQualifiedName(qualifiedClassName);
    expect(registered).toBeDefined();
    expect(registered?.name).toBe('FixtureRuntimeEventType');
    expect(ObjectRegistry.getFields(qualifiedClassName).has('label')).toBe(
      true,
    );
    expect(ObjectRegistry.getFields(qualifiedClassName).has('priority')).toBe(
      true,
    );
  });

  it('hydrates manifest metadata even when runtime field counts and types already match', async () => {
    const packageName = '@happyvertical/smrt-runtime-fixture-metadata';

    writeScopedPackage(
      appDir,
      packageName,
      fixtureManifest(packageName, {
        FixtureMetadataAccount: {
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'fixture_metadata_accounts',
            api: false,
            cli: false,
            mcp: false,
          },
          fields: {
            status: {
              type: 'text',
              required: true,
              default: 'active',
              description: 'Current delivery status',
            },
          },
        },
      }),
    );

    @smrt({
      tableStrategy: 'sti',
      tableName: 'fixture_metadata_accounts',
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureMetadataAccount extends SmrtObject {
      @field()
      status: string = '';
    }

    const registered = ObjectRegistry.findClass('FixtureMetadataAccount');
    expect(registered).toBeDefined();
    registered!.packageName = packageName;
    registered!.qualifiedName = createQualifiedName(
      packageName,
      'FixtureMetadataAccount',
    );
    registered!.inheritedFields = new Map(registered?.fields);

    await ObjectRegistry.ensureManifestLoaded('FixtureMetadataAccount');

    const hydratedField = ObjectRegistry.getFields(
      'FixtureMetadataAccount',
    ).get('status');
    expect(hydratedField?._meta?.required).toBe(true);
    expect(hydratedField?._meta?.default).toBe('active');
    expect(hydratedField?._meta?.description).toBe('Current delivery status');
  });

  it('preserves existing field metadata when fallback manifest hydration only refines adjacent properties', async () => {
    const packageName = '@happyvertical/smrt-runtime-fixture-fallback-metadata';

    writeScopedPackage(
      appDir,
      packageName,
      fixtureManifest(packageName, {
        FixtureFallbackMetadataAccount: {
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'fixture_fallback_metadata_accounts',
            api: false,
            cli: false,
            mcp: false,
          },
          fields: {
            status: {
              type: 'text',
              _meta: {
                default: 'active',
                description: 'Fallback hydrated status',
              },
            },
          },
        },
      }),
    );

    @smrt({
      tableStrategy: 'sti',
      tableName: 'fixture_fallback_metadata_accounts',
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureFallbackMetadataAccount extends SmrtObject {
      @field({ required: true })
      status: string = '';
    }

    stripPackageIdentity('FixtureFallbackMetadataAccount');

    const fields = await ObjectRegistry.getAllFields(
      'FixtureFallbackMetadataAccount',
    );
    const hydratedField = fields.get('status');

    expect(hydratedField?._meta?.required).toBe(true);
    expect(hydratedField?._meta?.default).toBe('active');
    expect(hydratedField?._meta?.description).toBe('Fallback hydrated status');
  });

  it('hydrates feature decorator metadata from installed manifests', async () => {
    const packageName = '@happyvertical/smrt-runtime-fixture-features';

    writeScopedPackage(
      appDir,
      packageName,
      fixtureManifest(packageName, {
        FixtureFeaturefulAccount: {
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'fixture_featureful_accounts',
            api: false,
            cli: false,
            mcp: false,
            features: {
              newEditor: {
                defaultEnabled: false,
                label: 'New Editor',
                description: 'Gradual editor rollout',
                metadata: {
                  audience: 'staff',
                },
              },
            },
          },
          fields: {
            name: { type: 'text' },
          },
        },
      }),
    );

    @smrt({
      tableStrategy: 'sti',
      tableName: 'fixture_featureful_accounts',
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureFeaturefulAccount extends SmrtObject {
      @field()
      name: string = '';
    }

    stripPackageIdentity('FixtureFeaturefulAccount');

    await ObjectRegistry.ensureManifestLoaded('FixtureFeaturefulAccount');

    expect(
      ObjectRegistry.getConfig('FixtureFeaturefulAccount').features,
    ).toEqual({
      newEditor: {
        defaultEnabled: false,
        label: 'New Editor',
        description: 'Gradual editor rollout',
        metadata: {
          audience: 'staff',
        },
      },
    });
  });

  it('includes parent manifest fields when a local STI class extends a sparse external parent', async () => {
    const packageName = '@happyvertical/smrt-runtime-fixture-analytics';

    writeScopedPackage(
      appDir,
      packageName,
      fixtureManifest(packageName, {
        FixtureAnalyticsProperty: {
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'fixture_analytics_properties',
            api: false,
            cli: false,
            mcp: false,
          },
          fields: {
            provider: { type: 'text' },
            externalId: { type: 'text' },
            measurementId: { type: 'text' },
            siteDomain: { type: 'text' },
          },
        },
      }),
    );

    @smrt({
      tableStrategy: 'sti',
      tableName: 'fixture_analytics_properties',
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureAnalyticsProperty extends SmrtObject {}

    @smrt({
      tableStrategy: 'sti',
      tableName: 'fixture_analytics_properties',
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureNetworkAnalyticsProperty extends FixtureAnalyticsProperty {
      @field()
      publicationId: string = '';
    }

    stripPackageIdentity(
      'FixtureAnalyticsProperty',
      'FixtureNetworkAnalyticsProperty',
    );

    const fields = await ObjectRegistry.getAllFields(
      'FixtureNetworkAnalyticsProperty',
    );

    expect(fields.has('publicationId')).toBe(true);
    expect(fields.has('provider')).toBe(true);
    expect(fields.has('externalId')).toBe(true);
    expect(fields.has('measurementId')).toBe(true);
    expect(fields.has('siteDomain')).toBe(true);

    const db = await getTestDatabase({
      classes: ['FixtureAnalyticsProperty', 'FixtureNetworkAnalyticsProperty'],
    });
    const collection = await ObjectRegistry.getCollection(
      'FixtureNetworkAnalyticsProperty',
      { db },
    );

    await expect(
      collection.list({
        where: { externalId: 'properties/123', publicationId: 'pub-1' },
      }),
    ).resolves.toEqual([]);
  });

  it('merges manifest schema into an already-registered external class with the same qualified key', () => {
    const packageName = '@happyvertical/smrt-runtime-fixture-recaps';
    const registrationKey = createQualifiedName(
      packageName,
      'FixtureRuntimeMeetingRecap',
    );

    @smrt({
      packageName,
      tableStrategy: 'sti',
      tableName: 'fixture_runtime_contents',
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureRuntimeContent extends SmrtObject {}

    @smrt({
      packageName,
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureRuntimeMeetingRecap extends FixtureRuntimeContent {
      @field()
      meetingId: string = '';
    }

    const before = ObjectRegistry.findClass(registrationKey);
    expect(before).toBeDefined();
    expect(before?.schema?.tableName).toBe('fixture_runtime_contents');
    expect(before?.fields.has('meetingId')).toBe(true);
    expect(before?.fields.has('councilId')).toBe(false);
    expect(before?.fields.has('body')).toBe(false);

    const beforeDefinitions = ObjectRegistry.getAllSchemasAsDefinitions();
    expect(
      beforeDefinitions.fixture_runtime_contents.columns.meeting_id,
    ).toBeDefined();
    expect(
      beforeDefinitions.fixture_runtime_contents.columns.council_id,
    ).toBeUndefined();
    expect(
      beforeDefinitions.fixture_runtime_contents.columns.body,
    ).toBeUndefined();

    ObjectRegistry.registerFromManifest(
      'FixtureRuntimeMeetingRecap',
      {
        className: 'FixtureRuntimeMeetingRecap',
        extends: 'FixtureRuntimeContent',
        decoratorConfig: {
          tableStrategy: 'sti',
          tableName: 'fixture_runtime_contents',
          api: false,
          cli: false,
          mcp: false,
        },
        fields: {
          meetingId: { type: 'text' },
          councilId: { type: 'text' },
          body: { type: 'text' },
        },
        schema: {
          tableName: 'fixture_runtime_contents',
          ddl: `CREATE TABLE IF NOT EXISTS "fixture_runtime_contents" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "updated_at" TIMESTAMP NOT NULL DEFAULT current_timestamp,
  "_meta_type" TEXT NOT NULL DEFAULT '',
  "_meta_data" JSON,
  "meeting_id" TEXT DEFAULT '',
  "council_id" TEXT DEFAULT '',
  "body" TEXT DEFAULT ''
);`,
          columns: {
            meeting_id: { type: 'TEXT', defaultValue: '' },
            council_id: { type: 'TEXT', defaultValue: '' },
            body: { type: 'TEXT', defaultValue: '' },
          },
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      },
      packageName,
    );

    const after = ObjectRegistry.findClass(registrationKey);
    expect(after).toBeDefined();
    expect(after?.schema?.tableName).toBe('fixture_runtime_contents');
    expect(after?.qualifiedName).toBe(registrationKey);
    expect(after?.fields.has('meetingId')).toBe(true);
    expect(after?.fields.has('councilId')).toBe(true);
    expect(after?.fields.has('body')).toBe(true);

    const definitions = ObjectRegistry.getAllSchemasAsDefinitions();
    expect(definitions.fixture_runtime_contents).toBeDefined();
    expect(
      definitions.fixture_runtime_contents.columns.meeting_id,
    ).toBeDefined();
    expect(
      definitions.fixture_runtime_contents.columns.council_id,
    ).toBeDefined();
    expect(definitions.fixture_runtime_contents.columns.body).toBeDefined();
    expect(definitions.fixture_runtime_meeting_recaps).toBeUndefined();
  });

  it('preserves existing validation rules when a later manifest merge omits them', () => {
    const packageName = '@happyvertical/smrt-runtime-fixture-validation';
    const registrationKey = createQualifiedName(
      packageName,
      'FixtureRuntimeValidated',
    );

    @smrt({
      packageName,
      tableStrategy: 'sti',
      tableName: 'fixture_runtime_validated',
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureRuntimeValidated extends SmrtObject {
      @field()
      status: string = '';
    }

    const registered = ObjectRegistry.findClass(registrationKey);
    expect(registered).toBeDefined();
    const existingRules = [{ type: 'required', field: 'status' }] as any;
    if (!registered) {
      throw new Error('Expected FixtureRuntimeValidated to be registered');
    }
    registered.validationRules = existingRules;
    registered.validators = undefined;

    ObjectRegistry.registerFromManifest(
      'FixtureRuntimeValidated',
      {
        className: 'FixtureRuntimeValidated',
        decoratorConfig: {
          tableStrategy: 'sti',
          tableName: 'fixture_runtime_validated',
          api: false,
          cli: false,
          mcp: false,
        },
        fields: {
          status: { type: 'text' },
          category: { type: 'text' },
        },
      },
      packageName,
    );

    const after = ObjectRegistry.findClass(registrationKey);
    expect(after?.validationRules).toBe(existingRules);
    expect(after?.validators).toBeUndefined();
    expect(after?.fields.has('category')).toBe(true);
  });

  it('does not merge an unqualified manifest into an already-qualified runtime class', () => {
    const packageName = '@happyvertical/smrt-runtime-fixture-guard';
    const registrationKey = createQualifiedName(
      packageName,
      'FixtureRuntimeGuarded',
    );

    @smrt({
      packageName,
      tableStrategy: 'sti',
      tableName: 'fixture_runtime_guarded',
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureRuntimeGuarded extends SmrtObject {
      @field()
      status: string = '';
    }

    const before = ObjectRegistry.findClass(registrationKey);
    expect(before).toBeDefined();
    expect(before?.fields.has('unexpectedField')).toBe(false);

    ObjectRegistry.registerFromManifest('FixtureRuntimeGuarded', {
      className: 'FixtureRuntimeGuarded',
      fields: {
        unexpectedField: { type: 'text' },
      },
      decoratorConfig: {
        tableStrategy: 'sti',
        tableName: 'wrong_table_name',
      },
      schema: {
        tableName: 'wrong_table_name',
        ddl: '',
        columns: {
          unexpected_field: { type: 'TEXT' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    });

    const after = ObjectRegistry.findClass(registrationKey);
    expect(after?.fields.has('unexpectedField')).toBe(false);
    expect(after?.schema?.tableName).toBe('fixture_runtime_guarded');
  });

  it('hydrates STI sibling field types before save so missing booleans do not serialize as empty strings', async () => {
    const packageName = '@happyvertical/smrt-runtime-fixture-events';

    writeScopedPackage(
      appDir,
      packageName,
      fixtureManifest(packageName, {
        FixtureEvent: {
          collection: 'fixture_events',
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'fixture_events',
            api: false,
            cli: false,
            mcp: false,
          },
          fields: {},
        },
        FixtureSeason: {
          extends: 'FixtureEvent',
          collection: 'fixture_events',
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'fixture_events',
            api: false,
            cli: false,
            mcp: false,
          },
          fields: {
            isActive: { type: 'boolean' },
          },
        },
        FixtureForecast: {
          extends: 'FixtureEvent',
          collection: 'fixture_events',
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'fixture_events',
            api: false,
            cli: false,
            mcp: false,
          },
          fields: {
            temperature: { type: 'number' },
          },
        },
      }),
    );

    @smrt({
      tableStrategy: 'sti',
      tableName: 'fixture_events',
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureEvent extends SmrtObject {}

    @smrt({
      tableStrategy: 'sti',
      tableName: 'fixture_events',
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureSeason extends FixtureEvent {
      @field()
      isActive: boolean = false;
    }

    @smrt({
      tableStrategy: 'sti',
      tableName: 'fixture_events',
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureForecast extends FixtureEvent {
      @field()
      temperature: number = 10;
    }

    stripPackageIdentity('FixtureEvent', 'FixtureSeason', 'FixtureForecast');

    expect(
      ObjectRegistry.getFields('FixtureSeason').get('isActive')?.type,
    ).toBe('text');

    const upserts: Array<Record<string, unknown>> = [];
    const db = {
      url: ':memory:',
      tableExists: async () => true,
      get: async () => null,
      upsert: async (
        _tableName: string,
        _conflictColumns: string[],
        data: Record<string, unknown>,
      ) => {
        upserts.push(data);
      },
    };

    const forecast = await new FixtureForecast({ db: db as any }).initialize();
    (forecast as any)._db = db;
    (forecast as any).verifyStorageReady = async () => {};
    await forecast.save();

    expect(upserts).toHaveLength(1);
    expect(upserts[0]?._meta_type).toBeTruthy();
    expect(upserts[0]?.temperature).toBe(10);
    expect(
      ObjectRegistry.getFields('FixtureSeason').get('isActive')?.type,
    ).toBe('boolean');
    expect(upserts[0]?.is_active).toBeUndefined();
  });

  it('rejects ambiguous external-package fallback when multiple manifests define the same simple class name', async () => {
    writeScopedPackage(
      appDir,
      '@happyvertical/smrt-runtime-fixture-shared-a',
      fixtureManifest('@happyvertical/smrt-runtime-fixture-shared-a', {
        FixtureSharedThing: {
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'fixture_shared_things',
            api: false,
            cli: false,
            mcp: false,
          },
          fields: {
            source: { type: 'text', default: 'a' },
          },
        },
      }),
    );

    writeScopedPackage(
      appDir,
      '@happyvertical/smrt-runtime-fixture-shared-b',
      fixtureManifest('@happyvertical/smrt-runtime-fixture-shared-b', {
        FixtureSharedThing: {
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'fixture_shared_things',
            api: false,
            cli: false,
            mcp: false,
          },
          fields: {
            source: { type: 'text', default: 'b' },
          },
        },
      }),
    );

    @smrt({
      tableStrategy: 'sti',
      tableName: 'fixture_shared_things',
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureSharedThing extends SmrtObject {}

    stripPackageIdentity('FixtureSharedThing');

    await expect(
      ObjectRegistry.getAllFields('FixtureSharedThing'),
    ).rejects.toMatchObject<Partial<ConfigurationError>>({
      code: 'CONFIG_AMBIGUOUS_CLASS',
    });
  });

  it('creates STI child rows with the hydrated qualified discriminator after manifest loading', async () => {
    const packageName = '@happyvertical/smrt-runtime-fixture-accounts';

    writeScopedPackage(
      appDir,
      packageName,
      fixtureManifest(packageName, {
        FixtureAccount: {
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'fixture_accounts',
            api: false,
            cli: false,
            mcp: false,
          },
          fields: {
            name: { type: 'text' },
          },
        },
        FixtureEmailAccount: {
          extends: 'FixtureAccount',
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'fixture_accounts',
            api: false,
            cli: false,
            mcp: false,
          },
          fields: {
            email: { type: 'text' },
          },
        },
      }),
    );

    @smrt({
      tableStrategy: 'sti',
      tableName: 'fixture_accounts',
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureAccount extends SmrtObject {}

    @smrt({
      tableStrategy: 'sti',
      tableName: 'fixture_accounts',
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureEmailAccount extends FixtureAccount {}

    stripPackageIdentity('FixtureAccount', 'FixtureEmailAccount');

    const db = await getTestDatabase({
      classes: ['FixtureAccount', 'FixtureEmailAccount'],
    });
    const collection = await ObjectRegistry.getCollection(
      'FixtureEmailAccount',
      { db },
    );

    const created = await collection.create({
      name: 'Alerts',
      email: 'alerts@example.com',
    });

    expect((created as any)._meta_type).toBe(
      `${packageName}:FixtureEmailAccount`,
    );
    await expect(collection.count()).resolves.toBe(1);
  });

  it('hydrates STI rows whose child discriminator is only available from an installed manifest', async () => {
    const packageName = '@happyvertical/smrt-runtime-fixture-polymorphic';
    const childQualifiedName = createQualifiedName(
      packageName,
      'FixtureRuntimeMeeting',
    );

    writeScopedPackage(
      appDir,
      packageName,
      fixtureManifest(packageName, {
        FixtureRuntimeEvent: {
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'fixture_runtime_events',
            api: false,
            cli: false,
            mcp: false,
          },
          fields: {
            title: { type: 'text' },
          },
        },
        FixtureRuntimeMeeting: {
          extends: 'FixtureRuntimeEvent',
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'fixture_runtime_events',
            api: false,
            cli: false,
            mcp: false,
          },
          fields: {
            location: { type: 'text' },
          },
        },
      }),
    );

    @smrt({
      tableStrategy: 'sti',
      tableName: 'fixture_runtime_events',
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureRuntimeEvent extends SmrtObject {
      @field()
      title: string = '';
    }

    stripPackageIdentity('FixtureRuntimeEvent');

    const db = await getTestDatabase({
      classes: ['FixtureRuntimeEvent'],
    });

    await db.query(
      `INSERT INTO fixture_runtime_events (
        id,
        slug,
        context,
        created_at,
        updated_at,
        _meta_type,
        title
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'event-1',
      'event-1',
      '',
      '2026-04-11T20:00:00.000Z',
      '2026-04-11T20:00:00.000Z',
      childQualifiedName,
      'Budget meeting',
    );

    const collection = await ObjectRegistry.getCollection(
      'FixtureRuntimeEvent',
      {
        db,
      },
    );

    const items = await collection.list({});

    expect(items).toHaveLength(1);
    expect(items[0]?.constructor.name).toBe('FixtureRuntimeMeeting');
    expect((items[0] as any)._meta_type).toBe(childQualifiedName);
    expect(
      ObjectRegistry.getClassByQualifiedName(childQualifiedName),
    ).toBeDefined();
  });

  it('rehydrates stale STI descendant caches before serializing sibling integer fields on save', async () => {
    const packageName = '@happyvertical/smrt-runtime-fixture-assets';

    writeScopedPackage(
      appDir,
      packageName,
      fixtureManifest(packageName, {
        FixtureRuntimeAsset: {
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'fixture_runtime_assets',
            api: false,
            cli: false,
            mcp: false,
          },
          fields: {
            name: { type: 'text' },
            sourceType: { type: 'text' },
          },
        },
        FixtureRuntimeImage: {
          extends: 'FixtureRuntimeAsset',
          decoratorConfig: {
            tableStrategy: 'sti',
            tableName: 'fixture_runtime_assets',
            api: false,
            cli: false,
            mcp: false,
          },
          fields: {
            width: { type: 'integer', default: 0 },
            height: { type: 'integer', default: 0 },
            alt: { type: 'text', default: '' },
          },
        },
      }),
    );

    @smrt({
      tableStrategy: 'sti',
      tableName: 'fixture_runtime_assets',
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureRuntimeAsset extends SmrtObject {
      @field()
      name: string = '';

      @field()
      sourceType: string = '';
    }

    @smrt({
      tableStrategy: 'sti',
      tableName: 'fixture_runtime_assets',
      api: false,
      cli: false,
      mcp: false,
    })
    class FixtureRuntimeImage extends FixtureRuntimeAsset {
      @field()
      width: number = 0;

      @field()
      height: number = 0;

      @field()
      alt: string = '';
    }

    const baseRegistered = ObjectRegistry.findClass('FixtureRuntimeAsset');
    const imageRegistered = ObjectRegistry.findClass('FixtureRuntimeImage');

    expect(baseRegistered).toBeDefined();
    expect(imageRegistered).toBeDefined();

    baseRegistered!.packageName = packageName;
    baseRegistered!.qualifiedName = createQualifiedName(
      packageName,
      'FixtureRuntimeAsset',
    );

    imageRegistered!.packageName = packageName;
    imageRegistered!.qualifiedName = createQualifiedName(
      packageName,
      'FixtureRuntimeImage',
    );

    // Simulate the stale external-runtime cache we saw in production: the child
    // already has inheritedFields, but only from undecorated runtime metadata.
    imageRegistered!.inheritedFields = new Map(imageRegistered?.fields);

    const staleWidthField =
      imageRegistered?.inheritedFields.get('width')?.type || null;
    expect(staleWidthField).toBe('text');

    const upserts: Array<Record<string, unknown>> = [];
    const db = {
      url: ':memory:',
      tableExists: async () => true,
      get: async () => null,
      upsert: async (
        _tableName: string,
        _conflictColumns: string[],
        data: Record<string, unknown>,
      ) => {
        upserts.push(data);
      },
    };

    const asset = await new FixtureRuntimeAsset({
      db: db as any,
      name: 'Blackfalds agenda asset',
      sourceType: 'remote',
    }).initialize();
    (asset as any)._db = db;
    (asset as any).verifyStorageReady = async () => {};

    await asset.save();

    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.width).toBeUndefined();
    expect(upserts[0]?.height).toBeUndefined();
    expect(upserts[0]?.alt).toBe('');

    const hydratedWidthField =
      ObjectRegistry.getClass('FixtureRuntimeImage')?.inheritedFields?.get(
        'width',
      )?.type || null;
    expect(hydratedWidthField).toBe('integer');
  });
});
