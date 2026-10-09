/**
 * Stored runtime report definitions (#3711).
 *
 * A `RuntimeReport` row is a validated {@link RuntimeReportSpec} saved as data.
 * It carries NO authority: the spec is re-parsed on every read and re-compiled
 * against the live principal's field policy, permissions and tenant on every
 * run, so a stored report can never expose more than its current viewer may
 * see. Result rows are deliberately never persisted (a cached result computed
 * for one principal must not be served to another).
 *
 * The generated REST/MCP surface is read-only (`list`/`get`). Creation goes
 * through {@link saveRuntimeReport} so only a spec that compiled for the
 * saving principal can be stored; `validateBeforeSave()` additionally refuses
 * any row whose JSON does not parse back to the recorded hash.
 */

import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  getTenantId,
  TenantScoped,
  tenantId,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type CompiledRuntimeReport,
  compileRuntimeReportSpec,
  type RuntimeReportCompileContext,
  type RuntimeReportResult,
  runRuntimeReport,
} from './runtime-compiler.js';
import {
  parseRuntimeReportSpec,
  RuntimeReportError,
  type RuntimeReportSpec,
  runtimeReportSpecHash,
  serializeRuntimeReportSpec,
} from './runtime-spec.js';

export type RuntimeReportStatus = 'active' | 'archived';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'runtime_reports',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class RuntimeReport extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  @field({ type: 'text', required: true })
  title: string = '';

  @field({ type: 'text' })
  description: string = '';

  /** Source id the spec names; resolved against a host allow-list at run. */
  @field({ type: 'text', required: true })
  sourceId: string = '';

  /** Normalized spec JSON; use {@link getSpec}/{@link setSpec}. */
  @field({ type: 'text', required: true })
  spec: string = '';

  /** Hash of the normalized spec; detects out-of-band edits to `spec`. */
  @field({ type: 'text', required: true })
  specHash: string = '';

  @field({ type: 'text', required: true })
  status: RuntimeReportStatus = 'active';

  /** Principal that saved the report (an id string; not a foreign key). */
  @field({ type: 'text' })
  createdByUserId: string = '';

  /** Re-parse the stored JSON; never trust the column without validation. */
  getSpec(): RuntimeReportSpec {
    const parsed = parseRuntimeReportSpec(this.spec);
    if (runtimeReportSpecHash(parsed) !== this.specHash) {
      throw new RuntimeReportError(
        'invalid_spec',
        'spec',
        'stored spec does not match its recorded hash',
      );
    }
    return parsed;
  }

  setSpec(spec: RuntimeReportSpec): void {
    const normalized = parseRuntimeReportSpec(spec);
    this.spec = serializeRuntimeReportSpec(normalized);
    this.specHash = runtimeReportSpecHash(normalized);
    this.title = normalized.title;
    this.description = normalized.description ?? '';
    this.sourceId = normalized.source;
  }

  protected override async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    const spec = this.getSpec();
    if (
      this.title !== spec.title ||
      this.sourceId !== spec.source ||
      (this.description ?? '') !== (spec.description ?? '')
    ) {
      throw new RuntimeReportError(
        'invalid_spec',
        'spec',
        'denormalized columns do not match the stored spec',
      );
    }
    if (this.status !== 'active' && this.status !== 'archived') {
      throw new RuntimeReportError('invalid_spec', 'status', 'is invalid');
    }
  }
}

export class RuntimeReportCollection extends SmrtCollection<RuntimeReport> {
  static readonly _itemClass = RuntimeReport;
}

export interface RuntimeReportStoreOptions {
  db: DatabaseInterface;
}

export interface SaveRuntimeReportOptions extends RuntimeReportStoreOptions {
  /** A plan compiled for the SAVING principal; the only accepted input. */
  compiled: CompiledRuntimeReport;
  createdByUserId: string;
  /** Defaults to the tenant the plan was compiled for, then ambient. */
  tenantId?: string | null;
}

async function collectionFor(
  db: DatabaseInterface,
): Promise<RuntimeReportCollection> {
  return RuntimeReportCollection.create({
    db,
  }) as Promise<RuntimeReportCollection>;
}

/** Persist a spec that has already compiled for the saving principal. */
export async function saveRuntimeReport(
  options: SaveRuntimeReportOptions,
): Promise<RuntimeReport> {
  const tenant =
    options.tenantId ?? options.compiled.tenant.tenantId ?? getTenantId() ?? '';
  if (!tenant) {
    throw new RuntimeReportError(
      'tenant_required',
      '',
      'a tenant is required to save a runtime report',
    );
  }
  const spec = parseRuntimeReportSpec(options.compiled.spec);
  const specHash = runtimeReportSpecHash(spec);
  if (specHash !== options.compiled.specHash) {
    throw new RuntimeReportError(
      'invalid_spec',
      'spec',
      'compiled plan does not match its spec',
    );
  }
  const collection = await collectionFor(options.db);
  return collection.create({
    tenantId: tenant,
    title: spec.title,
    description: spec.description ?? '',
    sourceId: spec.source,
    spec: serializeRuntimeReportSpec(spec),
    specHash,
    status: 'active',
    createdByUserId: options.createdByUserId,
  });
}

export async function getRuntimeReport(
  options: RuntimeReportStoreOptions & { ref: string },
): Promise<RuntimeReport | null> {
  const collection = await collectionFor(options.db);
  return collection.get(options.ref);
}

export async function listRuntimeReports(
  options: RuntimeReportStoreOptions & {
    status?: RuntimeReportStatus;
    limit?: number;
  },
): Promise<RuntimeReport[]> {
  const collection = await collectionFor(options.db);
  return collection.list({
    where: { status: options.status ?? 'active' },
    orderBy: 'created_at DESC',
    limit: Math.min(Math.max(options.limit ?? 50, 1), 200),
  });
}

export async function archiveRuntimeReport(
  options: RuntimeReportStoreOptions & { ref: string },
): Promise<RuntimeReport | null> {
  const report = await getRuntimeReport(options);
  if (!report) return null;
  report.status = 'archived';
  await report.save();
  return report;
}

/**
 * Re-validate a stored report against the live principal and run it. The
 * stored spec is parsed again and compiled with the caller's context, so
 * policy changes made after the report was saved apply immediately.
 */
export async function runStoredRuntimeReport(
  options: RuntimeReportStoreOptions & {
    report: RuntimeReport;
    context: RuntimeReportCompileContext;
    maxRows?: number;
  },
): Promise<RuntimeReportResult> {
  if (options.report.status !== 'active') {
    throw new RuntimeReportError(
      'invalid_spec',
      'status',
      'report is archived',
    );
  }
  const compiled = await compileRuntimeReportSpec(
    options.report.getSpec(),
    options.context,
  );
  return runRuntimeReport(compiled, {
    db: options.db,
    maxRows: options.maxRows,
  });
}
