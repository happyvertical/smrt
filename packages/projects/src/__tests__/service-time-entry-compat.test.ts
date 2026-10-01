/**
 * #3288 compatibility: `ServiceTimeEntry` and its commercial snapshots moved
 * to `@happyvertical/smrt-timesheets`. A database built from the pre-move
 * smrt-projects schema — still carrying the support-only `case_id` /
 * `specialist_id` columns and their indexes — must keep working through the
 * classes smrt-projects exports, with no schema change and no executable
 * migration.
 *
 * `fixtures/pre-3288-service-evidence-schema.json` is the schema section of
 * smrt-projects' built manifest at 02590837 (the commit before the move).
 */
import { readFileSync } from 'node:fs';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { getPendingSchemaStatements } from '@happyvertical/smrt-core/migrations';
import {
  collectManifestTables,
  type ManifestSchemaLike,
  renderCollectedManifestTable,
} from '@happyvertical/smrt-core/schema';
import * as timesheets from '@happyvertical/smrt-timesheets';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ServiceChargeSnapshot,
  ServiceChargeSnapshotCollection,
  ServiceCompensationSnapshotCollection,
  ServiceEvidenceService,
  ServiceTimeEntry,
  ServiceTimeEntryCollection,
} from '../index.js';

const TABLES = [
  'service_time_entries',
  'service_charge_snapshots',
  'service_compensation_snapshots',
];

/** DDL whose target is `table` (not one that merely references it). */
function targets(statement: string, table: string): boolean {
  return new RegExp(
    `(?:TABLE(?: IF NOT EXISTS)?|ON)\\s+"?${table}"?[\\s(]`,
  ).test(statement);
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      './fixtures/pre-3288-service-evidence-schema.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { schemas: Record<string, ManifestSchemaLike> };

/** Replace the three tables with the exact pre-move shape. */
async function createPreMoveTables(db: DatabaseInterface): Promise<void> {
  for (const table of TABLES) {
    await db.query(`DROP TABLE IF EXISTS "${table}"`);
  }
  const tables = collectManifestTables(
    Object.entries(fixture.schemas).map(([source, schema]) => ({
      schema,
      source,
    })),
  );
  for (const table of tables.values()) {
    const ddl = renderCollectedManifestTable(table, 'sqlite');
    await db.query(ddl.createTable);
    for (const index of ddl.indexes) await db.query(index);
  }
}

const APPROVED_ID = '11111111-1111-4111-8111-111111111111';
const DRAFT_ID = '22222222-2222-4222-8222-222222222222';
const CASE_ID = '33333333-3333-4333-8333-333333333333';
const SPECIALIST_ID = '44444444-4444-4444-8444-444444444444';

/** Rows exactly as the pre-move class wrote them, case context included. */
async function seedPreMoveRows(db: DatabaseInterface): Promise<void> {
  const common = {
    context: '',
    created_at: '2026-07-01T10:00:00.000Z',
    updated_at: '2026-07-01T10:00:00.000Z',
    tenant_id: null,
    participant_kind: 'agent',
    participant_profile_id: null,
    agent_ref: 'agent:builder',
    source: 'agent',
    started_at: null,
    ended_at: null,
    evidence: '[{"kind":"pull_request","ref":"pr:42"}]',
    submitted_by_profile_id: null,
    approved_by_profile_id: null,
    rejected_at: null,
    rejected_by_profile_id: null,
    rejection_reason: '',
    correction_of_id: null,
    metadata: '{}',
  };
  await db.insert('service_time_entries', {
    ...common,
    id: APPROVED_ID,
    slug: APPROVED_ID,
    case_id: CASE_ID,
    specialist_id: SPECIALIST_ID,
    work_ref_type: '@happyvertical/smrt-projects:DevelopmentRequest',
    work_ref_id: 'request-1',
    description: 'Implemented request',
    duration_seconds: 3600,
    status: 'approved',
    submitted_at: '2026-07-01T11:00:00.000Z',
    approved_at: '2026-07-01T12:00:00.000Z',
    approval_path: 'automatic',
  });
  await db.insert('service_time_entries', {
    ...common,
    id: DRAFT_ID,
    slug: DRAFT_ID,
    case_id: CASE_ID,
    specialist_id: null,
    work_ref_type: '@happyvertical/smrt-projects:DevelopmentRequest',
    work_ref_id: 'request-2',
    description: 'Still a draft',
    duration_seconds: 600,
    status: 'draft',
    submitted_at: null,
    approved_at: null,
    approval_path: '',
  });
  await db.insert('service_charge_snapshots', {
    id: '55555555-5555-4555-8555-555555555555',
    slug: 'charge-1',
    context: '',
    created_at: '2026-07-01T12:00:00.000Z',
    updated_at: '2026-07-01T12:00:00.000Z',
    tenant_id: null,
    time_entry_id: APPROVED_ID,
    amount: 15000,
    currency: 'USD',
    pricing_version: 'pricing-v2',
    strategy: 'fixed_unit',
    rate_snapshot: '{"hourlyRate":15000}',
    source_charge_ref: '',
  });
  await db.insert('service_compensation_snapshots', {
    id: '66666666-6666-4666-8666-666666666666',
    slug: 'compensation-1',
    context: '',
    created_at: '2026-07-01T12:00:00.000Z',
    updated_at: '2026-07-01T12:00:00.000Z',
    tenant_id: null,
    time_entry_id: APPROVED_ID,
    amount: 9000,
    currency: 'USD',
    terms_version: 'terms-v4',
    rate_snapshot: '{"hourlyRate":9000}',
  });
}

describe('service time entries moved to smrt-timesheets (#3288)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    await createPreMoveTables(db);
    await seedPreMoveRows(db);
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('keeps every former smrt-projects export importable', () => {
    expect(ServiceTimeEntry).toBe(timesheets.ServiceTimeEntry);
    expect(ServiceTimeEntryCollection).toBe(
      timesheets.ServiceTimeEntryCollection,
    );
    expect(ServiceChargeSnapshot).toBe(timesheets.ServiceChargeSnapshot);
    expect(ServiceChargeSnapshotCollection).toBe(
      timesheets.ServiceChargeSnapshotCollection,
    );
    expect(ServiceCompensationSnapshotCollection).toBe(
      timesheets.ServiceCompensationSnapshotCollection,
    );
    expect(ServiceEvidenceService).toBe(timesheets.ServiceEvidenceService);
  });

  it('loads rows written by the pre-move class through the projects exports', async () => {
    const entries = await ServiceTimeEntryCollection.create({ db });
    const approved = await entries.get(APPROVED_ID);
    expect(approved).toBeInstanceOf(ServiceTimeEntry);
    expect(approved).toMatchObject({
      status: 'approved',
      durationSeconds: 3600,
      workRefType: '@happyvertical/smrt-projects:DevelopmentRequest',
      workRefId: 'request-1',
      participantKind: 'agent',
      agentRef: 'agent:builder',
      approvalPath: 'automatic',
    });
    expect(approved?.getEvidence()).toEqual([
      { kind: 'pull_request', ref: 'pr:42' },
    ]);
    const forWork = await entries.forWork(
      '@happyvertical/smrt-projects:DevelopmentRequest',
      'request-2',
    );
    expect(forWork.map((entry) => entry.id)).toEqual([DRAFT_ID]);

    const charges = await ServiceChargeSnapshotCollection.create({ db });
    const compensation = await ServiceCompensationSnapshotCollection.create({
      db,
    });
    const [charge] = await charges.list({
      where: { timeEntryId: APPROVED_ID },
    });
    const [paid] = await compensation.list({
      where: { timeEntryId: APPROVED_ID },
    });
    // Integer minor units survive unchanged (#2401).
    expect(charge.amount - paid.amount).toBe(6000);
  });

  it('preserves support-only columns it does not model when saving', async () => {
    const entries = await ServiceTimeEntryCollection.create({ db });
    const draft = await entries.get(DRAFT_ID);
    if (!draft) throw new Error('pre-move draft row did not load');
    draft.status = 'submitted';
    await draft.save();

    const row = await db.get('service_time_entries', { id: DRAFT_ID });
    expect(row?.status).toBe('submitted');
    expect(row?.case_id).toBe(CASE_ID);
  });

  it('keeps approved pre-move evidence immutable', async () => {
    const entries = await ServiceTimeEntryCollection.create({ db });
    const approved = await entries.get(APPROVED_ID);
    if (!approved) throw new Error('pre-move approved row did not load');
    approved.durationSeconds = 1;
    await expect(approved.save()).rejects.toThrow(/immutable/i);
  });

  it('plans no DDL against the pre-move tables', async () => {
    const pending = await getPendingSchemaStatements(db, {
      engineHint: 'sqlite',
    });
    const touching = pending.statements.filter((statement) =>
      TABLES.some((table) => targets(statement, table)),
    );
    // The orphaned case_id / specialist_id columns are reported, never
    // altered or dropped.
    expect(touching).toEqual([]);
    expect(
      pending.unactionableChanges.filter((change) =>
        TABLES.includes(String(change.table)),
      ),
    ).toEqual([]);
  });
});
