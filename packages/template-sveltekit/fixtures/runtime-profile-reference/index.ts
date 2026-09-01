/**
 * Reusable test-only runtime-profile reference workload.
 *
 * Every helper begins with a copy of the published template, overlays one
 * representative application object, and uses generated manifest artifacts as
 * the schema source. M5 follow-on tests import this module rather than
 * reconstructing app state with mocks or private registry reach-ins.
 */

import {
  cpSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  initializeLocalApplicationRuntime,
  type LocalApplicationRuntime,
} from '@happyvertical/smrt-app-runtime';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  type SmartObjectManifest,
  ManifestGenerator,
} from '@happyvertical/smrt-core/scanner';
import {
  collectManifestTables,
  renderCollectedManifestTable,
} from '@happyvertical/smrt-core/schema';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { BackgroundCapable } from '@happyvertical/smrt-jobs';
import '@happyvertical/smrt-jobs';
import { AssetCollection } from '@happyvertical/smrt-assets';
import '@happyvertical/smrt-profiles';
import '@happyvertical/smrt-users';
import {
  ManifestAdapter,
  OxcScanner,
} from '@happyvertical/smrt-scanner';
import {
  getDatabase,
  type DatabaseInterface,
} from '@happyvertical/sql';

import { copyTemplate } from '../../index.js';
import {
  ReferenceWorkItem,
  ReferenceWorkItemCollection,
  referenceWorkItemActionEffects,
} from './overlay/src/lib/objects/ReferenceWorkItem.js';
import { ReferenceWorkItemAssetCollection } from './overlay/src/lib/objects/ReferenceWorkItemAsset.js';

export { referenceWorkItemActionEffects };

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const overlayRoot = join(fixtureRoot, 'overlay');

export const REFERENCE_RUNTIME_PROFILES = [
  'local',
  'self-hosted',
  'cloud',
] as const;

export type ReferenceRuntimeProfile = (typeof REFERENCE_RUNTIME_PROFILES)[number];

/** Fixed clock input; generated IDs are canonicalized before assertions. */
export const REFERENCE_FIXTURE_NOW = new Date('2026-09-01T00:00:00.000Z');

const REFERENCE_OWNER = Object.freeze({
  name: 'Reference Owner',
  email: 'reference-owner@example.test',
  tenantName: 'Reference Workspace',
});

export interface CopiedReferenceFixture {
  readonly root: string;
  readonly manifestPath: string;
}

export interface InitializedReferenceFixture extends CopiedReferenceFixture {
  readonly manifest: SmartObjectManifest;
  readonly runtime: LocalApplicationRuntime;
  readonly bootstrapToken: string;
}

export interface ReferenceFixtureSeed {
  readonly profileId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly sessionId: string;
  readonly itemId: string;
  readonly assetId: string;
  readonly associationId: string;
  readonly jobId: string;
}

export interface CanonicalReferenceFixture {
  readonly owner: 'normal-owner';
  readonly tenant: 'default-tenant';
  readonly membership: 'owner';
  readonly session: 'active';
  readonly record: {
    readonly title: string;
    readonly status: string;
    readonly priority: number;
  };
  readonly asset: {
    readonly sourceUri: string;
    readonly role: string;
  };
  readonly job: {
    readonly queue: string;
    readonly method: string;
    readonly status: string;
  };
}

/**
 * Copy the public template, then apply the test-only workload overlay. The
 * copied app still receives its runtime profile exclusively through the normal
 * `SMRT_RUNTIME_PROFILE` configuration selector.
 */
export function copyRuntimeProfileReference(
  destination: string,
): CopiedReferenceFixture {
  copyTemplate(destination, {
    name: '@smrt-fixtures/runtime-profile-reference',
    overwrite: true,
  });
  cpSync(overlayRoot, destination, { recursive: true, force: true });

  // Preserve the public template's Item export while making the overlay
  // discoverable to a copied application's ordinary object barrel.
  const objectsIndexPath = join(destination, 'src', 'lib', 'objects', 'index.ts');
  const objectsIndex = readFileSync(objectsIndexPath, 'utf8');
  if (!objectsIndex.includes('ReferenceWorkItem')) {
    writeFileSync(
      objectsIndexPath,
      `${objectsIndex.trimEnd()}\n\nexport { ReferenceWorkItem, ReferenceWorkItemCollection, referenceWorkItemActionEffects } from './ReferenceWorkItem.js';\nexport { ReferenceWorkItemAsset, ReferenceWorkItemAssetCollection } from './ReferenceWorkItemAsset.js';\n`,
    );
  }

  const packagePath = join(destination, 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const release = packageJson.dependencies['@happyvertical/smrt-core'];
  if (!release) throw new Error('Reference fixture requires smrt-core.');
  for (const dependency of [
    '@happyvertical/smrt-assets',
    '@happyvertical/smrt-jobs',
  ]) {
    packageJson.dependencies[dependency] ??= release;
  }
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

  return {
    root: destination,
    manifestPath: join(destination, '.smrt', 'manifest.json'),
  };
}

/** Resolve the normal profile contract without provisioning external services. */
export function resolveReferenceRuntimeProfile(profile: ReferenceRuntimeProfile) {
  return resolveApplicationRuntime({ profile });
}

/**
 * Generate the same deterministic manifest/schema artifact pipeline used by
 * the framework's Vite plugin, but without starting a web server.
 */
export async function generateReferenceFixtureManifest(
  fixture: CopiedReferenceFixture,
): Promise<SmartObjectManifest> {
  const packageJson = JSON.parse(
    readFileSync(join(fixture.root, 'package.json'), 'utf8'),
  ) as { name: string; version: string; dependencies: Record<string, string> };
  const scanner = new OxcScanner({
    cwd: fixture.root,
    include: ['src/lib/objects/**/*.ts'],
    exclude: ['**/*.test.ts', '**/*.spec.ts'],
  });
  const { results, resolved } = await scanner.scanAndResolve();
  const errors = results.errors.filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      `Reference fixture scan failed: ${errors
        .map((diagnostic) => `${diagnostic.filePath}:${diagnostic.message}`)
        .join('; ')}`,
    );
  }

  // `smrt-scanner` intentionally owns a structurally compatible manifest type
  // to avoid a circular dependency on core. This is the supported boundary
  // consumed by core's public manifest-generation pass.
  const manifest = new ManifestAdapter().toManifest(resolved, {
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    typeAliases: results.typeAliases,
  }) as unknown as SmartObjectManifest;
  manifest.smrtDependencies = Object.keys(packageJson.dependencies).filter(
    (name) => name.startsWith('@happyvertical/smrt-'),
  );
  new ManifestGenerator().applyGenerationPasses(manifest, {
    packageName: packageJson.name,
    packageJson,
  });

  mkdirSync(dirname(fixture.manifestPath), { recursive: true });
  writeFileSync(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function referenceTables(manifest: SmartObjectManifest) {
  const classNames = new Set([
    'ReferenceWorkItem',
    'ReferenceWorkItemAsset',
  ]);
  const definitions = Object.values(manifest.objects).filter(
    (object) => classNames.has(object.className) && object.schema,
  );
  if (definitions.length !== classNames.size) {
    throw new Error('Reference fixture schemas are missing from the generated manifest.');
  }
  return collectManifestTables(
    definitions.map((definition) => ({
      schema: definition.schema!,
      source: definition.className,
    })),
  );
}

/** Apply generated, engine-specific fixture DDL without hand-written SQL. */
export async function migrateReferenceFixtureSchema(
  db: DatabaseInterface,
  manifest: SmartObjectManifest,
  engine: 'sqlite' | 'postgres',
): Promise<void> {
  for (const table of referenceTables(manifest).values()) {
    const ddl = renderCollectedManifestTable(table, engine);
    for (const statement of [ddl.createTable, ...ddl.indexes, ...ddl.triggers]) {
      await db.query(statement);
    }
  }
}

/** Prepare framework dependencies, then migrate the generated fixture schema. */
export async function prepareReferenceFixtureDatabase(
  db: DatabaseInterface,
  manifest: SmartObjectManifest,
  engine: 'sqlite' | 'postgres',
): Promise<void> {
  await getTestDatabase({
    db,
    type: engine,
    // Framework dependencies use their normal registry schemas; the two
    // application tables below must come exclusively from the copied app's
    // generated manifest.
    classes: ObjectRegistry.getQualifiedClassNames().filter(
      (className) =>
        className !== 'ReferenceWorkItem' &&
        className !== 'ReferenceWorkItemAsset' &&
        !className.endsWith(':ReferenceWorkItem') &&
        !className.endsWith(':ReferenceWorkItemAsset'),
    ),
  });
  await migrateReferenceFixtureSchema(db, manifest, engine);
}

/**
 * Initialize the copied app with a file-backed local runtime. All data lives
 * in the caller-owned temporary directory, outside the generated source tree.
 */
export async function initializeReferenceFixture(
  sourceRoot: string,
  dataDirectory: string,
): Promise<InitializedReferenceFixture> {
  const fixture = copyRuntimeProfileReference(sourceRoot);
  const manifest = await generateReferenceFixtureManifest(fixture);
  const initialized = await initializeLocalApplicationRuntime({
    appId: 'runtime-profile-reference',
    sourceRoot: fixture.root,
    dataDirectory,
    backgroundJobs: true,
    now: () => REFERENCE_FIXTURE_NOW,
    prepareDatabase: (db) =>
      prepareReferenceFixtureDatabase(db, manifest, 'sqlite'),
  });
  if (!initialized.bootstrap?.token) {
    throw new Error('Reference fixture bootstrap invitation was not created.');
  }
  return {
    ...fixture,
    manifest,
    runtime: initialized.runtime,
    bootstrapToken: initialized.bootstrap.token,
  };
}

/** Seed normal owner/RBAC/session data plus the representative app workload. */
export async function seedReferenceFixture(
  fixture: InitializedReferenceFixture,
): Promise<ReferenceFixtureSeed> {
  const claim = await fixture.runtime.claimOwner({
    token: fixture.bootstrapToken,
    ...REFERENCE_OWNER,
    userAgent: 'runtime-profile-reference-test',
    ipAddress: '127.0.0.1',
  });
  const items = await ReferenceWorkItemCollection.create({
    db: fixture.runtime.db,
  });
  const item = await items.create({
    tenantId: claim.tenantId,
    title: 'Reference workload',
    status: 'draft',
    priority: 50,
  });
  const assets = await AssetCollection.create({ db: fixture.runtime.db });
  const asset = await assets.create({
    tenantId: claim.tenantId,
    ownerProfileId: claim.profileId,
    name: 'Reference asset',
    sourceUri: 'fixture://runtime-profile-reference/reference-asset',
    mimeType: 'application/json',
    sourceType: 'fixture',
    metadata: { fixture: 'runtime-profile-reference' },
  });
  const associations = await ReferenceWorkItemAssetCollection.create({
    db: fixture.runtime.db,
  });
  const association = await associations.create({
    tenantId: claim.tenantId,
    referenceWorkItemId: item.id as string,
    assetId: asset.id as string,
    role: 'reference-attachment',
  });
  const backgroundItem = item as ReferenceWorkItem & BackgroundCapable;
  const job = await backgroundItem
    .background('prepareForReview', { marker: 'reference-fixture' })
    .queue('reference-workload')
    .priority('high')
    .retries(1)
    .enqueue();

  return {
    profileId: claim.profileId,
    userId: claim.userId,
    tenantId: claim.tenantId,
    membershipId: claim.membershipId,
    sessionId: claim.sessionId,
    itemId: item.id as string,
    assetId: asset.id as string,
    associationId: association.id as string,
    jobId: job.id,
  };
}

/** Return a stable, identifier-free shape for follow-on test assertions. */
export async function inspectReferenceFixture(
  fixture: InitializedReferenceFixture,
  seed: ReferenceFixtureSeed,
): Promise<CanonicalReferenceFixture> {
  const item = await (await ReferenceWorkItemCollection.create({ db: fixture.runtime.db })).get(
    seed.itemId,
  );
  const asset = await (await AssetCollection.create({ db: fixture.runtime.db })).get(
    seed.assetId,
  );
  const association = await (
    await ReferenceWorkItemAssetCollection.create({ db: fixture.runtime.db })
  ).get(seed.associationId);
  const jobs = await fixture.runtime.db.query(
    'SELECT queue, method, status FROM _smrt_jobs WHERE id = ?',
    seed.jobId,
  );
  const job = jobs.rows[0] as
    | { queue?: unknown; method?: unknown; status?: unknown }
    | undefined;
  if (!item || !asset || !association || !job) {
    throw new Error('Reference fixture seed is incomplete.');
  }
  if (!item.created_at || !item.updated_at || !asset.createdAt || !asset.updatedAt) {
    throw new Error('Reference fixture audit timestamps are missing.');
  }
  if (asset.getMetadata().fixture !== 'runtime-profile-reference') {
    throw new Error('Reference fixture audit metadata is missing.');
  }
  return {
    owner: 'normal-owner',
    tenant: 'default-tenant',
    membership: 'owner',
    session: 'active',
    record: {
      title: item.title,
      status: item.status,
      priority: item.priority,
    },
    asset: {
      sourceUri: asset.sourceUri,
      role: association.role,
    },
    job: {
      queue: String(job.queue),
      method: String(job.method),
      status: String(job.status),
    },
  };
}

/** Alias that makes the identifier-free contract explicit to future M5 tests. */
export const canonicalizeReferenceFixture = inspectReferenceFixture;

/** Open a disposable PostgreSQL database through the repository test wrapper. */
export async function openReferencePostgresDatabase(): Promise<DatabaseInterface> {
  const url = process.env.SMRT_TEST_POSTGRES_URL;
  if (!url) {
    throw new Error('SMRT_TEST_POSTGRES_URL is required for PostgreSQL fixture tests.');
  }
  return getDatabase({ type: 'postgres', url });
}
