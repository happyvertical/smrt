import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { FRAMEWORK_BASE_TABLE_NAMES } from '@happyvertical/smrt-core/migrations';

import {
  REFERENCE_RUNTIME_PROFILES,
  type InitializedReferenceFixture,
  canonicalizeReferenceFixture,
  copyRuntimeProfileReference,
  generateReferenceFixtureManifest,
  initializeReferenceFixture,
  referenceAgentSurface,
  referenceWorkItemActionEffects,
  resolveReferenceRuntimeProfile,
  seedReferenceFixture,
} from '../fixtures/runtime-profile-reference/index.js';

import { copyTemplate } from '../index.js';

const testDirectory = dirname(fileURLToPath(import.meta.url));

let temporaryDirectory: string | undefined;
let initialized: InitializedReferenceFixture | undefined;

function fixtureDirectories(): { sourceRoot: string; dataDirectory: string } {
  temporaryDirectory = mkdtempSync(
    join(realpathSync(tmpdir()), 'smrt-runtime-profile-reference-'),
  );
  return {
    sourceRoot: join(temporaryDirectory, 'app'),
    // Deliberately a sibling, never a child of the generated source tree.
    dataDirectory: join(temporaryDirectory, 'state'),
  };
}

afterEach(async () => {
  await initialized?.runtime.db.close?.();
  initialized = undefined;
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe('runtime-profile reference workload fixture', () => {
  it('copies and generates one unchanged source tree for all supported profiles without leaking fixture files', async () => {
    const { sourceRoot } = fixtureDirectories();
    const fixture = copyRuntimeProfileReference(sourceRoot);
    const copiedConfig = readFileSync(join(fixture.root, 'smrt.config.ts'), 'utf8');

    for (const profile of REFERENCE_RUNTIME_PROFILES) {
      expect(resolveReferenceRuntimeProfile(profile).profile).toBe(profile);
      expect(readFileSync(join(fixture.root, 'smrt.config.ts'), 'utf8')).toBe(
        copiedConfig,
      );
      const profileFixture = copyRuntimeProfileReference(
        join(temporaryDirectory as string, `profile-${profile}`),
      );
      const profileManifest = await generateReferenceFixtureManifest(profileFixture);
      expect(
        Object.values(profileManifest.objects).some(
          (object) => object.className === 'ReferenceWorkItem',
        ),
      ).toBe(true);
    }

    expect(copiedConfig).toContain("process.env.SMRT_RUNTIME_PROFILE || 'local'");
    expect(existsSync(join(fixture.root, 'src/lib/objects/ReferenceWorkItem.ts'))).toBe(
      true,
    );

    const plainTemplate = join(temporaryDirectory as string, 'plain-template');
    copyTemplate(plainTemplate, { name: 'plain-template', overwrite: true });
    expect(existsSync(join(plainTemplate, 'fixtures'))).toBe(false);
    expect(
      existsSync(join(plainTemplate, 'src/lib/objects/ReferenceWorkItem.ts')),
    ).toBe(false);
    expect(readdirSync(join(plainTemplate, 'src/lib/objects')).sort()).toEqual([
      'Item.ts',
      'index.ts',
    ]);

    const templatePackage = JSON.parse(
      readFileSync(join(testDirectory, '..', 'package.json'), 'utf8'),
    ) as { files: string[] };
    expect(templatePackage.files).not.toContain('fixtures');
  });

  it('writes generated schema and action artifacts from the copied overlay', async () => {
    const { sourceRoot } = fixtureDirectories();
    const fixture = copyRuntimeProfileReference(sourceRoot);
    const manifest = await generateReferenceFixtureManifest(fixture);
    const workItem = Object.values(manifest.objects).find(
      (object) => object.className === 'ReferenceWorkItem',
    );

    expect(readFileSync(fixture.manifestPath, 'utf8')).toContain(
      'ReferenceWorkItem',
    );
    expect(workItem).toMatchObject({
      schema: {
        tableName: 'reference_work_items',
        columns: {
          tenant_id: expect.any(Object),
          title: expect.any(Object),
          status: expect.any(Object),
          priority: expect.any(Object),
        },
      },
      decoratorConfig: {
        api: {
          routes: {
            prepareForReview: {
              method: 'POST',
              effect: 'write',
              idempotent: true,
              openWorld: false,
            },
            archive: {
              method: 'DELETE',
              effect: 'destructive',
              idempotent: true,
              openWorld: false,
            },
          },
        },
      },
      methods: {
        prepareForReview: expect.any(Object),
        archive: expect.any(Object),
      },
    });
    expect(
      Object.values(manifest.objects).find(
        (object) => object.className === 'ReferenceWorkItemAsset',
      ),
    ).toMatchObject({
      schema: {
        tableName: 'reference_work_item_assets',
        columns: {
          tenant_id: expect.any(Object),
          reference_work_item_id: expect.any(Object),
          asset_id: expect.any(Object),
          role: expect.any(Object),
        },
      },
    });
    for (const transport of ['api', 'cli', 'mcp'] as const) {
      expect(workItem?.decoratorConfig?.[transport]).toEqual(
        expect.objectContaining({
          include: expect.arrayContaining(['prepareForReview', 'archive']),
        }),
      );
    }
    expect(referenceWorkItemActionEffects(manifest)).toEqual({
      prepareForReview: {
        effect: 'write',
        idempotent: true,
        openWorld: false,
        requiresApproval: true,
      },
      archive: {
        effect: 'destructive',
        idempotent: true,
        openWorld: false,
        requiresApproval: true,
      },
    });
  });

  it('emits the same declared agent surface under every runtime profile', async () => {
    // Generated model tools were already a build-time cross-profile invariant;
    // view intents and playbooks only existed once something mounted, so the
    // browser half of the agent surface was outside every parity claim (#2591).
    // Now it is emitted from source and can be held to the same standard.
    fixtureDirectories();

    const snapshots = new Map<string, string>();
    for (const profile of REFERENCE_RUNTIME_PROFILES) {
      const fixture = copyRuntimeProfileReference(
        join(temporaryDirectory as string, `agent-surface-${profile}`),
      );
      expect(resolveReferenceRuntimeProfile(profile).profile).toBe(profile);
      const surface = await referenceAgentSurface(fixture);

      expect(surface.diagnostics).toEqual([]);
      expect(surface.intents.map((intent) => intent.id)).toEqual([
        'reference.reveal_archived',
        'reference.stage_priority',
      ]);
      expect(surface.playbooks.map((playbook) => playbook.key)).toEqual([
        'reference.archive',
        'reference.prepare_for_review',
      ]);
      // Silence from a playbook that contains a view-intent step never widens
      // its planes: server validity rides the #2446 command/ack bridge and has
      // to be declared, which `reference.archive` does and the other does not.
      expect(
        Object.fromEntries(
          surface.playbooks.map((playbook) => [playbook.key, playbook.planes]),
        ),
      ).toEqual({
        'reference.archive': ['browser', 'server'],
        'reference.prepare_for_review': ['browser'],
      });

      snapshots.set(profile, JSON.stringify(surface, null, 2));
    }

    const [canonical, ...others] = [...snapshots.values()];
    for (const snapshot of others) {
      expect(snapshot).toBe(canonical);
    }
  });

  it('seeds ordinary owner, tenant, asset, and queued-workflow state on file-backed SQLite', async () => {
    const { sourceRoot, dataDirectory } = fixtureDirectories();
    initialized = await initializeReferenceFixture(sourceRoot, dataDirectory);
    const seed = await seedReferenceFixture(initialized);
    const snapshot = await canonicalizeReferenceFixture(initialized, seed);

    expect(relative(initialized.root, initialized.runtime.paths.database)).toMatch(
      /^\.\./,
    );
    expect(existsSync(initialized.runtime.paths.database)).toBe(true);

    // #2708: prepareReferenceFixtureDatabase()'s explicit `classes` filter
    // must exclude the framework's own abstract base classes the same way
    // getTestDatabase()'s implicit path does (#2645) -- otherwise this fixture
    // creates the five phantom tables buildMergedTableSchemas() never creates
    // in production, defeating the whole point of a schema-parity fixture.
    const tableRows = (
      await initialized.runtime.db.query(
        "SELECT name FROM sqlite_master WHERE type='table'",
      )
    ).rows as { name?: string }[];
    const tableNames = new Set(tableRows.map((row) => row.name));
    for (const frameworkTableName of FRAMEWORK_BASE_TABLE_NAMES) {
      expect(tableNames.has(frameworkTableName)).toBe(false);
    }

    expect(snapshot).toEqual({
      owner: 'normal-owner',
      tenant: 'default-tenant',
      membership: 'owner',
      session: 'active',
      record: {
        title: 'Reference workload',
        status: 'draft',
        priority: 50,
      },
      asset: {
        sourceUri: 'fixture://runtime-profile-reference/reference-asset',
        role: 'reference-attachment',
      },
      job: {
        queue: 'reference-workload',
        method: 'prepareForReview',
        status: 'pending',
      },
    });

    const restored = await initialized.runtime.restoreSession(seed.sessionId);
    expect(restored).toMatchObject({
      tenantId: seed.tenantId,
      membership: { id: seed.membershipId },
      user: { id: seed.userId },
    });
  });
});
