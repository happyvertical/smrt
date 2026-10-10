/**
 * Assistant tools for runtime-defined reports (#3711).
 *
 * The assistant can discover which sources and fields it may report on,
 * PROPOSE a declarative report spec, and run saved reports. It can never
 * author SQL, name a table or tenant, or save without a human: the model only
 * ever supplies a `RuntimeReportSpec` (data), and every authority decision
 * is made server-side from the live {@link PrincipalRun}.
 *
 * Flow (mirrors the preview/apply protocol of the declared-report refresh and
 * export tools):
 *
 * 1. `reports.runtime.sources` — field catalogue for the principal.
 * 2. `reports.runtime.define` `phase: 'preview'` — validate + compile + run a
 *    bounded sample. Nothing is stored.
 * 3. `reports.runtime.define` `phase: 'apply'` — only with the `specHash` of
 *    the previewed spec AND an application-owned {@link RuntimeReportConfirmationHost}
 *    that resolves once a human has confirmed that exact spec. Without a
 *    host, saving is refused (fail closed); a model-supplied `confirmed: true`
 *    is never trusted.
 * 4. `reports.runtime.list` / `reports.runtime.run` — stored reports are
 *    re-parsed and re-compiled against the live principal on every run.
 *
 * @module
 */

import type { AITool } from '@happyvertical/ai';
import {
  DataSurfaceDeniedError,
  type PrincipalRun,
  type PrincipalTool,
  type PrincipalToolContext,
} from '@happyvertical/smrt-agents';
import {
  compileRuntimeReportSpec,
  describeRuntimeReportSource,
  getRuntimeReport,
  listRuntimeReports,
  parseRuntimeReportSpec,
  RUNTIME_REPORT_BUCKETS,
  RUNTIME_REPORT_CHART_TYPES,
  RUNTIME_REPORT_FILTER_OPS,
  RUNTIME_REPORT_HAVING_OPS,
  RUNTIME_REPORT_LIMITS,
  RUNTIME_REPORT_MEASURE_FNS,
  RuntimeReport,
  type RuntimeReportCompileContext,
  RuntimeReportError,
  type RuntimeReportResult,
  type RuntimeReportSourceDefinition,
  type RuntimeReportSpec,
  runRuntimeReport,
  runStoredRuntimeReport,
  saveRuntimeReport,
} from '@happyvertical/smrt-reports';
import {
  getCurrentTenant,
  isSuperAdminBypass,
  isSystemContext,
  isTenancyEnabled,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { OperationPermissionCollectionInput } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';

/** Tool slug (permission/allow-list name) for the source field catalogue. */
export const RUNTIME_REPORT_SOURCES_TOOL_SLUG = 'reports.runtime.sources';
/** Tool slug for proposing (`preview`) and saving (`apply`) a report. */
export const RUNTIME_REPORT_DEFINE_TOOL_SLUG = 'reports.runtime.define';
/** Tool slug for listing stored runtime reports. */
export const RUNTIME_REPORT_LIST_TOOL_SLUG = 'reports.runtime.list';
/** Tool slug for running a stored runtime report. */
export const RUNTIME_REPORT_RUN_TOOL_SLUG = 'reports.runtime.run';

/** Qualified registry name of the stored runtime report model. */
export const RUNTIME_REPORT_QUALIFIED_NAME =
  '@happyvertical/smrt-reports:RuntimeReport';

/**
 * Whether a manifest operation would WRITE a stored runtime report
 * (`create`, `update`, `delete` or any custom method). The model may read
 * stored reports through the generic manifest tools, but it persists one only
 * through `reports.runtime.define` (apply), behind the app-owned human
 * confirmation. The generic manifest tool catalog and dispatcher use this to
 * refuse these operations even when a persona's `allowedTools` names a
 * `runtimereports.create` style slug; the model layer refuses them too.
 */
export function isRuntimeReportWriteOperation(tool: {
  className?: string;
  qualifiedName?: string;
  action: string;
}): boolean {
  const isRuntimeReport =
    tool.qualifiedName === RUNTIME_REPORT_QUALIFIED_NAME ||
    (tool.qualifiedName === undefined && tool.className === 'RuntimeReport');
  return isRuntimeReport && tool.action !== 'read';
}

/** Provider function name for {@link RUNTIME_REPORT_SOURCES_TOOL_SLUG}. */
export const RUNTIME_REPORT_SOURCES_FUNCTION_NAME = 'reports-runtime-sources';
/** Provider function name for {@link RUNTIME_REPORT_DEFINE_TOOL_SLUG}. */
export const RUNTIME_REPORT_DEFINE_FUNCTION_NAME = 'reports-runtime-define';
/** Provider function name for {@link RUNTIME_REPORT_LIST_TOOL_SLUG}. */
export const RUNTIME_REPORT_LIST_FUNCTION_NAME = 'reports-runtime-list';
/** Provider function name for {@link RUNTIME_REPORT_RUN_TOOL_SLUG}. */
export const RUNTIME_REPORT_RUN_FUNCTION_NAME = 'reports-runtime-run';

const DEFAULT_PREVIEW_ROWS = 20;
const DEFAULT_RUN_ROWS = 200;

/** A server-owned report source; `collection` gates reads via RBAC. */
export interface RuntimeReportToolSource
  extends Omit<RuntimeReportSourceDefinition, 'collection'> {
  /**
   * Permission-catalog collection the principal must be able to `read`. A
   * string is used VERBATIM as the catalog collection slug (the part of
   * `<collection>.read` the permission catalog emits, for example
   * `invoices`), NOT a class name: `Invoice` derives `Invoice.read`, which no
   * catalog contains, so every read is denied and the source is silently not
   * offered. Prefer passing the registered model class (or a collection
   * instance), which resolves to the exact slug the catalog emits.
   */
  collection: OperationPermissionCollectionInput;
}

/** What a human is asked to confirm before a runtime report is saved. */
export interface RuntimeReportSaveRequest {
  /** The authenticated run the proposal was made under. */
  run: PrincipalRun;
  /** The normalized spec exactly as it will be stored. */
  spec: RuntimeReportSpec;
  /** Fingerprint of {@link spec}; the host should show/bind this value. */
  specHash: string;
  /** Human label of the source the spec reads. */
  sourceLabel: string;
}

/**
 * Application-owned human confirmation. Resolve ONLY after a person approved
 * this exact spec (for example a UI confirm dialog bound to `specHash`), and
 * reject to deny. The tool never infers consent from model output.
 */
export interface RuntimeReportConfirmationHost {
  /** Resolve once the human confirmed; throw to deny the save. */
  confirmSave(request: RuntimeReportSaveRequest): Promise<void>;
}

/** Agent-level audit record; report persistence is audited by the model layer. */
export interface RuntimeReportAuditEntry {
  action: 'sources' | 'preview' | 'save' | 'list' | 'run';
  userId: string;
  tenantId: string | null;
  specHash?: string;
  reportId?: string;
}

/** Options for {@link createRuntimeReportTools}. */
export interface RuntimeReportToolsOptions {
  /** Server-owned allow-list; the model can reach nothing outside it. */
  sources:
    | readonly RuntimeReportToolSource[]
    | ((
        run: PrincipalRun,
      ) =>
        | readonly RuntimeReportToolSource[]
        | Promise<readonly RuntimeReportToolSource[]>);
  /** Human confirmation for saving. Omit to make the tools propose-only. */
  confirmation?: RuntimeReportConfirmationHost;
  /** Optional audit sink for tool-level activity. */
  audit?: (entry: RuntimeReportAuditEntry) => void | Promise<void>;
  /**
   * Permission-catalog collection for stored reports. Defaults to the
   * registered `RuntimeReport` class, which resolves to the slug the
   * catalog emits (for example `runtimereports.read`). A string is used
   * verbatim as the catalog slug, never as a class name.
   */
  reportsCollection?: OperationPermissionCollectionInput;
  /** Rows returned by a preview. Default 20. */
  previewRows?: number;
  /** Row ceiling for a stored-report run. Default 200. */
  maxRows?: number;
}

function principalFromRun(run: PrincipalRun): {
  userId: string;
  tenantId: string | null;
} {
  const userId = run.context.userId;
  if (!userId) throw new DataSurfaceDeniedError();
  return { userId, tenantId: run.context.tenantId };
}

function requireDatabase(
  run: PrincipalRun,
  fallback: PrincipalToolContext['db'],
): DatabaseInterface {
  const database = run.context.database ?? fallback;
  if (
    typeof database !== 'object' ||
    database === null ||
    !('query' in database) ||
    typeof database.query !== 'function'
  ) {
    throw new RuntimeReportError(
      'unsupported_source',
      '',
      'Runtime report tools require the authenticated database context',
    );
  }
  return database as DatabaseInterface;
}

async function resolveSources(
  options: RuntimeReportToolsOptions,
  run: PrincipalRun,
): Promise<readonly RuntimeReportToolSource[]> {
  return typeof options.sources === 'function'
    ? options.sources(run)
    : options.sources;
}

/** The principal's tenant; stored reports are tenant-owned, so one is required. */
function requirePrincipalTenant(run: PrincipalRun): string {
  const tenantId = run.context.tenantId;
  if (!tenantId) {
    throw new RuntimeReportError(
      'tenant_required',
      '',
      'a tenant is required to use stored runtime reports',
    );
  }
  return tenantId;
}

/**
 * Run stored-report storage calls under the AUTHENTICATED principal's tenant,
 * the same tenant the compiler scopes the aggregate to. Stored reports are
 * tenant-owned, and the tenancy interceptor filters by the AMBIENT tenant
 * context, so without this a tenant-less persona (or one whose context was not
 * entered) would list whatever tenant happens to be ambient. Mirrors the
 * data-surface guard: enter the principal's context when none is active, and
 * refuse when an ambient tenant disagrees with the principal (unless the
 * caller is deliberately in a system-context/super-admin path, where the
 * explicit tenant filters passed to the store still apply).
 */
async function withPrincipalTenant<T>(
  run: PrincipalRun,
  fn: (tenantId: string) => Promise<T>,
): Promise<T> {
  const tenantId = requirePrincipalTenant(run);
  if (!isTenancyEnabled()) return fn(tenantId);
  const active = getCurrentTenant();
  if (active === undefined) {
    return withTenant({ tenantId }, () => fn(tenantId));
  }
  if (
    active.tenantId !== tenantId &&
    !isSystemContext() &&
    !isSuperAdminBypass()
  ) {
    throw new DataSurfaceDeniedError();
  }
  return fn(tenantId);
}

/** Whether the principal may `read` a configured source (never throws). */
async function canReadSource(
  run: PrincipalRun,
  source: RuntimeReportToolSource,
): Promise<boolean> {
  try {
    await run.assertOperation(source.collection, 'read');
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the compile context from the LIVE run. The permission set is the
 * principal's published snapshot and every source read is gated by RBAC.
 *
 * The allow-list is narrowed to the sources this principal may read BEFORE the
 * compiler sees it. A configured-but-unreadable source id is then
 * indistinguishable from an id that is not configured at all: both fail in the
 * compiler's source resolution with the same `unknown_source` error, so the
 * model cannot enumerate the host's source ids by probing for a different
 * error. `authorizeSource` stays as a second, fail-closed gate.
 */
async function compileContext(
  options: RuntimeReportToolsOptions,
  run: PrincipalRun,
): Promise<RuntimeReportCompileContext> {
  const configured = await resolveSources(options, run);
  const sources: RuntimeReportToolSource[] = [];
  for (const source of configured) {
    if (await canReadSource(run, source)) sources.push(source);
  }
  const byId = new Map(sources.map((source) => [source.id, source]));
  return {
    // The compiler never reads `collection`; hand it a plain definition so a
    // class/collection-instance input does not leak into the compile context.
    sources: sources.map(({ collection, ...source }) => ({
      ...source,
      ...(typeof collection === 'string' ? { collection } : {}),
    })),
    permissions: run.permissions,
    tenantId: run.context.tenantId,
    authorizeSource: async (source) => {
      const allowed = byId.get(source.id);
      if (!allowed || !(await canReadSource(run, allowed))) {
        throw new DataSurfaceDeniedError();
      }
    },
  };
}

function aiTool(
  slug: string,
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: (context: PrincipalToolContext) => Promise<unknown>,
): PrincipalTool {
  return {
    slug,
    aiTool: {
      type: 'function',
      function: { name, description, parameters },
    } satisfies AITool,
    execute,
  };
}

const SPEC_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  description:
    'Declarative report spec. Only names returned by reports-runtime-sources are valid.',
  required: ['title', 'source', 'measures'],
  additionalProperties: false,
  properties: {
    version: { type: 'integer', enum: [1] },
    title: { type: 'string', maxLength: RUNTIME_REPORT_LIMITS.maxTitleLength },
    description: {
      type: 'string',
      maxLength: RUNTIME_REPORT_LIMITS.maxDescriptionLength,
    },
    source: { type: 'string', description: 'A source id from the catalogue.' },
    dimensions: {
      type: 'array',
      maxItems: RUNTIME_REPORT_LIMITS.maxDimensions,
      description: 'Group-by fields (optionally time-bucketed).',
      items: {
        type: 'object',
        required: ['field'],
        additionalProperties: false,
        properties: {
          field: { type: 'string' },
          as: { type: 'string', description: 'lowercase_snake output name' },
          bucket: { type: 'string', enum: [...RUNTIME_REPORT_BUCKETS] },
        },
      },
    },
    measures: {
      type: 'array',
      minItems: 1,
      maxItems: RUNTIME_REPORT_LIMITS.maxMeasures,
      items: {
        type: 'object',
        required: ['fn'],
        additionalProperties: false,
        properties: {
          fn: { type: 'string', enum: [...RUNTIME_REPORT_MEASURE_FNS] },
          field: {
            type: 'string',
            description: 'Omit only for a plain row count.',
          },
          as: { type: 'string', description: 'lowercase_snake output name' },
        },
      },
    },
    filters: {
      type: 'array',
      maxItems: RUNTIME_REPORT_LIMITS.maxFilters,
      description: 'AND-ed row filters applied before grouping.',
      items: {
        type: 'object',
        required: ['field', 'op'],
        additionalProperties: false,
        properties: {
          field: { type: 'string' },
          op: { type: 'string', enum: [...RUNTIME_REPORT_FILTER_OPS] },
          value: {
            description:
              'Scalar, or an array for in/notIn. Omit for isNull/isNotNull. Money is integer minor units.',
          },
        },
      },
    },
    having: {
      type: 'array',
      maxItems: RUNTIME_REPORT_LIMITS.maxHaving,
      items: {
        type: 'object',
        required: ['measure', 'op', 'value'],
        additionalProperties: false,
        properties: {
          measure: { type: 'string' },
          op: { type: 'string', enum: [...RUNTIME_REPORT_HAVING_OPS] },
          value: { type: 'number' },
        },
      },
    },
    sort: {
      type: 'array',
      maxItems: RUNTIME_REPORT_LIMITS.maxSort,
      items: {
        type: 'object',
        required: ['by'],
        additionalProperties: false,
        properties: {
          by: { type: 'string' },
          direction: { type: 'string', enum: ['asc', 'desc'] },
        },
      },
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: RUNTIME_REPORT_LIMITS.maxRowLimit,
    },
    chart: {
      type: 'object',
      required: ['type'],
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: [...RUNTIME_REPORT_CHART_TYPES] },
        x: { type: 'string' },
        y: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

function cap(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RuntimeReportError(
      'invalid_spec',
      label,
      'must be a non-empty string',
    );
  }
  return value;
}

function boundedPreview(
  result: RuntimeReportResult,
  rows: number,
): RuntimeReportResult {
  if (result.rows.length <= rows) return result;
  return {
    ...result,
    rows: result.rows.slice(0, rows),
    rowCount: rows,
    truncated: true,
  };
}

/**
 * Build the runtime-report assistant tools. Offer them through the persona
 * conversation's `extraTools`; each is gated by the same fail-closed
 * `allowedTools` offer and execution gates as every other principal tool.
 *
 * @param options - Source allow-list, optional human confirmation host, audit
 *   sink, and bounds.
 * @returns The `sources`, `define`, `list` and `run` principal tools.
 */
export function createRuntimeReportTools(
  options: RuntimeReportToolsOptions,
): PrincipalTool[] {
  const reportsCollection = options.reportsCollection ?? RuntimeReport;
  const previewRows = cap(options.previewRows, DEFAULT_PREVIEW_ROWS);
  const maxRows = cap(options.maxRows, DEFAULT_RUN_ROWS);

  const audit = async (
    run: PrincipalRun,
    entry: Omit<RuntimeReportAuditEntry, 'userId' | 'tenantId'>,
  ): Promise<void> => {
    await options.audit?.({ ...entry, ...principalFromRun(run) });
  };

  const sources = aiTool(
    RUNTIME_REPORT_SOURCES_TOOL_SLUG,
    RUNTIME_REPORT_SOURCES_FUNCTION_NAME,
    'List the data sources you may build a report on, with the exact fields, filter operators and aggregates available to the current user. Call this before proposing a report; never invent field names.',
    { type: 'object', properties: {}, additionalProperties: false },
    async ({ run }) => {
      run.assertToolAllowed(RUNTIME_REPORT_SOURCES_TOOL_SLUG);
      principalFromRun(run);
      const context = await compileContext(options, run);
      const described = [];
      for (const source of context.sources) {
        try {
          described.push(await describeRuntimeReportSource(context, source.id));
        } catch (error) {
          // A source this principal cannot read is simply not offered.
          if (error instanceof DataSurfaceDeniedError) continue;
          throw error;
        }
      }
      await audit(run, { action: 'sources' });
      return {
        sources: described,
        limits: {
          maxDimensions: RUNTIME_REPORT_LIMITS.maxDimensions,
          maxMeasures: RUNTIME_REPORT_LIMITS.maxMeasures,
          maxFilters: RUNTIME_REPORT_LIMITS.maxFilters,
          maxRows: RUNTIME_REPORT_LIMITS.maxRowLimit,
        },
        notes: [
          'Money fields hold integer minor units (for example cents).',
          'Aliases are lowercase letters, digits and underscores.',
        ],
      };
    },
  );

  const define = aiTool(
    RUNTIME_REPORT_DEFINE_TOOL_SLUG,
    RUNTIME_REPORT_DEFINE_FUNCTION_NAME,
    'Propose a new report as a declarative spec. phase "preview" validates the spec and returns a sample; nothing is saved. After the user is shown the preview and a human confirms, call phase "apply" with the specHash from the preview to save it. The user, not you, confirms.',
    {
      type: 'object',
      required: ['phase', 'spec'],
      additionalProperties: false,
      properties: {
        phase: { type: 'string', enum: ['preview', 'apply'] },
        spec: SPEC_PARAMETERS,
        specHash: {
          type: 'string',
          description: 'Required for apply: the specHash returned by preview.',
        },
      },
    },
    async ({ run, args, db }) => {
      run.assertToolAllowed(RUNTIME_REPORT_DEFINE_TOOL_SLUG);
      principalFromRun(run);
      if (args.phase !== 'preview' && args.phase !== 'apply') {
        throw new RuntimeReportError(
          'invalid_spec',
          'phase',
          'must be "preview" or "apply"',
        );
      }
      const database = requireDatabase(run, db);
      const spec = parseRuntimeReportSpec(args.spec);
      const context = await compileContext(options, run);
      const compiled = await compileRuntimeReportSpec(spec, context);

      if (args.phase === 'preview') {
        const result = boundedPreview(
          await runRuntimeReport(compiled, {
            db: database,
            maxRows: previewRows,
          }),
          previewRows,
        );
        await audit(run, { action: 'preview', specHash: compiled.specHash });
        return {
          phase: 'preview',
          saved: false,
          requiresConfirmation: true,
          specHash: compiled.specHash,
          spec: compiled.spec,
          source: compiled.source.label,
          result,
        };
      }

      // apply: the hash binds the confirmation to exactly what was previewed.
      if (args.specHash !== compiled.specHash) {
        throw new RuntimeReportError(
          'invalid_spec',
          'specHash',
          'does not match the spec; preview the spec again and pass its specHash',
        );
      }
      // Before asking a human to confirm anything that cannot be stored.
      requirePrincipalTenant(run);
      if (!options.confirmation) {
        throw new RuntimeReportError(
          'invalid_operation',
          'phase',
          'saving requires human confirmation, which is not available in this session; the proposal was not saved',
        );
      }
      try {
        await run.assertOperation(reportsCollection, 'create');
      } catch {
        throw new DataSurfaceDeniedError();
      }
      const confirmedSpecHash = compiled.specHash;
      await options.confirmation.confirmSave({
        run,
        spec: compiled.spec,
        specHash: confirmedSpecHash,
        sourceLabel: compiled.source.label,
      });
      // Only reached once the host resolved for exactly this hash. The model
      // layer refuses every other write of a RuntimeReport row.
      const saved = await withPrincipalTenant(run, (tenantId) =>
        saveRuntimeReport({
          db: database,
          compiled,
          confirmedSpecHash,
          createdByUserId: principalFromRun(run).userId,
          tenantId,
        }),
      );
      await audit(run, {
        action: 'save',
        specHash: compiled.specHash,
        reportId: saved.id ?? undefined,
      });
      return {
        phase: 'apply',
        saved: true,
        reportId: saved.id,
        slug: saved.slug,
        title: saved.title,
        specHash: compiled.specHash,
      };
    },
  );

  const list = aiTool(
    RUNTIME_REPORT_LIST_TOOL_SLUG,
    RUNTIME_REPORT_LIST_FUNCTION_NAME,
    'List the saved reports the current user can see, newest first. "runnable" is false when the user can no longer read a report\'s source.',
    {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    async ({ run, args, db }) => {
      run.assertToolAllowed(RUNTIME_REPORT_LIST_TOOL_SLUG);
      principalFromRun(run);
      try {
        await run.assertOperation(reportsCollection, 'read');
      } catch {
        throw new DataSurfaceDeniedError();
      }
      const limit =
        typeof args.limit === 'number' && Number.isSafeInteger(args.limit)
          ? Math.min(Math.max(args.limit, 1), 100)
          : 50;
      const database = requireDatabase(run, db);
      const reports = await withPrincipalTenant(run, (tenantId) =>
        listRuntimeReports({ db: database, limit, tenantId }),
      );
      const context = await compileContext(options, run);
      // The context only carries sources this principal may read.
      const readable = new Set(context.sources.map((source) => source.id));
      await audit(run, { action: 'list' });
      return {
        reports: reports.map((report) => ({
          id: report.id,
          slug: report.slug,
          title: report.title,
          description: report.description,
          sourceId: report.sourceId,
          specHash: report.specHash,
          runnable: readable.has(report.sourceId),
        })),
      };
    },
  );

  const runTool = aiTool(
    RUNTIME_REPORT_RUN_TOOL_SLUG,
    RUNTIME_REPORT_RUN_FUNCTION_NAME,
    "Run a saved report with the current user's permissions and return its rows, columns and chart hint. Results are computed fresh and never cached across users.",
    {
      type: 'object',
      required: ['reportId'],
      properties: {
        reportId: { type: 'string', description: 'Report id or slug.' },
      },
      additionalProperties: false,
    },
    async ({ run, args, db }) => {
      run.assertToolAllowed(RUNTIME_REPORT_RUN_TOOL_SLUG);
      principalFromRun(run);
      try {
        await run.assertOperation(reportsCollection, 'read');
      } catch {
        throw new DataSurfaceDeniedError();
      }
      const database = requireDatabase(run, db);
      const ref = requiredString(args.reportId, 'reportId');
      const report = await withPrincipalTenant(run, (tenantId) =>
        getRuntimeReport({ db: database, ref, tenantId }),
      );
      // Same answer for "missing", "other tenant" and "not visible".
      if (!report) throw new DataSurfaceDeniedError();
      const result = await runStoredRuntimeReport({
        db: database,
        report,
        context: await compileContext(options, run),
        maxRows,
      });
      await audit(run, {
        action: 'run',
        reportId: report.id ?? undefined,
        specHash: result.specHash,
      });
      return { reportId: report.id, slug: report.slug, result };
    },
  );

  return [sources, define, list, runTool];
}
