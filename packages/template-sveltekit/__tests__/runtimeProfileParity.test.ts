/**
 * M5d — generated-surface, policy, and job parity across runtime profiles
 * (#2578, parent #2547).
 *
 * One unchanged copied application is generated separately under the `local`,
 * `self-hosted`, and `cloud` profile selections. Everything an agent or client
 * can address — REST routes, OpenAPI operations, CLI commands, MCP tool
 * schemas, WebMCP descriptors, action effects, destructive/external
 * annotations, approval requirements, exposure policy, and tenant scope — must
 * canonicalize to the same bytes. The runtime profile selects infrastructure,
 * never the domain surface.
 *
 * The one allowlisted exception is the operational diagnostic tool from #2577.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MIGRATION_FAILED_MESSAGE } from '@happyvertical/smrt-app-runtime';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import type { TaskRunner } from '@happyvertical/smrt-jobs';
import { SmrtJobCollection } from '@happyvertical/smrt-jobs';

import {
  REFERENCE_RUNTIME_PROFILES,
  type InitializedReferenceFixture,
  initializeReferenceFixture,

  seedReferenceFixture,
} from '../fixtures/runtime-profile-reference/index.js';
import { ReferenceWorkItemCollection } from '../fixtures/runtime-profile-reference/overlay/src/lib/objects/ReferenceWorkItem.js';
import {
  OPERATIONAL_DIAGNOSTIC_ROUTE,
  OPERATIONAL_DIAGNOSTIC_TOOL_NAME,
  REFERENCE_JOB_OUTCOME,
  type RuntimeProfileSurfaces,
  canonicalizeJobOutcome,
  canonicalizeRuntimeProfileSurfaces,
  captureRuntimeProfileSurfaces,
  describeSurfaceDivergence,
  openApiGapsAgainstGeneratedRest,
} from './support/runtimeSurfaceParity.js';
import {
  MIGRATION_FAILURE_MESSAGE,
  SECRET_LIKE_MARKER,
  captureRecovery,
  corruptRuntimeProfileConfig,
  initializeWithFailingMigration,
  missingRuntimeProfileConfig,
} from './support/runtimeFailureInjection.js';

let temporaryDirectory: string | undefined;
let initialized: InitializedReferenceFixture | undefined;
let runner: TaskRunner | undefined;

function temporaryRoot(): string {
  temporaryDirectory = mkdtempSync(
    join(realpathSync(tmpdir()), 'smrt-runtime-profile-parity-'),
  );
  return temporaryDirectory;
}

afterEach(async () => {
  await runner?.stop();
  runner = undefined;
  await initialized?.runtime.db.close?.();
  initialized = undefined;
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

async function captureEveryProfile(): Promise<RuntimeProfileSurfaces[]> {
  const root = temporaryRoot();
  const captured: RuntimeProfileSurfaces[] = [];
  for (const profile of REFERENCE_RUNTIME_PROFILES) {
    captured.push(
      await captureRuntimeProfileSurfaces(join(root, `app-${profile}`), profile),
    );
  }
  return captured;
}

describe('runtime-profile generated-surface and policy parity', () => {
  it('emits one identical domain surface under local, self-hosted, and cloud', async () => {
    const captured = await captureEveryProfile();
    expect(captured.map((surfaces) => surfaces.profile)).toEqual([
      'local',
      'self-hosted',
      'cloud',
    ]);

    const [baseline, ...others] = captured;
    const canonical = canonicalizeRuntimeProfileSurfaces(baseline);
    for (const candidate of others) {
      expect(
        canonicalizeRuntimeProfileSurfaces(candidate),
        describeSurfaceDivergence(baseline, candidate),
      ).toBe(canonical);
    }

    // `generateOpenAPISpec()` reads the process-wide registry, so on its own it
    // cannot witness a change to the copied app's REST surface. Tie it back to
    // the per-copy generated routes: an operation the routes emit but the
    // OpenAPI document omits is a real under-description, not a parity pass.
    for (const surfaces of captured) {
      expect(
        openApiGapsAgainstGeneratedRest(surfaces, 'referenceworkitems'),
      ).toEqual([]);
    }

    // Reviewed snapshot: an intended API/policy change must be read as a diff,
    // never regenerated blindly.
    expect(canonical).toMatchSnapshot('canonical-domain-surface');
  }, 180_000);

  it('keeps every declared policy field identical while the infrastructure composition differs', async () => {
    const captured = await captureEveryProfile();
    const byProfile = new Map(
      captured.map((surfaces) => [surfaces.profile, surfaces]),
    );

    // The profiles really are different compositions — otherwise the parity
    // assertion above would be vacuous.
    expect(
      captured.map((surfaces) => surfaces.composition.providers),
    ).toEqual([
      expect.objectContaining({
        database: expect.objectContaining({ engine: 'sqlite' }),
        jobs: { topology: 'embedded' },
      }),
      expect.objectContaining({
        database: expect.objectContaining({ engine: 'postgres' }),
        jobs: { topology: 'external' },
      }),
      expect.objectContaining({
        database: expect.objectContaining({ engine: 'postgres' }),
        jobs: { topology: 'scalable' },
      }),
    ]);

    // Every profile declares the same surface invariants.
    for (const surfaces of captured) {
      expect(surfaces.composition.invariants).toMatchObject({
        generatedRest: 'identical',
        generatedCli: 'identical',
        generatedMcp: 'identical',
        generatedWebMcp: 'identical',
        actionEffects: 'identical',
        approvalPolicy: 'identical',
        mcpExposurePolicy: 'identical',
        webMcpExposurePolicy: 'identical',
        jobInvocation: 'identical',
      });
    }

    const policyOf = (profile: string) =>
      (byProfile.get(profile as never) as RuntimeProfileSurfaces).domainTools.map(
        (tool) => ({
          name: tool.name,
          effect: tool.effect,
          readOnly: tool.readOnly,
          idempotent: tool.idempotent,
          openWorld: tool.openWorld,
          requiresApproval: tool.requiresApproval,
          exposure: tool.exposure,
          tenantScope: tool.tenantScope,
        }),
      );

    expect(policyOf('self-hosted')).toEqual(policyOf('local'));
    expect(policyOf('cloud')).toEqual(policyOf('local'));

    // The representative workload's declared effects/approvals, spelled out so
    // a silent widening is a readable failure rather than a snapshot churn.
    const local = byProfile.get('local') as RuntimeProfileSurfaces;
    const named = new Map(local.domainTools.map((tool) => [tool.name, tool]));
    expect(named.get('referenceworkitem_prepareforreview')).toMatchObject({
      effect: 'write',
      readOnly: false,
      idempotent: true,
      openWorld: false,
      requiresApproval: true,
      tenantScope: 'required',
      exposure: { api: true, cli: true, mcp: true, webMcp: true },
    });
    expect(named.get('referenceworkitem_archive')).toMatchObject({
      effect: 'destructive',
      readOnly: false,
      openWorld: false,
      requiresApproval: true,
      tenantScope: 'required',
      exposure: { api: true, cli: true, mcp: true, webMcp: true },
    });
    expect(named.get('referenceworkitem_list')).toMatchObject({
      effect: 'read',
      readOnly: true,
      requiresApproval: false,
      tenantScope: 'required',
    });
  }, 180_000);

  it('allows exactly one documented operational exception', async () => {
    const captured = await captureEveryProfile();

    for (const surfaces of captured) {
      expect(surfaces.operationalExceptions).toEqual([
        OPERATIONAL_DIAGNOSTIC_TOOL_NAME,
      ]);
      // The exception is authored, not generated per model: it can never be
      // mistaken for a domain tool that appeared under one profile only.
      const diagnostics = surfaces.rest.find(
        (route) => route.route === OPERATIONAL_DIAGNOSTIC_ROUTE,
      );
      expect(diagnostics?.generated).toBe(false);
      expect(
        surfaces.domainTools.some(
          (tool) => tool.name === OPERATIONAL_DIAGNOSTIC_TOOL_NAME,
        ),
      ).toBe(false);
      expect(surfaces.mcpToolNames).not.toContain(
        OPERATIONAL_DIAGNOSTIC_TOOL_NAME,
      );
      expect(
        surfaces.mcpToolSchemas.some(
          (tool) =>
            (tool as { name: string }).name ===
            OPERATIONAL_DIAGNOSTIC_TOOL_NAME,
        ),
      ).toBe(false);
    }

    // An unexpected divergence fails with an actionable, secret-free message.
    const [baseline] = captured;
    const tampered: RuntimeProfileSurfaces = {
      ...baseline,
      profile: 'cloud',
      openApiOperations: [
        ...baseline.openApiOperations,
        'GET /referenceworkitems/sneak',
      ],
    };
    const report = describeSurfaceDivergence(baseline, tampered);
    expect(report).toContain('Generated surface differs');
    expect(report).toContain('referenceworkitems/sneak');
    expect(report).toContain('do not');
    expect(report).not.toContain(realpathSync(tmpdir()));
  }, 180_000);

  it('validates the managed-cloud case as configuration only', async () => {
    const cloud = resolveApplicationRuntime({ profile: 'cloud' });

    expect(cloud.profile).toBe('cloud');
    expect(cloud.providers.database).toMatchObject({
      engine: 'postgres',
      connectionOwnership: 'managed',
    });
    expect(cloud.providers.jobs.topology).toBe('scalable');
    // Resolution is pure configuration: nothing claims a provisioned service.
    expect(cloud.diagnostics).toMatchObject({
      secretValuesIncluded: false,
      unsafeOverrides: [],
    });
    expect(JSON.stringify(cloud)).not.toMatch(/https?:\/\//);
  });
});

describe('runtime-profile job-contract parity', () => {
  it('completes the same enqueued workflow under local embedded execution', async () => {
    const root = temporaryRoot();
    initialized = await initializeReferenceFixture(
      join(root, 'app'),
      join(root, 'state'),
    );
    const seed = await seedReferenceFixture(initialized);

    runner = await initialized.runtime.createEmbeddedJobRunner({
      queues: ['reference-workload'],
      pollInterval: 25,
    });
    await runner.start();

    const jobs = await SmrtJobCollection.create({ db: initialized.runtime.db });
    const items = await ReferenceWorkItemCollection.create({
      db: initialized.runtime.db,
    });
    const deadline = Date.now() + 30_000;
    let job = await jobs.get(seed.jobId);
    while (
      job &&
      job.status !== 'completed' &&
      job.status !== 'failed' &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      job = await jobs.get(seed.jobId);
    }
    await runner.stop();
    runner = undefined;

    const item = await items.get(seed.itemId);
    const outcome = canonicalizeJobOutcome({
      queue: job?.queue,
      method: job?.method,
      jobStatus: job?.status,
      record: {
        title: item?.title,
        status: item?.status,
        priority: item?.priority,
      },
    });

    expect(outcome).toEqual(REFERENCE_JOB_OUTCOME);
    // The PostgreSQL external-worker half of this contract runs in
    // `runtimeProfileParity.postgres.optional.test.ts` and asserts the same
    // canonical outcome.
  }, 120_000);
});

describe('runtime-profile failure recovery', () => {
  it('reports a stable, secret-free recovery for a missing profile configuration', async () => {
    const report = await captureRecovery(() =>
      resolveApplicationRuntime(missingRuntimeProfileConfig() as never),
    );

    expect(report.name).toBe('RuntimeProfileValidationError');
    expect(report.codes).toEqual(['invalid_config']);
    expect(report.recoveries).toEqual([
      'Select one documented runtime profile.',
    ]);
    // The target stays retryable: selecting a profile resolves immediately,
    // with no state to clean up first.
    expect(resolveApplicationRuntime({ profile: 'local' }).profile).toBe(
      'local',
    );
  });

  it('reports a stable, secret-free recovery for a corrupt profile configuration', async () => {
    const report = await captureRecovery(() =>
      resolveApplicationRuntime(corruptRuntimeProfileConfig() as never),
    );

    expect(report.name).toBe('RuntimeProfileValidationError');
    expect(report.codes.length).toBeGreaterThan(0);
    expect(report.recoveries.length).toBeGreaterThan(0);
    expect(report.message).not.toContain(SECRET_LIKE_MARKER);
    expect(report.message).not.toContain('fixture-not-a-real-password');
    expect(JSON.stringify(report.codes)).not.toContain('fixture.invalid');
    expect(resolveApplicationRuntime({ profile: 'local' }).profile).toBe(
      'local',
    );
  });

  it('surfaces a forced migration failure without leaking runtime material and leaves a retryable target', async () => {
    const root = temporaryRoot();
    const sourceRoot = join(root, 'app');
    const dataDirectory = join(root, 'state');

    const report = await captureRecovery(() =>
      initializeWithFailingMigration(sourceRoot, dataDirectory),
    );
    expect(report.failed).toBe(true);

    // Closed by happyvertical/smrt#2632. A failed `prepareDatabase` is now
    // normalized like every other local-runtime startup failure: a
    // `LocalRuntimeError` carrying the stable `migration_failed` code and a
    // fixed, secret-free message. The application's own diagnosis no longer
    // reaches the surface at all — a migration driver message is a likely
    // carrier of a credential, so it is retained only as a private `cause`.
    expect(report.name).toBe('LocalRuntimeError');
    expect(report.codes).toEqual(['migration_failed']);
    expect(report.message).toBe(MIGRATION_FAILED_MESSAGE);

    // The recovery instruction is carried in the message for a
    // `LocalRuntimeError`; `recoveries` is populated only from the structured
    // `issues` of a `RuntimeProfileValidationError`, so it stays empty here.
    expect(report.message).toContain('pnpm app:setup');
    expect(report.recoveries).toEqual([]);

    // The startup envelope still contributes no material of its own: no data
    // directory, no database file location, no bootstrap token, no
    // environment value — and now no application migration text either.
    expect(report.message).not.toContain(MIGRATION_FAILURE_MESSAGE);
    expect(report.message).not.toContain(SECRET_LIKE_MARKER);
    expect(report.message).not.toContain(dataDirectory);
    expect(report.message).not.toContain(sourceRoot);
    expect(report.message).not.toContain(realpathSync(tmpdir()));
    expect(report.message).not.toMatch(/postgres:\/\/|sqlite:|Bearer /i);

    // Retryable: the same application root and data directory initialize and
    // seed normally once the migration succeeds. Nothing is left holding the
    // database or the initialization lock.
    initialized = await initializeReferenceFixture(sourceRoot, dataDirectory);
    const seed = await seedReferenceFixture(initialized);
    expect(seed.itemId).toBeTruthy();
  }, 120_000);
});
