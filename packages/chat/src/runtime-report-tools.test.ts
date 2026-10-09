import type { PrincipalRun, PrincipalTool } from '@happyvertical/smrt-agents';
import { DataSurfaceDeniedError } from '@happyvertical/smrt-agents';
import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
} from '@happyvertical/smrt-core';
import { RuntimeReportError } from '@happyvertical/smrt-reports';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { SessionPermissionRuntimeContext } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRuntimeReportTools,
  RUNTIME_REPORT_DEFINE_FUNCTION_NAME,
  RUNTIME_REPORT_DEFINE_TOOL_SLUG,
  RUNTIME_REPORT_LIST_TOOL_SLUG,
  RUNTIME_REPORT_RUN_TOOL_SLUG,
  RUNTIME_REPORT_SOURCES_TOOL_SLUG,
  type RuntimeReportAuditEntry,
  type RuntimeReportToolSource,
} from './runtime-report-tools.js';
import { classifyToolError } from './tool-loop.js';

class ToolInvoice extends SmrtObject {}

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

const ALL_TOOLS = [
  RUNTIME_REPORT_SOURCES_TOOL_SLUG,
  RUNTIME_REPORT_DEFINE_TOOL_SLUG,
  RUNTIME_REPORT_LIST_TOOL_SLUG,
  RUNTIME_REPORT_RUN_TOOL_SLUG,
];

const SOURCES: RuntimeReportToolSource[] = [
  { id: 'invoices', className: 'ToolInvoice', collection: 'ToolInvoice' },
];

let db: DatabaseInterface;

function registerFixtures(): void {
  const field = (name: string, def: Record<string, unknown>) =>
    ObjectRegistry.registerFieldDecorator('ToolInvoice', name, def as never);
  field('tenantId', {
    type: 'text',
    nullable: true,
    _meta: { __tenancy: { isTenantIdField: true, mode: 'optional' } },
  });
  field('status', { type: 'text' });
  field('totalAmount', { type: 'integer', format: 'money' });
  field('issuedAt', { type: 'datetime' });
  field('internalNote', { type: 'text', sensitive: true });
  field('margin', { type: 'integer', readPermission: 'finance.margins' });
  ObjectRegistry.register(ToolInvoice, {
    tableName: 'tool_invoices',
    tenantScoped: { mode: 'optional' },
  });
}

async function seed(): Promise<void> {
  await db.query(`
    CREATE TABLE tool_invoices (
      id TEXT PRIMARY KEY, slug TEXT, context TEXT, tenant_id TEXT,
      status TEXT, total_amount INTEGER, issued_at TEXT, internal_note TEXT,
      margin INTEGER, created_at TEXT, updated_at TEXT
    )
  `);
  const rows: [string, string, string, number, number][] = [
    ['i1', TENANT_A, 'paid', 10000, 5],
    ['i2', TENANT_A, 'paid', 25000, 10],
    ['i3', TENANT_A, 'open', 5000, 2],
    ['i4', TENANT_B, 'paid', 7000000, 1],
  ];
  for (const [id, tenant, status, total, margin] of rows) {
    await db.query(
      `INSERT INTO tool_invoices (id, slug, context, tenant_id, status, total_amount, issued_at, internal_note, margin, created_at, updated_at)
       VALUES ($1, $1, '', $2, $3, $4, '2026-01-10T00:00:00.000Z', 'SECRET-NOTE', $5, '2026-01-10T00:00:00.000Z', '2026-01-10T00:00:00.000Z')`,
      id,
      tenant,
      status,
      total,
      margin,
    );
  }
}

interface RunOptions {
  tenantId?: string;
  allowedTools?: string[];
  permissions?: string[];
  /** collection -> allowed actions */
  rbac?: Record<string, string[]>;
}

function fakeRun(options: RunOptions = {}): PrincipalRun {
  const tenantId = options.tenantId ?? TENANT_A;
  const allowedTools = options.allowedTools ?? ALL_TOOLS;
  const permissions = options.permissions ?? [];
  const rbac = options.rbac ?? {
    ToolInvoice: ['read'],
    RuntimeReport: ['read', 'create'],
  };
  return {
    context: {
      userId: USER,
      tenantId,
      database: db,
      permissions,
      permissionSet: new Set(permissions),
      membership: null,
      postgresRls: false,
      session: null,
      sessionId: null,
      superAdminBypass: false,
      systemContext: false,
      user: null,
    } satisfies SessionPermissionRuntimeContext,
    permissions,
    allowedTools,
    isToolAllowed: (tool) => allowedTools.includes(tool),
    assertToolAllowed(tool) {
      if (!allowedTools.includes(tool)) throw new Error(`denied:${tool}`);
    },
    async assertOperation(collection, action) {
      const name = String(collection);
      if (!rbac[name]?.includes(action)) throw new Error('rbac denied');
      return {
        allowed: true,
        permission: `${name}.${action}`,
        reason: 'permission_granted',
      };
    },
  };
}

function toolMap(
  extra: Partial<Parameters<typeof createRuntimeReportTools>[0]> = {},
) {
  const tools = createRuntimeReportTools({ sources: SOURCES, ...extra });
  return new Map(tools.map((tool) => [tool.slug, tool]));
}

async function call(
  tool: PrincipalTool | undefined,
  run: PrincipalRun,
  args: Record<string, unknown> = {},
): Promise<any> {
  if (!tool) throw new Error('tool missing');
  return withTenant({ tenantId: run.context.tenantId as string }, () =>
    tool.execute({ run, args, db }),
  );
}

const SPEC = {
  title: 'Revenue by status',
  source: 'invoices',
  dimensions: [{ field: 'status' }],
  measures: [
    { fn: 'sum', field: 'totalAmount', as: 'revenue' },
    { fn: 'count', as: 'invoices' },
  ],
  sort: [{ by: 'revenue', direction: 'desc' }],
  chart: { type: 'bar', x: 'status', y: ['revenue'] },
};

beforeEach(async () => {
  registerFixtures();
  db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: ['RuntimeReport'],
  });
  await seed();
  enableTenancy();
});

afterEach(() => {
  disableTenancy();
});

describe('createRuntimeReportTools', () => {
  it('exposes four principal tools with stable slugs, names and strict schemas', () => {
    const tools = createRuntimeReportTools({ sources: SOURCES });
    expect(tools.map((t) => t.slug)).toEqual(ALL_TOOLS);
    for (const tool of tools) {
      expect(tool.aiTool.function.name).toBe(tool.slug.replaceAll('.', '-'));
      expect(
        (tool.aiTool.function.parameters as { additionalProperties?: boolean })
          .additionalProperties,
      ).toBe(false);
    }
    const define = tools.find(
      (t) => t.slug === RUNTIME_REPORT_DEFINE_TOOL_SLUG,
    );
    expect(define?.aiTool.function.name).toBe(
      RUNTIME_REPORT_DEFINE_FUNCTION_NAME,
    );
    // The schema carries no free-form SQL/expression/table parameter.
    const text = JSON.stringify(define?.aiTool.function.parameters);
    expect(text).not.toMatch(/"(sql|where|table|query|expression|tenantId)":/);
  });

  it('every tool enforces the fail-closed allow-list', async () => {
    const tools = toolMap();
    for (const slug of ALL_TOOLS) {
      const run = fakeRun({
        allowedTools: ALL_TOOLS.filter((t) => t !== slug),
      });
      await expect(
        call(tools.get(slug), run, {
          phase: 'preview',
          spec: SPEC,
          reportId: 'x',
        }),
      ).rejects.toThrow(`denied:${slug}`);
    }
    await expect(
      call(
        tools.get(RUNTIME_REPORT_SOURCES_TOOL_SLUG),
        fakeRun({ allowedTools: [] }),
      ),
    ).rejects.toThrow('denied:');
  });

  describe('reports.runtime.sources', () => {
    it('lists only the fields the principal may use', async () => {
      const tools = toolMap();
      const out = await call(
        tools.get(RUNTIME_REPORT_SOURCES_TOOL_SLUG),
        fakeRun(),
      );
      expect(out.sources).toHaveLength(1);
      const names = out.sources[0].fields.map((f: { name: string }) => f.name);
      expect(names).toEqual(expect.arrayContaining(['status', 'totalAmount']));
      expect(names).not.toContain('internalNote');
      expect(names).not.toContain('margin');
      expect(names).not.toContain('tenantId');
      const privileged = await call(
        tools.get(RUNTIME_REPORT_SOURCES_TOOL_SLUG),
        fakeRun({ permissions: ['finance.margins'] }),
      );
      expect(
        privileged.sources[0].fields.map((f: { name: string }) => f.name),
      ).toContain('margin');
      expect(JSON.stringify(out)).not.toContain('SECRET-NOTE');
    });

    it('omits sources the principal cannot read', async () => {
      const out = await call(
        toolMap().get(RUNTIME_REPORT_SOURCES_TOOL_SLUG),
        fakeRun({ rbac: { RuntimeReport: ['read'] } }),
      );
      expect(out.sources).toEqual([]);
    });
  });

  describe('reports.runtime.define', () => {
    const define = () => toolMap().get(RUNTIME_REPORT_DEFINE_TOOL_SLUG);

    it('previews without saving anything', async () => {
      const tools = toolMap();
      const out = await call(
        tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG),
        fakeRun(),
        {
          phase: 'preview',
          spec: SPEC,
        },
      );
      expect(out).toMatchObject({
        phase: 'preview',
        saved: false,
        requiresConfirmation: true,
      });
      expect(out.specHash).toMatch(/^[0-9a-f]{64}$/);
      expect(out.result.rows).toEqual([
        { status: 'paid', revenue: 35000, invoices: 2 },
        { status: 'open', revenue: 5000, invoices: 1 },
      ]);
      expect(out.result.chart).toEqual(SPEC.chart);
      const listed = await call(
        tools.get(RUNTIME_REPORT_LIST_TOOL_SLUG),
        fakeRun(),
      );
      expect(listed.reports).toEqual([]);
    });

    it('bounds preview rows', async () => {
      const tools = toolMap({ previewRows: 1 });
      const out = await call(
        tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG),
        fakeRun(),
        {
          phase: 'preview',
          spec: SPEC,
        },
      );
      expect(out.result.rows).toHaveLength(1);
      expect(out.result.truncated).toBe(true);
    });

    it('rejects hidden fields, unknown sources and malformed specs as repairable errors', async () => {
      const bad: Record<string, unknown>[] = [
        { ...SPEC, dimensions: [{ field: 'internalNote' }] },
        {
          ...SPEC,
          filters: [{ field: 'tenantId', op: 'eq', value: TENANT_B }],
        },
        { ...SPEC, source: 'users' },
        {
          ...SPEC,
          dimensions: [{ field: "status'; DROP TABLE tool_invoices;--" }],
        },
        { ...SPEC, measures: [{ fn: 'count', as: 'x" OR 1=1 --' }] },
        { ...SPEC, where: '1=1' },
        { ...SPEC, sql: 'SELECT * FROM users' },
        'SELECT * FROM users',
      ];
      for (const spec of bad) {
        const error = await call(define(), fakeRun(), {
          phase: 'preview',
          spec,
        }).catch((e) => e);
        expect(error).toBeInstanceOf(RuntimeReportError);
        expect(classifyToolError(error)).toBe('invalid_request');
      }
      const survivors = await db.query(
        'SELECT COUNT(*) AS n FROM tool_invoices',
      );
      expect(Number((survivors.rows[0] as { n: unknown }).n)).toBe(4);
    });

    it('denies a source the principal may not read, indistinguishably', async () => {
      const denied = await call(
        define(),
        fakeRun({ rbac: { RuntimeReport: ['read', 'create'] } }),
        {
          phase: 'preview',
          spec: SPEC,
        },
      ).catch((e) => e);
      expect(denied).toBeInstanceOf(DataSurfaceDeniedError);
    });

    it('rejects an invalid phase', async () => {
      await expect(
        call(define(), fakeRun(), { phase: 'save', spec: SPEC }),
      ).rejects.toThrow(RuntimeReportError);
    });

    describe('apply', () => {
      it('refuses to save without a confirmation host (propose-only)', async () => {
        const tools = toolMap();
        const preview = await call(
          tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG),
          fakeRun(),
          {
            phase: 'preview',
            spec: SPEC,
          },
        );
        const error = await call(
          tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG),
          fakeRun(),
          {
            phase: 'apply',
            spec: SPEC,
            specHash: preview.specHash,
            // A model asserting consent is not consent.
            confirmed: true,
          },
        ).catch((e) => e);
        expect(error).toBeInstanceOf(RuntimeReportError);
        expect(error.message).toMatch(/confirmation/);
        const listed = await call(
          tools.get(RUNTIME_REPORT_LIST_TOOL_SLUG),
          fakeRun(),
        );
        expect(listed.reports).toEqual([]);
      });

      it('requires the hash of the previewed spec', async () => {
        const confirmSave = vi.fn();
        const tools = toolMap({ confirmation: { confirmSave } });
        for (const specHash of [undefined, 'f'.repeat(64), '', 5]) {
          await expect(
            call(tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG), fakeRun(), {
              phase: 'apply',
              spec: SPEC,
              specHash,
            }),
          ).rejects.toThrow(/specHash/);
        }
        // Editing the spec after the preview invalidates the confirmation.
        const preview = await call(
          tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG),
          fakeRun(),
          {
            phase: 'preview',
            spec: SPEC,
          },
        );
        await expect(
          call(tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG), fakeRun(), {
            phase: 'apply',
            spec: { ...SPEC, limit: 999 },
            specHash: preview.specHash,
          }),
        ).rejects.toThrow(/specHash/);
        expect(confirmSave).not.toHaveBeenCalled();
      });

      it('does not save when the human denies', async () => {
        const confirmSave = vi
          .fn()
          .mockRejectedValue(new Error('user declined'));
        const tools = toolMap({ confirmation: { confirmSave } });
        const preview = await call(
          tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG),
          fakeRun(),
          {
            phase: 'preview',
            spec: SPEC,
          },
        );
        await expect(
          call(tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG), fakeRun(), {
            phase: 'apply',
            spec: SPEC,
            specHash: preview.specHash,
          }),
        ).rejects.toThrow('user declined');
        expect(
          (await call(tools.get(RUNTIME_REPORT_LIST_TOOL_SLUG), fakeRun()))
            .reports,
        ).toEqual([]);
      });

      it('requires the create permission on stored reports', async () => {
        const confirmSave = vi.fn();
        const tools = toolMap({ confirmation: { confirmSave } });
        const run = fakeRun({
          rbac: { ToolInvoice: ['read'], RuntimeReport: ['read'] },
        });
        const preview = await call(
          tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG),
          run,
          {
            phase: 'preview',
            spec: SPEC,
          },
        );
        await expect(
          call(tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG), run, {
            phase: 'apply',
            spec: SPEC,
            specHash: preview.specHash,
          }),
        ).rejects.toBeInstanceOf(DataSurfaceDeniedError);
        expect(confirmSave).not.toHaveBeenCalled();
      });

      it('saves after confirmation, binds the host to the exact spec, and audits', async () => {
        const audit: RuntimeReportAuditEntry[] = [];
        const confirmSave = vi.fn().mockResolvedValue(undefined);
        const tools = toolMap({
          confirmation: { confirmSave },
          audit: (entry) => {
            audit.push(entry);
          },
        });
        const preview = await call(
          tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG),
          fakeRun(),
          {
            phase: 'preview',
            spec: SPEC,
          },
        );
        const saved = await call(
          tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG),
          fakeRun(),
          {
            phase: 'apply',
            spec: SPEC,
            specHash: preview.specHash,
          },
        );
        expect(saved).toMatchObject({
          phase: 'apply',
          saved: true,
          title: 'Revenue by status',
          specHash: preview.specHash,
        });
        expect(confirmSave).toHaveBeenCalledTimes(1);
        expect(confirmSave.mock.calls[0][0]).toMatchObject({
          specHash: preview.specHash,
          spec: expect.objectContaining({ title: 'Revenue by status' }),
        });
        expect(audit.map((e) => e.action)).toEqual(['preview', 'save']);
        expect(
          audit.every((e) => e.userId === USER && e.tenantId === TENANT_A),
        ).toBe(true);

        const listed = await call(
          tools.get(RUNTIME_REPORT_LIST_TOOL_SLUG),
          fakeRun(),
        );
        expect(listed.reports).toHaveLength(1);
        expect(listed.reports[0]).toMatchObject({
          id: saved.reportId,
          title: 'Revenue by status',
          runnable: true,
        });
      });
    });
  });

  describe('list and run', () => {
    async function save(
      tools = toolMap({ confirmation: { confirmSave: async () => {} } }),
    ) {
      const preview = await call(
        tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG),
        fakeRun(),
        {
          phase: 'preview',
          spec: SPEC,
        },
      );
      const saved = await call(
        tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG),
        fakeRun(),
        {
          phase: 'apply',
          spec: SPEC,
          specHash: preview.specHash,
        },
      );
      return { tools, saved };
    }

    it('runs a saved report by id or slug under the live principal', async () => {
      const { tools, saved } = await save();
      for (const reportId of [saved.reportId, saved.slug]) {
        const out = await call(
          tools.get(RUNTIME_REPORT_RUN_TOOL_SLUG),
          fakeRun(),
          {
            reportId,
          },
        );
        expect(out.result.rows).toEqual([
          { status: 'paid', revenue: 35000, invoices: 2 },
          { status: 'open', revenue: 5000, invoices: 1 },
        ]);
        expect(out.result.specHash).toBe(saved.specHash);
      }
    });

    it('is tenant isolated for list, run and the data itself', async () => {
      const { tools, saved } = await save();
      const runB = fakeRun({ tenantId: TENANT_B });
      expect(
        (await call(tools.get(RUNTIME_REPORT_LIST_TOOL_SLUG), runB)).reports,
      ).toEqual([]);
      await expect(
        call(tools.get(RUNTIME_REPORT_RUN_TOOL_SLUG), runB, {
          reportId: saved.reportId,
        }),
      ).rejects.toBeInstanceOf(DataSurfaceDeniedError);
    });

    it('re-validates on every run: lost source access is denied and flagged in list', async () => {
      const { tools, saved } = await save();
      const noSource = fakeRun({
        rbac: { RuntimeReport: ['read'], ToolInvoice: [] },
      });
      await expect(
        call(tools.get(RUNTIME_REPORT_RUN_TOOL_SLUG), noSource, {
          reportId: saved.reportId,
        }),
      ).rejects.toBeInstanceOf(DataSurfaceDeniedError);
      const listed = await call(
        tools.get(RUNTIME_REPORT_LIST_TOOL_SLUG),
        noSource,
      );
      expect(listed.reports[0].runnable).toBe(false);
    });

    it('re-validates field policy on every run', async () => {
      const tools = toolMap({ confirmation: { confirmSave: async () => {} } });
      const privileged = fakeRun({ permissions: ['finance.margins'] });
      const spec = {
        title: 'Margin',
        source: 'invoices',
        measures: [{ fn: 'sum', field: 'margin', as: 'total_margin' }],
      };
      const preview = await call(
        tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG),
        privileged,
        {
          phase: 'preview',
          spec,
        },
      );
      expect(preview.result.rows).toEqual([{ total_margin: 17 }]);
      const saved = await call(
        tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG),
        privileged,
        {
          phase: 'apply',
          spec,
          specHash: preview.specHash,
        },
      );
      const viewer = fakeRun();
      const error = await call(
        tools.get(RUNTIME_REPORT_RUN_TOOL_SLUG),
        viewer,
        {
          reportId: saved.reportId,
        },
      ).catch((e) => e);
      expect(error).toBeInstanceOf(RuntimeReportError);
      expect(error.code).toBe('unknown_field');
      // The same stored report still runs for the privileged principal.
      const again = await call(
        tools.get(RUNTIME_REPORT_RUN_TOOL_SLUG),
        privileged,
        {
          reportId: saved.reportId,
        },
      );
      expect(again.result.rows).toEqual([{ total_margin: 17 }]);
    });

    it('answers a missing report like an inaccessible one and rejects bad ids', async () => {
      const tools = toolMap();
      await expect(
        call(tools.get(RUNTIME_REPORT_RUN_TOOL_SLUG), fakeRun(), {
          reportId: 'does-not-exist',
        }),
      ).rejects.toBeInstanceOf(DataSurfaceDeniedError);
      for (const reportId of [undefined, '', 5, {}, "x' OR 1=1 --"]) {
        await expect(
          call(tools.get(RUNTIME_REPORT_RUN_TOOL_SLUG), fakeRun(), {
            reportId,
          }),
        ).rejects.toThrow();
      }
    });

    it('requires read access to stored reports', async () => {
      const { tools, saved } = await save();
      const noRead = fakeRun({ rbac: { ToolInvoice: ['read'] } });
      await expect(
        call(tools.get(RUNTIME_REPORT_LIST_TOOL_SLUG), noRead),
      ).rejects.toBeInstanceOf(DataSurfaceDeniedError);
      await expect(
        call(tools.get(RUNTIME_REPORT_RUN_TOOL_SLUG), noRead, {
          reportId: saved.reportId,
        }),
      ).rejects.toBeInstanceOf(DataSurfaceDeniedError);
    });

    it('caps rows on a stored-report run', async () => {
      const { tools, saved } = await save(
        toolMap({ maxRows: 1, confirmation: { confirmSave: async () => {} } }),
      );
      const out = await call(
        tools.get(RUNTIME_REPORT_RUN_TOOL_SLUG),
        fakeRun(),
        {
          reportId: saved.reportId,
        },
      );
      expect(out.result.rows).toHaveLength(1);
      expect(out.result.truncated).toBe(true);
    });
  });

  it('accepts a per-run source resolver', async () => {
    const resolver = vi.fn().mockResolvedValue(SOURCES);
    const tools = new Map(
      createRuntimeReportTools({ sources: resolver }).map((t) => [t.slug, t]),
    );
    const run = fakeRun();
    await call(tools.get(RUNTIME_REPORT_SOURCES_TOOL_SLUG), run);
    expect(resolver).toHaveBeenCalledWith(run);
  });
});
