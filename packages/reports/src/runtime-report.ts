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
 * The assistant creates rows through {@link saveRuntimeReport}, so only a spec
 * that compiled for the saving principal and was confirmed by a human is
 * stored. That is enforced HERE, in the model layer, not just by which
 * surfaces are generated: `validateBeforeSave()` refuses every insert, and
 * every update that changes the spec (or title, source, description or author),
 * unless the instance carries a confirmation proof that only
 * {@link saveRuntimeReport} can attach. Rows built from JSON (a REST body, a
 * manifest tool call) cannot carry the proof, so they are refused whatever
 * surface delivered them. Archiving (a `status` change with the spec
 * untouched) stays allowed. The generated surfaces expose `list`/`get`, plus
 * `create` on the API only so the permission catalog and Postgres RLS bindings
 * know the operation the confirmed save performs.
 */

import {
  field,
  SmrtCollection,
  SmrtObject,
  type SmrtObjectOptions,
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

/**
 * Confirmation proof carried on a constructor option. A symbol key can never
 * arrive from JSON (REST body, manifest tool arguments), and the symbol is not
 * exported, so only code in this module can mint a row that may be written.
 */
const CONFIRMED_SAVE = Symbol('smrt-reports.runtimeReport.confirmedSave');

/** Instance -> spec hash a human confirmed for this exact write. */
const confirmedSaves = new WeakMap<object, string>();

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'runtime_reports',
  // The exposed operations are exactly: list/get (API, CLI, MCP) and `create`
  // (API only). `create` is enabled so the permission catalog -- and with it
  // role grants -- know the operation the assistant's confirmed save performs
  // (`<collection>.create`); it is NOT a way to author a report. The model layer
  // (validateBeforeSave) refuses any insert that was not minted by
  // saveRuntimeReport() after a human confirmed that exact spec, so a REST
  // `create` body is always refused. `update` and `delete` are deliberately
  // absent from every surface, so they never enter the catalog or RLS grants.
  api: { include: ['list', 'get', 'create'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class RuntimeReport extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  @field({ type: 'text' })
  title: string = '';

  @field({ type: 'text' })
  description: string = '';

  /** Source id the spec names; resolved against a host allow-list at run. */
  @field({ type: 'text' })
  sourceId: string = '';

  /** Normalized spec JSON; use {@link getSpec}/{@link setSpec}. */
  @field({ type: 'text', required: true })
  spec: string = '';

  /** Hash of the normalized spec; detects out-of-band edits to `spec`. */
  @field({ type: 'text' })
  specHash: string = '';

  @field({ type: 'text', required: true })
  status: RuntimeReportStatus = 'active';

  /** Principal that saved the report (an id string; not a foreign key). */
  @field({ type: 'text' })
  createdByUserId: string = '';

  constructor(options: SmrtObjectOptions = {}) {
    super(options);
    const proof = (options as Record<symbol, unknown>)[CONFIRMED_SAVE];
    if (typeof proof === 'string') confirmedSaves.set(this, proof);
  }

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
    // Parse whatever was supplied (REST body, service, direct assignment) and
    // re-derive every denormalized column from it, so the columns can never
    // disagree with the spec that runs.
    const parsed = parseRuntimeReportSpec(this.spec);
    await this.assertConfirmedWrite(parsed);
    this.setSpec(parsed);
    if (this.status !== 'active' && this.status !== 'archived') {
      throw new RuntimeReportError('invalid_spec', 'status', 'is invalid');
    }
  }

  /**
   * Invariant: a RuntimeReport row is inserted, or has its spec/title/source/
   * description/author changed, only by the confirmed-save path. Anything else
   * (REST `create` body, manifest tool args, `new RuntimeReport().save()`,
   * `collection.update()` of the spec) is refused here. A save that leaves those
   * columns as stored (an archive/unarchive status change) needs no proof.
   */
  private async assertConfirmedWrite(parsed: RuntimeReportSpec): Promise<void> {
    const hash = runtimeReportSpecHash(parsed);
    const proof = confirmedSaves.get(this);
    if (proof !== undefined) {
      // Single use: the proof covers exactly one write of this exact spec.
      confirmedSaves.delete(this);
      if (proof === hash) return;
    } else if (this.isPersisted && this.id) {
      const stored = (await this.db.get(this.tableName, { id: this.id })) as {
        spec_hash?: unknown;
        title?: unknown;
        description?: unknown;
        source_id?: unknown;
        created_by_user_id?: unknown;
      } | null;
      if (
        stored &&
        stored.spec_hash === hash &&
        (stored.title ?? '') === parsed.title &&
        (stored.description ?? '') === (parsed.description ?? '') &&
        (stored.source_id ?? '') === parsed.source &&
        (stored.created_by_user_id ?? '') === (this.createdByUserId ?? '')
      ) {
        return;
      }
    }
    throw new RuntimeReportError(
      'confirmation_required',
      'spec',
      'a runtime report can only be created or changed through the confirmed save of reports.runtime.define; the write was refused',
    );
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
  /**
   * The spec hash a human confirmed (the value handed to the application's
   * confirmation host). It must equal the compiled plan's hash; the row is
   * only minted when it does. Call this ONLY after that confirmation resolved.
   */
  confirmedSpecHash: string;
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
  if (options.confirmedSpecHash !== specHash) {
    throw new RuntimeReportError(
      'confirmation_required',
      'specHash',
      'the confirmed spec hash does not match the spec; the report was not saved',
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
    // The only place a confirmation proof is minted; see CONFIRMED_SAVE.
    [CONFIRMED_SAVE]: specHash,
  } as Parameters<RuntimeReportCollection['create']>[0]);
}

export async function getRuntimeReport(
  options: RuntimeReportStoreOptions & {
    ref: string;
    /**
     * Explicit owner tenant. When given, a row owned by any other tenant is
     * treated as absent even if the ambient tenant context would admit it
     * (a host that knows the principal's tenant should always pass it).
     */
    tenantId?: string;
  },
): Promise<RuntimeReport | null> {
  const collection = await collectionFor(options.db);
  const report = await collection.get(options.ref);
  if (report && options.tenantId && report.tenantId !== options.tenantId) {
    return null;
  }
  return report;
}

export async function listRuntimeReports(
  options: RuntimeReportStoreOptions & {
    status?: RuntimeReportStatus;
    limit?: number;
    /** Explicit owner tenant; filters in addition to the ambient context. */
    tenantId?: string;
  },
): Promise<RuntimeReport[]> {
  const collection = await collectionFor(options.db);
  return collection.list({
    where: {
      status: options.status ?? 'active',
      ...(options.tenantId ? { tenantId: options.tenantId } : {}),
    },
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
