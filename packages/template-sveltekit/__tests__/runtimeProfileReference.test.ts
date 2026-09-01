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

import {
  REFERENCE_RUNTIME_PROFILES,
  type InitializedReferenceFixture,
  canonicalizeReferenceFixture,
  copyRuntimeProfileReference,
  generateReferenceFixtureManifest,
  initializeReferenceFixture,
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
  it('copies one unchanged source tree for all supported profiles without leaking fixture files', () => {
    const { sourceRoot } = fixtureDirectories();
    const fixture = copyRuntimeProfileReference(sourceRoot);
    const copiedConfig = readFileSync(join(fixture.root, 'smrt.config.ts'), 'utf8');

    for (const profile of REFERENCE_RUNTIME_PROFILES) {
      expect(resolveReferenceRuntimeProfile(profile).profile).toBe(profile);
      expect(readFileSync(join(fixture.root, 'smrt.config.ts'), 'utf8')).toBe(
        copiedConfig,
      );
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
    expect(referenceWorkItemActionEffects).toEqual({
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

  it('seeds ordinary owner, tenant, asset, and queued-workflow state on file-backed SQLite', async () => {
    const { sourceRoot, dataDirectory } = fixtureDirectories();
    initialized = await initializeReferenceFixture(sourceRoot, dataDirectory);
    const seed = await seedReferenceFixture(initialized);
    const snapshot = await canonicalizeReferenceFixture(initialized, seed);

    expect(relative(initialized.root, initialized.runtime.paths.database)).toMatch(
      /^\.\./,
    );
    expect(existsSync(initialized.runtime.paths.database)).toBe(true);
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
