/**
 * Self-hosted half of the M5d job-contract parity proof (#2578).
 *
 * The local profile runs the same enqueued workflow with the runtime's own
 * embedded/on-demand runner (see `runtimeProfileParity.test.ts`). The
 * self-hosted profile declares `jobs.topology: 'external'`, so here the job is
 * enqueued by one PostgreSQL connection and executed by a SEPARATE worker
 * connection that owns no web runtime — the external-worker topology.
 *
 * It runs only through the repository's disposable `test:postgres` service
 * wrapper; ordinary local runs stay file-backed SQLite.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import {
  type BackgroundCapable,
  SmrtJobCollection,
  type TaskRunner,
  createTaskRunner,
} from '@happyvertical/smrt-jobs';
import { getDatabase, type DatabaseInterface } from '@happyvertical/sql';

import {
  copyRuntimeProfileReference,
  generateReferenceFixtureManifest,
  openReferencePostgresDatabase,
  prepareReferenceFixtureDatabase,
} from '../fixtures/runtime-profile-reference/index.js';
import {
  type ReferenceWorkItem,
  ReferenceWorkItemCollection,
} from '../fixtures/runtime-profile-reference/overlay/src/lib/objects/ReferenceWorkItem.js';
import {
  REFERENCE_JOB_OUTCOME,
  canonicalizeJobOutcome,
} from './support/runtimeSurfaceParity.js';

const postgresDescribe = process.env.SMRT_TEST_POSTGRES_URL
  ? describe
  : describe.skip;

/** Fixed synthetic tenant UUID; no owner bootstrap runs against a shared service. */
const FIXTURE_TENANT_ID = '00000000-0000-4000-8000-000000002578';

let temporaryDirectory: string | undefined;
let applicationDb: DatabaseInterface | undefined;
let workerDb: DatabaseInterface | undefined;
let runner: TaskRunner | undefined;

afterEach(async () => {
  await runner?.stop();
  runner = undefined;
  if (applicationDb) {
    await applicationDb.query(
      'DROP TABLE IF EXISTS "reference_work_item_assets" CASCADE',
    );
    await applicationDb.query(
      'DROP TABLE IF EXISTS "reference_work_items" CASCADE',
    );
  }
  await workerDb?.close?.();
  await applicationDb?.close?.();
  workerDb = undefined;
  applicationDb = undefined;
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

postgresDescribe('self-hosted external-worker job-contract parity', () => {
  it('completes the same enqueued workflow with the same domain result', async () => {
    expect(
      resolveApplicationRuntime({ profile: 'self-hosted' }).providers.jobs
        .topology,
    ).toBe('external');

    temporaryDirectory = mkdtempSync(
      join(realpathSync(tmpdir()), 'smrt-runtime-profile-parity-postgres-'),
    );
    const fixture = copyRuntimeProfileReference(
      join(temporaryDirectory, 'app'),
    );
    const manifest = await generateReferenceFixtureManifest(fixture);

    applicationDb = await openReferencePostgresDatabase();
    await prepareReferenceFixtureDatabase(applicationDb, manifest, 'postgres');

    // The application side: create the record and enqueue through the same
    // fluent background contract the local profile uses.
    const items = await ReferenceWorkItemCollection.create({
      db: applicationDb,
    });
    const item = await items.create({
      tenantId: FIXTURE_TENANT_ID,
      title: 'Reference workload',
      status: 'draft',
      priority: 50,
    });
    const handle = await (item as ReferenceWorkItem & BackgroundCapable)
      .background('prepareForReview', { marker: 'reference-fixture' })
      .queue('reference-workload')
      .priority('high')
      .retries(1)
      .enqueue();

    // The worker side: a separate connection, owning no web runtime.
    workerDb = await getDatabase({
      type: 'postgres',
      url: process.env.SMRT_TEST_POSTGRES_URL as string,
    });
    runner = createTaskRunner({
      concurrency: 1,
      queues: ['reference-workload'],
      pollInterval: 25,
      retention: false,
    });
    await runner.initialize(workerDb);
    await runner.start();

    const jobs = await SmrtJobCollection.create({ db: applicationDb });
    const deadline = Date.now() + 60_000;
    let job = await jobs.get(handle.id);
    while (
      job &&
      job.status !== 'completed' &&
      job.status !== 'failed' &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      job = await jobs.get(handle.id);
    }
    await runner.stop();
    runner = undefined;

    const executed = await items.get(item.id as string);
    expect(
      canonicalizeJobOutcome({
        queue: job?.queue,
        method: job?.method,
        jobStatus: job?.status,
        record: {
          title: executed?.title,
          status: executed?.status,
          priority: executed?.priority,
        },
      }),
    ).toEqual(REFERENCE_JOB_OUTCOME);
  }, 180_000);
});
