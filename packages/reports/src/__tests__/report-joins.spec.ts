import {
  GlobalInterceptors,
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
} from '@happyvertical/smrt-core';
import { disableTenancy } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildReportAdapterDescriptor,
  buildReportDrilldownQuery,
} from '../adapter.js';
import { buildReportDefinition, compileReportDefinition } from '../compiler.js';
import { refreshReport } from '../refresh.js';
import { SmrtReport } from '../report.js';
import { reportDefinitionFingerprint } from '../views.js';

class JoinWorkOrder extends SmrtObject {}
class JoinSegment extends SmrtObject {}
class JoinReference extends SmrtObject {}
class JoinLabourReport extends SmrtReport {}
class JoinInnerReport extends SmrtReport {}
class JoinIncrementalReport extends SmrtReport {}
class JoinBadAliasReport extends SmrtReport {}
class JoinSecretReport extends SmrtReport {}
class JoinUnscopedSourceReport extends SmrtReport {}
class JoinUnscopedSource extends SmrtObject {}

const tenancy = {
  type: 'foreignKey',
  related: 'Tenant',
  nullable: true,
  _meta: {
    sqlType: 'UUID',
    __tenancy: { isTenantIdField: true, mode: 'optional' },
  },
};

const secondsBetween = (later: string, earlier: string) => ({
  op: 'secondsBetween' as const,
  later: { col: later },
  earlier: { col: earlier },
});

function field(className: string, name: string, options: object) {
  ObjectRegistry.registerFieldDecorator(className, name, options as never);
}

function reportField(
  className: string,
  name: string,
  type: string,
  report: object,
  extra: object = {},
) {
  field(className, name, { type, __report: report, ...extra });
}

function registerClasses() {
  for (const name of ['JoinWorkOrder', 'JoinSegment']) {
    field(name, 'tenantId', tenancy);
    field(name, 'updatedAt', { type: 'datetime' });
    field(name, 'deletedAt', { type: 'datetime', nullable: true });
  }
  field('JoinWorkOrder', 'title', { type: 'text' });
  field('JoinWorkOrder', 'estimatedHours', { type: 'decimal' });
  field('JoinWorkOrder', 'internalNote', {
    type: 'text',
    readPermission: 'work-orders.notes.read',
  });
  field('JoinSegment', 'workRefId', { type: 'text' });
  field('JoinSegment', 'startedAt', { type: 'datetime' });
  field('JoinSegment', 'endedAt', { type: 'datetime' });
  field('JoinSegment', 'createdAt', { type: 'datetime' });
  field('JoinSegment', 'claimedAt', { type: 'datetime', nullable: true });
  field('JoinSegment', 'halted', { type: 'boolean' });
  field('JoinReference', 'label', { type: 'text' });
  field('JoinUnscopedSource', 'workRefId', { type: 'text' });

  ObjectRegistry.register(JoinWorkOrder, {
    tableName: 'join_work_orders',
    tenantScoped: { mode: 'optional' },
  });
  ObjectRegistry.register(JoinSegment, {
    tableName: 'join_segments',
    tenantScoped: { mode: 'optional' },
  });
  ObjectRegistry.register(JoinReference, { tableName: 'join_references' });
  ObjectRegistry.register(JoinUnscopedSource, {
    tableName: 'join_unscoped_sources',
  });

  const workOrder = {
    source: 'JoinWorkOrder',
    on: 'workRefId',
  };

  for (const name of ['JoinLabourReport', 'JoinInnerReport']) {
    field(name, 'tenantId', tenancy);
  }
  reportField('JoinLabourReport', 'workRefId', 'text', { kind: 'group' });
  reportField('JoinLabourReport', 'workTitle', 'text', {
    kind: 'group',
    sourceColumn: 'wo.title',
  });
  reportField('JoinLabourReport', 'estimatedHours', 'decimal', {
    kind: 'aggregate',
    fn: 'max',
    column: 'wo.estimatedHours',
  });
  reportField('JoinLabourReport', 'segments', 'integer', {
    kind: 'aggregate',
    fn: 'count',
  });
  reportField('JoinLabourReport', 'haltedSegments', 'integer', {
    kind: 'aggregate',
    fn: 'count',
    filter: { op: 'eq', left: { col: 'halted' }, right: { value: true } },
  });
  reportField('JoinLabourReport', 'avgResponseSeconds', 'decimal', {
    kind: 'aggregate',
    fn: 'avg',
    expr: secondsBetween('claimedAt', 'createdAt'),
  });
  // Booked hours as a percentage of the estimate, summed row by row.
  reportField('JoinLabourReport', 'burnPercent', 'decimal', {
    kind: 'aggregate',
    fn: 'sum',
    expr: {
      op: 'mul',
      left: {
        op: 'div',
        left: secondsBetween('endedAt', 'startedAt'),
        right: {
          op: 'mul',
          left: { col: 'wo.estimatedHours' },
          right: { value: 3600 },
        },
      },
      right: { value: 100 },
    },
  });
  ObjectRegistry.register(JoinLabourReport, {
    tableName: 'join_labour_reports',
    tenantScoped: { mode: 'optional' },
    report: { source: 'JoinSegment', joins: { wo: workOrder } },
  });

  reportField('JoinInnerReport', 'workRefId', 'text', { kind: 'group' });
  reportField('JoinInnerReport', 'segments', 'integer', {
    kind: 'aggregate',
    fn: 'count',
  });
  ObjectRegistry.register(JoinInnerReport, {
    tableName: 'join_inner_reports',
    tenantScoped: { mode: 'optional' },
    report: {
      source: 'JoinSegment',
      joins: { wo: { ...workOrder, type: 'inner' } },
    },
  });

  reportField('JoinIncrementalReport', 'workRefId', 'text', { kind: 'group' });
  ObjectRegistry.register(JoinIncrementalReport, {
    tableName: 'join_incremental_reports',
    report: {
      source: 'JoinSegment',
      joins: { wo: workOrder },
      refresh: { mode: 'incremental' },
    },
  });

  reportField('JoinBadAliasReport', 'workTitle', 'text', {
    kind: 'group',
    sourceColumn: 'nope.title',
  });
  ObjectRegistry.register(JoinBadAliasReport, {
    tableName: 'join_bad_alias_reports',
    report: { source: 'JoinSegment', joins: { wo: workOrder } },
  });

  reportField('JoinSecretReport', 'note', 'text', {
    kind: 'group',
    sourceColumn: 'wo.internalNote',
  });
  reportField('JoinSecretReport', 'workRefId', 'text', { kind: 'group' });
  ObjectRegistry.register(JoinSecretReport, {
    tableName: 'join_secret_reports',
    report: { source: 'JoinSegment', joins: { wo: workOrder } },
  });

  reportField('JoinUnscopedSourceReport', 'workRefId', 'text', {
    kind: 'group',
  });
  ObjectRegistry.register(JoinUnscopedSourceReport, {
    tableName: 'join_unscoped_reports',
    report: {
      source: 'JoinUnscopedSource',
      joins: { wo: { source: 'JoinWorkOrder', on: 'workRefId' } },
    },
  });
}

beforeEach(() => {
  ObjectRegistry.clear();
  GlobalInterceptors.clear();
  registerClasses();
});

afterEach(() => {
  disableTenancy();
  GlobalInterceptors.clear();
  ObjectRegistry.clear();
});

const REPORT_COLUMNS = `
  id TEXT PRIMARY KEY, slug TEXT, context TEXT, tenant_id TEXT,
  refreshed_at TEXT, created_at TEXT, updated_at TEXT`;

async function setupDb(): Promise<DatabaseInterface> {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: [],
  });
  await db.query(`CREATE TABLE join_work_orders (
    id TEXT PRIMARY KEY, slug TEXT, context TEXT, tenant_id TEXT, title TEXT,
    estimated_hours REAL, internal_note TEXT, updated_at TEXT, deleted_at TEXT,
    created_at TEXT)`);
  await db.query(`CREATE TABLE join_segments (
    id TEXT PRIMARY KEY, slug TEXT, context TEXT, tenant_id TEXT,
    work_ref_id TEXT, started_at TEXT, ended_at TEXT, created_at TEXT,
    claimed_at TEXT, halted INTEGER, updated_at TEXT, deleted_at TEXT)`);
  await db.query(`CREATE TABLE join_labour_reports (${REPORT_COLUMNS},
    work_ref_id TEXT, work_title TEXT, estimated_hours REAL, segments INTEGER,
    halted_segments INTEGER, avg_response_seconds REAL, burn_percent REAL)`);
  await db.query(`CREATE TABLE join_inner_reports (${REPORT_COLUMNS},
    work_ref_id TEXT, segments INTEGER)`);
  return db;
}

async function workOrder(
  db: DatabaseInterface,
  row: {
    id: string;
    tenantId: string;
    title: string;
    hours: number;
    deletedAt?: string;
  },
) {
  await db.insert('join_work_orders', {
    id: row.id,
    slug: row.id,
    context: '',
    tenant_id: row.tenantId,
    title: row.title,
    estimated_hours: row.hours,
    internal_note: 'private',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted_at: row.deletedAt ?? null,
    created_at: '2026-01-01T00:00:00.000Z',
  });
}

async function segment(
  db: DatabaseInterface,
  row: {
    id: string;
    tenantId: string;
    workRefId: string;
    hours: number;
    halted?: boolean;
    claimedAfterSeconds?: number;
  },
) {
  const created = new Date('2026-01-02T08:00:00.000Z');
  const claimed =
    row.claimedAfterSeconds === undefined
      ? null
      : new Date(created.getTime() + row.claimedAfterSeconds * 1000);
  await db.insert('join_segments', {
    id: row.id,
    slug: row.id,
    context: '',
    tenant_id: row.tenantId,
    work_ref_id: row.workRefId,
    started_at: '2026-01-02T08:00:00.000Z',
    ended_at: new Date(created.getTime() + row.hours * 3600_000).toISOString(),
    created_at: created.toISOString(),
    claimed_at: claimed?.toISOString() ?? null,
    halted: row.halted ? 1 : 0,
    updated_at: '2026-01-02T08:00:00.000Z',
    deleted_at: null,
  });
}

const refresh = (
  report: Parameters<typeof refreshReport>[0],
  db: DatabaseInterface,
  tenantId = 'tenant-a',
) => refreshReport(report, { db, tenantId, lock: false, trackRuns: false });

describe('report joins and row expressions (#3903)', () => {
  it('materialises names, estimates, a conditional count and a row expression', async () => {
    const db = await setupDb();
    await workOrder(db, {
      id: 'wo-1',
      tenantId: 'tenant-a',
      title: 'Gate',
      hours: 10,
    });
    await segment(db, {
      id: 's1',
      tenantId: 'tenant-a',
      workRefId: 'wo-1',
      hours: 2,
      halted: true,
      claimedAfterSeconds: 60,
    });
    await segment(db, {
      id: 's2',
      tenantId: 'tenant-a',
      workRefId: 'wo-1',
      hours: 3,
      claimedAfterSeconds: 180,
    });
    await segment(db, {
      id: 's3',
      tenantId: 'tenant-a',
      workRefId: 'wo-1',
      hours: 1,
    });

    await refresh(JoinLabourReport, db);

    const { rows } = await db.query('SELECT * FROM join_labour_reports');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      work_ref_id: 'wo-1',
      work_title: 'Gate',
      estimated_hours: 10,
      segments: 3,
      halted_segments: 1,
    });
    // (60 + 180) / 2; the unclaimed segment has no response time to average.
    expect(rows[0].avg_response_seconds).toBeCloseTo(120, 3);
    // (2 + 3 + 1) hours booked of a 10 hour estimate.
    expect(rows[0].burn_percent).toBeCloseTo(60, 3);
  });

  it('never matches a related row of another tenant', async () => {
    const db = await setupDb();
    await workOrder(db, {
      id: 'wo-b',
      tenantId: 'tenant-b',
      title: 'Theirs',
      hours: 99,
    });
    await segment(db, {
      id: 's1',
      tenantId: 'tenant-a',
      workRefId: 'wo-b',
      hours: 1,
    });

    await refresh(JoinLabourReport, db);

    const { rows } = await db.query('SELECT * FROM join_labour_reports');
    expect(rows).toHaveLength(1);
    expect(rows[0].work_title).toBeNull();
    expect(rows[0].estimated_hours).toBeNull();
    expect(JSON.stringify(rows)).not.toContain('Theirs');
  });

  it('ignores a soft-deleted related row, keeping the source row on a left join', async () => {
    const db = await setupDb();
    await workOrder(db, {
      id: 'wo-1',
      tenantId: 'tenant-a',
      title: 'Gone',
      hours: 5,
      deletedAt: '2026-01-03T00:00:00.000Z',
    });
    await segment(db, {
      id: 's1',
      tenantId: 'tenant-a',
      workRefId: 'wo-1',
      hours: 1,
    });

    await refresh(JoinLabourReport, db);

    const { rows } = await db.query('SELECT * FROM join_labour_reports');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      work_ref_id: 'wo-1',
      work_title: null,
      segments: 1,
    });
  });

  it('drops source rows with no related row on an inner join', async () => {
    const db = await setupDb();
    await workOrder(db, {
      id: 'wo-1',
      tenantId: 'tenant-a',
      title: 'Gate',
      hours: 5,
    });
    await segment(db, {
      id: 's1',
      tenantId: 'tenant-a',
      workRefId: 'wo-1',
      hours: 1,
    });
    await segment(db, {
      id: 's2',
      tenantId: 'tenant-a',
      workRefId: 'wo-missing',
      hours: 1,
    });

    await refresh(JoinInnerReport, db);

    const { rows } = await db.query(
      'SELECT work_ref_id FROM join_inner_reports',
    );
    expect(rows).toEqual([{ work_ref_id: 'wo-1' }]);
  });

  it('scopes the source to the refreshed tenant even though both tables carry tenant_id', async () => {
    const db = await setupDb();
    await workOrder(db, {
      id: 'wo-a',
      tenantId: 'tenant-a',
      title: 'A',
      hours: 1,
    });
    await workOrder(db, {
      id: 'wo-b',
      tenantId: 'tenant-b',
      title: 'B',
      hours: 1,
    });
    await segment(db, {
      id: 's-a',
      tenantId: 'tenant-a',
      workRefId: 'wo-a',
      hours: 1,
    });
    await segment(db, {
      id: 's-b',
      tenantId: 'tenant-b',
      workRefId: 'wo-b',
      hours: 1,
    });

    await refresh(JoinLabourReport, db, 'tenant-a');

    const { rows } = await db.query(
      'SELECT work_ref_id, tenant_id FROM join_labour_reports',
    );
    expect(rows).toEqual([{ work_ref_id: 'wo-a', tenant_id: 'tenant-a' }]);
  });

  it('compiles the join with the tenant and soft-delete guards in its ON condition', async () => {
    const spec = compileReportDefinition(
      await buildReportDefinition(JoinLabourReport),
    );
    expect(spec.fromAlias).toBe('src');
    expect(spec.joins).toEqual([
      {
        table: 'join_work_orders',
        alias: 'wo',
        type: 'left',
        on: {
          op: 'and',
          operands: [
            {
              op: 'eq',
              left: { col: 'src.work_ref_id' },
              right: { col: 'wo.id' },
            },
            {
              op: 'eq',
              left: { col: 'src.tenant_id' },
              right: { col: 'wo.tenant_id' },
            },
            { op: 'isNull', operand: { col: 'wo.deleted_at' } },
          ],
        },
      },
    ]);
  });

  it('leaves a report without joins exactly as it compiled before', async () => {
    const spec = compileReportDefinition(
      await buildReportDefinition(JoinIncrementalReportNoJoins()),
    );
    expect(spec.fromAlias).toBeUndefined();
    expect(spec.joins).toBeUndefined();
    expect(spec.select).toEqual([{ column: 'work_ref_id', as: 'work_ref_id' }]);
  });

  it('refuses to declare incremental refresh on a joined report', async () => {
    await expect(buildReportDefinition(JoinIncrementalReport)).rejects.toThrow(
      /cannot refresh incrementally/,
    );
  });

  it('rebuilds a joined report when a trigger asks for incremental, so scheduled and on-change refreshes work', async () => {
    const db = await setupDb();
    await workOrder(db, {
      id: 'wo-1',
      tenantId: 'tenant-a',
      title: 'Gate',
      hours: 4,
    });
    await segment(db, {
      id: 's1',
      tenantId: 'tenant-a',
      workRefId: 'wo-1',
      hours: 1,
    });

    const result = await refreshReport(JoinLabourReport, {
      db,
      tenantId: 'tenant-a',
      mode: 'incremental',
      lock: false,
      trackRuns: false,
    });

    expect(result.mode).toBe('rebuild');
    const { rows } = await db.query(
      'SELECT work_title FROM join_labour_reports',
    );
    expect(rows).toEqual([{ work_title: 'Gate' }]);

    // The joined row changing is picked up, which an incremental pass would miss.
    await db.update('join_work_orders', { id: 'wo-1' }, { title: 'Gate v2' });
    await refreshReport(JoinLabourReport, {
      db,
      tenantId: 'tenant-a',
      mode: 'incremental',
      lock: false,
      trackRuns: false,
    });
    expect(
      (await db.query('SELECT work_title FROM join_labour_reports')).rows,
    ).toEqual([{ work_title: 'Gate v2' }]);
  });

  it('does not offer drilldown for a report grouped by a joined column', async () => {
    const descriptor = await buildReportAdapterDescriptor(JoinLabourReport);
    expect(descriptor.drilldown.fields.map((f) => f.sourceColumn)).toEqual([
      'work_ref_id',
    ]);
    await expect(
      buildReportDrilldownQuery(JoinLabourReport, {
        work_ref_id: 'wo-1',
        work_title: 'Gate',
      }),
    ).rejects.toThrow(/groups by a joined or computed value/);
  });

  it('rejects a column that names an undeclared join alias', async () => {
    await expect(buildReportDefinition(JoinBadAliasReport)).rejects.toThrow(
      /not a column of a declared join/,
    );
  });

  it('rejects a tenant-scoped join from a source with no tenant field', async () => {
    await expect(
      buildReportDefinition(JoinUnscopedSourceReport),
    ).rejects.toThrow(
      /tenant-scoped but JoinUnscopedSource has no tenant field/,
    );
  });

  it('withholds a report column that reads a permission-gated joined field', async () => {
    const definition = await buildReportDefinition(JoinSecretReport);
    expect(
      definition.fields.find((f) => f.fieldName === 'note')?.related,
    ).toEqual([
      {
        alias: 'wo',
        fieldName: 'internalNote',
        sensitive: false,
        readPermission: 'work-orders.notes.read',
      },
    ]);
    const descriptor = await buildReportAdapterDescriptor(JoinSecretReport);
    const ids = descriptor.columns.map((column) => column.id);
    expect(ids).toContain('work_ref_id');
    expect(ids).not.toContain('note');
  });

  it('describes a joined column by its qualified source', async () => {
    const descriptor = await buildReportAdapterDescriptor(JoinLabourReport);
    const byId = new Map(
      descriptor.columns.map((column) => [column.id, column]),
    );
    expect(byId.get('work_title')).toMatchObject({
      kind: 'group',
      sourceColumn: 'wo.title',
    });
    expect(byId.get('estimated_hours')).toMatchObject({
      kind: 'aggregate',
      aggregate: 'max',
      sourceColumn: 'wo.estimated_hours',
    });
    expect(byId.get('halted_segments')).toMatchObject({
      kind: 'aggregate',
      aggregate: 'count',
    });
  });

  it('binds the definition fingerprint to expressions, filters and joins', async () => {
    const descriptor = await buildReportAdapterDescriptor(JoinLabourReport);
    const column = (id: string) => descriptor.columns.find((c) => c.id === id);
    expect(column('halted_segments')?.semantics).toContain('"halted"');
    expect(column('work_title')?.semantics).toContain('"join_work_orders"');
    // A plain source column carries nothing extra, so existing fingerprints hold.
    expect(column('work_ref_id')?.semantics).toBeUndefined();

    const before = reportDefinitionFingerprint(descriptor);
    const changed = structuredClone(descriptor);
    const halted = changed.columns.find((c) => c.id === 'halted_segments');
    if (halted) halted.semantics = halted.semantics?.replace('true', 'false');
    expect(reportDefinitionFingerprint(changed)).not.toBe(before);
    expect(reportDefinitionFingerprint(descriptor)).toBe(before);

    // A join no visible column reads still shapes every row.
    const rejoined = structuredClone(descriptor);
    rejoined.semantics = rejoined.semantics?.replace('"left"', '"inner"');
    expect(descriptor.semantics).toContain('"left"');
    expect(reportDefinitionFingerprint(rejoined)).not.toBe(before);
  });

  it('adds nothing to the descriptor of a report without joins', async () => {
    const descriptor = await buildReportAdapterDescriptor(
      JoinIncrementalReportNoJoins(),
    );
    expect(descriptor.semantics).toBeUndefined();
  });
});

function JoinIncrementalReportNoJoins() {
  class JoinPlainReport extends SmrtReport {}
  reportField('JoinPlainReport', 'workRefId', 'text', { kind: 'group' });
  ObjectRegistry.register(JoinPlainReport, {
    tableName: 'join_plain_reports',
    report: { source: 'JoinSegment' },
  });
  return JoinPlainReport;
}
