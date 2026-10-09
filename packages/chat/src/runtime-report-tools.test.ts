import type { PrincipalRun, PrincipalTool } from '@happyvertical/smrt-agents';
import {
  DataSurfaceDeniedError,
  PrincipalToolNotAllowedError,
} from '@happyvertical/smrt-agents';
import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
} from '@happyvertical/smrt-core';
import { RuntimeReport, RuntimeReportError } from '@happyvertical/smrt-reports';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  assertOperationPermission,
  deriveOperationPermissionSlug,
  PermissionCatalogService,
  type SessionPermissionRuntimeContext,
} from '@happyvertical/smrt-users';
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
import {
  buildManifestToolCatalog,
  classifyToolError,
  invokeManifestTool,
} from './tool-loop.js';

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

/**
 * The catalog collection slug of the fixture source, read from the generated
 * catalog after fixtures register (never typed by hand).
 */
let invoiceCollection = '';
let sources: RuntimeReportToolSource[] = [];

let db: DatabaseInterface;

async function registerFixtures(): Promise<void> {
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
  // A runtime-registered (manifest-less) class only settles on the catalog's
  // slug once its schema has been synthesized; do that before reading slugs.
  await ObjectRegistry.getAllFields('ToolInvoice');
  invoiceCollection = catalogSlug('ToolInvoice', 'read').replace(/\.read$/, '');
  sources = [
    { id: 'invoices', className: 'ToolInvoice', collection: invoiceCollection },
  ];
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
  tenantId?: string | null;
  allowedTools?: string[];
  permissions?: string[];
  /** model name -> allowed actions; granted as REAL catalog permission slugs */
  rbac?: Record<string, string[]>;
}

/**
 * The catalog slug for `(model, action)`, read from the GENERATED permission
 * catalog by class name. It is deliberately independent of the guard's
 * derivation helpers: a tool that asks the guard about a slug the catalog does
 * not contain is denied (`unknown_permission`) and fails the suite.
 */
function catalogSlug(model: string, action: string): string {
  const entry = PermissionCatalogService.create()
    .getCatalog()
    .permissions.find(
      (p) => p.className === model && p.slug === `${p.collection}.${action}`,
    );
  if (!entry) throw new Error(`no catalog slug for ${model}.${action}`);
  return entry.slug;
}

/** Published permission set for `rbac`, as REAL catalog permission slugs. */
function grantedSlugs(rbac: Record<string, string[]>): Set<string> {
  const granted = new Set<string>();
  for (const [model, actions] of Object.entries(rbac)) {
    for (const action of actions) granted.add(catalogSlug(model, action));
  }
  return granted;
}

function fakeRun(options: RunOptions = {}): PrincipalRun {
  const tenantId = options.tenantId === undefined ? TENANT_A : options.tenantId;
  const allowedTools = options.allowedTools ?? ALL_TOOLS;
  const permissions = options.permissions ?? [];
  const rbac = options.rbac ?? {
    ToolInvoice: ['read'],
    RuntimeReport: ['read', 'create'],
  };
  const permissionSet = grantedSlugs(rbac);
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
    // The REAL catalog guard (same call `executeAsPrincipal` makes), so a
    // collection slug that is not in the generated catalog is denied here
    // exactly as it is in production.
    async assertOperation(collection, action) {
      return assertOperationPermission({
        collection,
        action,
        userId: USER,
        tenantId: tenantId ?? undefined,
        permissionSet,
      });
    },
  };
}

function toolMap(
  extra: Partial<Parameters<typeof createRuntimeReportTools>[0]> = {},
) {
  const tools = createRuntimeReportTools({ sources, ...extra });
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
  await registerFixtures();
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
    const tools = createRuntimeReportTools({ sources });
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

    it('answers a configured-but-unreadable source exactly like an unknown id (no source-id oracle)', async () => {
      const unreadable = fakeRun({
        rbac: { RuntimeReport: ['read', 'create'] },
      });
      const probe = (sourceId: string) =>
        call(define(), unreadable, {
          phase: 'preview',
          spec: { ...SPEC, source: sourceId },
        }).catch((e) => e);
      const configured = await probe('invoices');
      const unknown = await probe('no_such_source');
      for (const error of [configured, unknown]) {
        expect(error).toBeInstanceOf(RuntimeReportError);
        expect(classifyToolError(error)).toBe('invalid_request');
      }
      // Same error class, code, path, status and message once the id the
      // caller supplied is factored out of the text.
      const shape = (error: RuntimeReportError, id: string) => ({
        name: error.constructor.name,
        code: error.code,
        path: error.path,
        status: error.status,
        message: error.message.replaceAll(id, '<id>'),
      });
      expect(shape(configured, 'invoices')).toEqual(
        shape(unknown, 'no_such_source'),
      );
      expect(configured.message).not.toMatch(
        /permission|not permitted|denied/i,
      );
    });

    it('a readable principal still previews the same source', async () => {
      const out = await call(define(), fakeRun(), {
        phase: 'preview',
        spec: SPEC,
      });
      expect(out.phase).toBe('preview');
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

    it('re-validates on every run: lost source access is refused and flagged in list', async () => {
      const { tools, saved } = await save();
      const noSource = fakeRun({
        rbac: { RuntimeReport: ['read'], ToolInvoice: [] },
      });
      const error = await call(
        tools.get(RUNTIME_REPORT_RUN_TOOL_SLUG),
        noSource,
        {
          reportId: saved.reportId,
        },
      ).catch((e) => e);
      // Not distinguishable from a source the host never configured.
      expect(error).toBeInstanceOf(RuntimeReportError);
      expect(error.code).toBe('unknown_source');
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

  describe('permission collection slugs (real catalog guard)', () => {
    it('the default stored-report slugs exist in the generated permission catalog', () => {
      const catalog = PermissionCatalogService.create().getCatalog();
      const slugs = new Set(catalog.permissions.map((p) => p.slug));
      for (const action of ['read', 'create']) {
        const slug = deriveOperationPermissionSlug(RuntimeReport, action);
        expect(slugs.has(slug), `${slug} is in the catalog`).toBe(true);
      }
      // A class-name string is used verbatim and matches no catalog slug.
      expect(slugs.has('RuntimeReport.read')).toBe(false);
      expect(slugs.has('ToolInvoice.read')).toBe(false);
      expect(slugs.has(`${invoiceCollection}.read`)).toBe(true);
    });

    it('list, run and apply work under the real guard with the default collection', async () => {
      const tools = toolMap({ confirmation: { confirmSave: async () => {} } });
      const run = fakeRun();
      const preview = await call(
        tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG),
        run,
        { phase: 'preview', spec: SPEC },
      );
      const saved = await call(
        tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG),
        run,
        { phase: 'apply', spec: SPEC, specHash: preview.specHash },
      );
      expect(
        (await call(tools.get(RUNTIME_REPORT_LIST_TOOL_SLUG), run)).reports,
      ).toHaveLength(1);
      expect(
        (
          await call(tools.get(RUNTIME_REPORT_RUN_TOOL_SLUG), run, {
            reportId: saved.reportId,
          })
        ).result.rows,
      ).toHaveLength(2);
    });

    it('grants for the catalog slug of a different action do not leak', async () => {
      const tools = toolMap({ confirmation: { confirmSave: async () => {} } });
      // read on the reports collection only: the apply step needs create.
      const run = fakeRun({
        rbac: { ToolInvoice: ['read'], RuntimeReport: ['read'] },
      });
      const preview = await call(
        tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG),
        run,
        { phase: 'preview', spec: SPEC },
      );
      await expect(
        call(tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG), run, {
          phase: 'apply',
          spec: SPEC,
          specHash: preview.specHash,
        }),
      ).rejects.toBeInstanceOf(DataSurfaceDeniedError);
    });

    it('a class-name string is NOT a catalog slug: source is not offered, stored reports are denied', async () => {
      const wrongSources: RuntimeReportToolSource[] = [
        { id: 'invoices', className: 'ToolInvoice', collection: 'ToolInvoice' },
      ];
      const offered = await call(
        new Map(
          createRuntimeReportTools({ sources: wrongSources }).map((t) => [
            t.slug,
            t,
          ]),
        ).get(RUNTIME_REPORT_SOURCES_TOOL_SLUG),
        fakeRun(),
      );
      expect(offered.sources).toEqual([]);

      const wrongReports = toolMap({ reportsCollection: 'RuntimeReport' });
      await expect(
        call(wrongReports.get(RUNTIME_REPORT_LIST_TOOL_SLUG), fakeRun()),
      ).rejects.toBeInstanceOf(DataSurfaceDeniedError);
    });

    it('accepts a registered model class as a source collection', async () => {
      // A manifest-backed class resolves through the catalog's own helper, so
      // the read gate follows the class rather than a hand-typed slug. (The
      // gate target here is RuntimeReport purely because it is manifest-backed.)
      const classSources: RuntimeReportToolSource[] = [
        { id: 'invoices', className: 'ToolInvoice', collection: RuntimeReport },
      ];
      const sourcesTool = new Map(
        createRuntimeReportTools({ sources: classSources }).map((t) => [
          t.slug,
          t,
        ]),
      ).get(RUNTIME_REPORT_SOURCES_TOOL_SLUG);
      const granted = await call(
        sourcesTool,
        fakeRun({ rbac: { RuntimeReport: ['read'] } }),
      );
      expect(granted.sources).toHaveLength(1);
      const denied = await call(
        sourcesTool,
        fakeRun({ rbac: { ToolInvoice: ['read'] } }),
      );
      expect(denied.sources).toEqual([]);
    });
  });

  describe('stored report write surface', () => {
    const runtimeReportCatalog = () =>
      PermissionCatalogService.create()
        .getCatalog()
        .permissions.filter((p) => p.className === 'RuntimeReport');

    it('the catalog enables exactly read and create for RuntimeReport', () => {
      const entries = runtimeReportCatalog();
      expect(
        entries.map((p) => p.slug.slice(p.collection?.length)).sort(),
      ).toEqual(['.create', '.read']);
      // update/delete are never grantable, so no role, RLS binding or
      // persona allowedTools entry can name them.
      expect(entries.some((p) => /\.(update|delete)$/.test(p.slug))).toBe(
        false,
      );
    });

    it('the manifest tool catalog offers RuntimeReport read only, even when update/delete/create are allow-listed', () => {
      const slugs = runtimeReportCatalog().map((p) => p.slug);
      const named = [
        ...slugs,
        ...slugs.map((s) => s.replace(/\.\w+$/, '.update')),
        ...slugs.map((s) => s.replace(/\.\w+$/, '.delete')),
      ];
      const offered = buildManifestToolCatalog({ allowedTools: named });
      expect(offered.filter((t) => t.className === 'RuntimeReport')).toEqual([
        expect.objectContaining({ action: 'read' }),
      ]);
    });

    it('invokeManifestTool refuses create/update/delete of RuntimeReport and writes nothing', async () => {
      const entry = runtimeReportCatalog()[0];
      const collection = entry.collection as string;
      const spec = {
        title: 'Injected',
        source: 'invoices',
        measures: [{ fn: 'count' }],
      };
      for (const action of ['create', 'update', 'delete']) {
        const slug = `${collection}.${action}`;
        const run = fakeRun({
          allowedTools: [...ALL_TOOLS, slug],
          rbac: {
            ToolInvoice: ['read'],
            RuntimeReport: ['read', 'create'],
          },
        });
        await expect(
          withTenant({ tenantId: TENANT_A }, () =>
            invokeManifestTool(
              run,
              {
                slug,
                collection,
                className: 'RuntimeReport',
                qualifiedName: entry.qualifiedName,
                action,
              },
              {
                id: 'x',
                title: 'Injected',
                spec: JSON.stringify(spec),
              },
              { db },
            ),
          ),
        ).rejects.toBeInstanceOf(PrincipalToolNotAllowedError);
      }
      const rows = await db.query('SELECT COUNT(*) AS n FROM runtime_reports');
      expect(Number((rows.rows[0] as { n: unknown }).n)).toBe(0);
    });

    it('the model layer also refuses a create that reaches the collection directly', async () => {
      const collection = (await ObjectRegistry.getCollection('RuntimeReport', {
        db,
      })) as { create(values: Record<string, unknown>): Promise<unknown> };
      await expect(
        withTenant({ tenantId: TENANT_A }, () =>
          collection.create({
            title: 'Injected',
            spec: JSON.stringify({
              version: 1,
              title: 'Injected',
              source: 'invoices',
              measures: [{ fn: 'count' }],
            }),
          }),
        ),
      ).rejects.toThrow();
      const rows = await db.query('SELECT COUNT(*) AS n FROM runtime_reports');
      expect(Number((rows.rows[0] as { n: unknown }).n)).toBe(0);
    });

    it('the confirmed define/apply path still saves', async () => {
      const tools = toolMap({ confirmation: { confirmSave: async () => {} } });
      const run = fakeRun();
      const preview = await call(
        tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG),
        run,
        { phase: 'preview', spec: SPEC },
      );
      const saved = await call(
        tools.get(RUNTIME_REPORT_DEFINE_TOOL_SLUG),
        run,
        { phase: 'apply', spec: SPEC, specHash: preview.specHash },
      );
      expect(saved.saved).toBe(true);
      const rows = await db.query('SELECT COUNT(*) AS n FROM runtime_reports');
      expect(Number((rows.rows[0] as { n: unknown }).n)).toBe(1);
    });
  });

  it('accepts a per-run source resolver', async () => {
    const resolver = vi.fn().mockResolvedValue(sources);
    const tools = new Map(
      createRuntimeReportTools({ sources: resolver }).map((t) => [t.slug, t]),
    );
    const run = fakeRun();
    await call(tools.get(RUNTIME_REPORT_SOURCES_TOOL_SLUG), run);
    expect(resolver).toHaveBeenCalledWith(run);
  });
});
