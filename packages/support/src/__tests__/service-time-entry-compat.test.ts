/**
 * #3288 compatibility: the shared time entry moved to
 * `@happyvertical/smrt-timesheets`, and `caseId` / `specialistId` now live
 * only on smrt-support's subtype. A `service_time_entries` table built from
 * the pre-move smrt-support schema must keep loading — through support's
 * subtype with its case context, and through the shared entry every package
 * exports — with no schema change and no executable migration.
 *
 * `fixtures/pre-3288-service-time-entry-schema.json` is the schema section of
 * smrt-support's built manifest at 02590837 (the commit before the move).
 * The migration plan for the same table is checked on the CLI's manifest
 * path in `service-time-entry-migration-plan.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  collectManifestTables,
  type ManifestSchemaLike,
  renderCollectedManifestTable,
} from '@happyvertical/smrt-core/schema';
import * as projects from '@happyvertical/smrt-projects';
import * as timesheets from '@happyvertical/smrt-timesheets';
import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SERVICE_TIME_ENTRY_STATUS_TRANSITIONS,
  ServiceTimeEntry,
  ServiceTimeEntryCollection,
  SupportCaseService,
  SupportSpecialistCollection,
} from '../index.js';

const TABLE = 'service_time_entries';

const timesheetsManifest = JSON.parse(
  readFileSync(
    createRequire(import.meta.url).resolve(
      '@happyvertical/smrt-timesheets/manifest.json',
    ),
    'utf8',
  ),
) as { objects: Record<string, unknown> };

const fixture = JSON.parse(
  readFileSync(
    new URL(
      './fixtures/pre-3288-service-time-entry-schema.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { schemas: Record<string, ManifestSchemaLike> };

/** Replace the table with the exact pre-move shape. */
async function createPreMoveTable(db: DatabaseInterface): Promise<void> {
  await db.query(`DROP TABLE IF EXISTS "${TABLE}"`);
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

const MODEL_NAMES = [
  'SupportCase',
  'SupportInteraction',
  'SupportCaseEvent',
  'SupportSpecialist',
  'ServiceTimeEntry',
];

describe('support time entries after the smrt-timesheets move (#3288)', () => {
  let ctx: Awaited<ReturnType<typeof createIsolatedTestDbFromManifest>>;
  let db: DatabaseInterface;
  let caseId: string;
  let specialistId: string;

  beforeEach(async () => {
    ctx = await createIsolatedTestDbFromManifest({
      includeObjects: MODEL_NAMES,
    });
    db = ctx.db;
    await createPreMoveTable(db);

    const cases = await SupportCaseService.create({ db });
    const supportCase = await cases.openCase({ subject: 'pre-move case' });
    caseId = supportCase.id ?? '';
    const specialists = await SupportSpecialistCollection.create({ db });
    const specialist = await specialists.create({
      profileId: 'profile-1',
      displayName: 'Ada',
      status: 'active',
      timezone: 'UTC',
      maxConcurrentCases: 5,
      languages: '["en"]',
    });
    await specialist.save();
    specialistId = specialist.id ?? '';

    // A row exactly as the pre-move support class wrote it.
    await db.insert(TABLE, {
      id: APPROVED_ID,
      slug: APPROVED_ID,
      context: '',
      created_at: '2026-07-01T10:00:00.000Z',
      updated_at: '2026-07-01T10:00:00.000Z',
      tenant_id: null,
      case_id: caseId,
      work_ref_type: null,
      work_ref_id: null,
      specialist_id: specialistId,
      participant_kind: 'human',
      participant_profile_id: null,
      agent_ref: '',
      source: 'timer',
      description: 'Debugged the login loop',
      started_at: '2026-07-01T10:00:00.000Z',
      ended_at: '2026-07-01T11:30:00.000Z',
      duration_seconds: 5400,
      evidence: '[]',
      status: 'approved',
      submitted_at: '2026-07-01T11:31:00.000Z',
      submitted_by_profile_id: null,
      approved_at: '2026-07-01T12:00:00.000Z',
      approved_by_profile_id: null,
      approval_path: 'operator',
      rejected_at: null,
      rejected_by_profile_id: null,
      rejection_reason: '',
      correction_of_id: null,
      metadata: '{}',
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('keeps the support subtype a subclass of the shared entry', () => {
    expect(ServiceTimeEntry.prototype).toBeInstanceOf(
      timesheets.ServiceTimeEntry,
    );
    expect(projects.ServiceTimeEntry).toBe(timesheets.ServiceTimeEntry);
    expect(SERVICE_TIME_ENTRY_STATUS_TRANSITIONS).toBe(
      timesheets.SERVICE_TIME_ENTRY_STATUS_TRANSITIONS,
    );
    // The base entry carries no support-specific reference.
    const base = timesheetsManifest.objects[
      '@happyvertical/smrt-timesheets:ServiceTimeEntry'
    ] as { fields: Record<string, unknown> };
    expect(Object.keys(base.fields)).toEqual(
      expect.arrayContaining(['workRefType', 'workRefId', 'participantKind']),
    );
    expect(base.fields).not.toHaveProperty('caseId');
    expect(base.fields).not.toHaveProperty('specialistId');
    const support = ObjectRegistry.getFields(
      '@happyvertical/smrt-support:ServiceTimeEntry',
    );
    expect(support.has('caseId')).toBe(true);
    expect(support.has('specialistId')).toBe(true);
  });

  it('loads a pre-move row through the support subtype with its case context', async () => {
    const entries = await ServiceTimeEntryCollection.create({ db });
    const [entry] = await entries.forCase(caseId);
    expect(entry).toBeInstanceOf(ServiceTimeEntry);
    expect(entry).toMatchObject({
      id: APPROVED_ID,
      caseId,
      specialistId,
      status: 'approved',
      durationSeconds: 5400,
      source: 'timer',
    });
    expect(await entries.forSpecialist(specialistId)).toHaveLength(1);
  });

  it('loads the same row through the shared entry from smrt-projects', async () => {
    const entries = await projects.ServiceTimeEntryCollection.create({ db });
    const entry = await entries.get(APPROVED_ID);
    expect(entry).toMatchObject({
      status: 'approved',
      durationSeconds: 5400,
      description: 'Debugged the login loop',
    });
  });

  it('freezes the case context with the rest of approved evidence', async () => {
    const entries = await ServiceTimeEntryCollection.create({ db });
    const entry = await entries.get(APPROVED_ID);
    if (!entry) throw new Error('pre-move row did not load');
    entry.caseId = null;
    await expect(entry.save()).rejects.toThrow(/immutable/i);
  });
});
