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
import { isFrameworkBaseClass, ObjectRegistry } from '@happyvertical/smrt-core';
import { buildWebMcpToolDefinitions } from '@happyvertical/smrt-core/vite-plugin';
import {
  type SmartObjectManifest,
  ManifestGenerator,
} from '@happyvertical/smrt-core/scanner';
import {
  collectManifestTables,
  renderCollectedManifestTable,
} from '@happyvertical/smrt-core/schema';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  type BackgroundCapable,
  SmrtJobCollection,
} from '@happyvertical/smrt-jobs';
import '@happyvertical/smrt-jobs';
import { AssetCollection } from '@happyvertical/smrt-assets';
import '@happyvertical/smrt-profiles';
import '@happyvertical/smrt-users';
import {
  type AgentSurface,
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
} from './overlay/src/lib/objects/ReferenceWorkItem.js';
import { ReferenceWorkItemAssetCollection } from './overlay/src/lib/objects/ReferenceWorkItemAsset.js';

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

export interface ReferenceWorkItemActionEffect {
  readonly effect: 'write' | 'destructive';
  readonly idempotent: boolean;
  readonly openWorld: boolean;
  /** The fixture's caller-facing approval rule, derived from the emitted effect. */
  readonly requiresApproval: boolean;
}

/**
 * Snapshot the action policy from the copied app's emitted WebMCP definitions.
 * MCP shares the same descriptor builder, while the copied manifest retains the
 * REST/CLI/MCP inclusion data consumed by their respective generators.
 */
export function referenceWorkItemActionEffects(
  manifest: SmartObjectManifest,
): Readonly<Record<'prepareForReview' | 'archive', ReferenceWorkItemActionEffect>> {
  const definitions = buildWebMcpToolDefinitions(manifest).filter(
    (definition) =>
      definition.className === 'ReferenceWorkItem' &&
      (definition.action === 'prepareForReview' || definition.action === 'archive'),
  );
  if (definitions.length !== 2) {
    throw new Error('Reference fixture WebMCP action definitions are incomplete.');
  }

  return Object.fromEntries(
    definitions.map((definition) => [
      definition.action,
      {
        effect: definition.effect,
        idempotent: definition.idempotent,
        openWorld: definition.openWorld,
        requiresApproval: definition.effect !== 'read',
      },
    ]),
  ) as Readonly<Record<'prepareForReview' | 'archive', ReferenceWorkItemActionEffect>>;
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
      `${objectsIndex.trimEnd()}\n\nexport { ReferenceWorkItem, ReferenceWorkItemCollection } from './ReferenceWorkItem.js';\nexport { ReferenceWorkItemAsset, ReferenceWorkItemAssetCollection } from './ReferenceWorkItemAsset.js';\n`,
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

/**
 * Snapshot the copied app's DECLARED agent surface — view intents and
 * playbooks — from source alone (#2591).
 *
 * The counterpart to {@link referenceWorkItemActionEffects}, which snapshots
 * the GENERATED model tools. Together they are the whole agent-addressable
 * surface, and parity has to cover both: a policy that is a byte-for-byte
 * cross-profile invariant for model tools while the browser half goes
 * unchecked proves only half of what it claims.
 *
 * Nothing is mounted, no route is rendered, and no application module is
 * imported — the scanner reads the copied `.ts` sources structurally, which is
 * precisely the property that makes the surface knowable at all.
 */
export async function referenceAgentSurface(
  fixture: CopiedReferenceFixture,
): Promise<AgentSurface> {
  const { results } = await new OxcScanner({
    cwd: fixture.root,
    include: ['src/**/*.ts'],
    exclude: ['**/*.test.ts', '**/*.spec.ts', '**/node_modules/**'],
  }).scanAndResolve();
  return results.agentSurface;
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
    // generated manifest. This is an implicit-shaped request ("every
    // framework-registered class") expressed as an explicit filter only to
    // exclude those two app classes, so it must also drop the framework's
    // own abstract base classes (SmrtObject, SmrtClass, ...) the way
    // getTestDatabase()'s implicit path does (#2645) -- otherwise this
    // fixture creates phantom smrt_objects/smrt_classes/smrt_collections/
    // smrt_hierarchicals/smrt_polymorphic_associations tables that
    // buildMergedTableSchemas() never creates in production (#2708).
    classes: ObjectRegistry.getQualifiedClassNames().filter((className) => {
      if (
        className === 'ReferenceWorkItem' ||
        className === 'ReferenceWorkItemAsset' ||
        className.endsWith(':ReferenceWorkItem') ||
        className.endsWith(':ReferenceWorkItemAsset')
      ) {
        return false;
      }
      const registered = ObjectRegistry.getClass(className);
      return !isFrameworkBaseClass(registered?.name, registered?.packageName);
    }),
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
    metadata: JSON.stringify({ fixture: 'runtime-profile-reference' }),
  });
  const associations = await ReferenceWorkItemAssetCollection.create({
    db: fixture.runtime.db,
  });
  const association = await associations.attach(item.id as string, asset.id as string, {
    tenantId: claim.tenantId,
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
  const job = await (await SmrtJobCollection.create({ db: fixture.runtime.db })).get(seed.jobId);
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
