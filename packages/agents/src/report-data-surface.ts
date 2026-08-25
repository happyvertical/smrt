/**
 * Principal-bound report tools built on the shared data-surface contracts.
 *
 * Reports remain the authority for materialized queries, lifecycle, drilldown,
 * and export validation. This module only binds those contracts to a live
 * PrincipalRun and the generic data-surface catalog. Applications retain
 * authorization, audit, queue, immutable-snapshot, and browser transports.
 */

import { randomUUID } from 'node:crypto';
import type { AITool } from '@happyvertical/ai';
import {
  normalizeDataQueryRequest,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import {
  type AppliedReportExport,
  type AppliedReportRefresh,
  applyReportExport,
  applyReportRefresh,
  buildReportAdapterDescriptor,
  buildReportDrilldownQuery,
  createReportExportRequest,
  createReportExportSnapshot,
  previewReportExport,
  previewReportRefresh,
  queryReportMaterializedRows,
  type ReportAdapterDescriptor,
  type ReportAdapterOptions,
  type ReportBackgroundQueryTask,
  type ReportDataQueryResult,
  type ReportExportActionHost,
  type ReportExportPreview,
  type ReportExportSnapshotBinding,
  type ReportLifecycleOptions,
  type ReportQueryOptions,
  type ReportRefreshActionHost,
  type ReportRefreshPreview,
} from '@happyvertical/smrt-reports';
import type { DataQueryRequest } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  createDataSurfaceTools,
  DATA_QUERY_TOOL_SLUG,
  type DataSurfaceDefinition,
  DataSurfaceDeniedError,
  type DataSurfaceExecutionContext,
  type DataSurfaceSchema,
  type DataSurfaceToolsOptions,
} from './data-surface.js';
import type { PrincipalRun } from './execute-as-principal.js';
import type { PrincipalTool, PrincipalToolContext } from './invoke-agent.js';

export const REPORT_QUERY_TOOL_SLUG = 'reports.query';
export const REPORT_REFRESH_TOOL_SLUG = 'reports.refresh';
export const REPORT_DRILLDOWN_TOOL_SLUG = 'reports.drilldown';
export const REPORT_EXPORT_TOOL_SLUG = 'reports.export';

export const REPORT_QUERY_FUNCTION_NAME = 'reports-query';
export const REPORT_REFRESH_FUNCTION_NAME = 'reports-refresh';
export const REPORT_DRILLDOWN_FUNCTION_NAME = 'reports-drilldown';
export const REPORT_EXPORT_FUNCTION_NAME = 'reports-export';

type ReportCtor = Parameters<typeof buildReportAdapterDescriptor>[0];
type ReportReadOptions = Omit<
  ReportQueryOptions,
  'adapter' | 'db' | 'execution'
>;

/** A server-authenticated browser command compatible with the chat bridge. */
export interface ReportDataSurfaceVisibleCommand {
  version: 1;
  commandId: string;
  identity: { surfaceId: string; kind: 'report' };
  expectedRevision: number;
  controlId: 'query';
  payload: { request: DataQueryRequest };
}

/** Browser acknowledgement is required before a visible query succeeds. */
export interface ReportDataSurfaceVisibleAck {
  commandId: string;
  identity: { surfaceId: string; kind: 'report' };
  ok: boolean;
  revision?: number;
  reason?: string;
}

export interface ReportDataSurfaceVisibleHost {
  /**
   * The host must bind the command to an authenticated browser session and
   * await its acknowledgement. It must not use this command as authorization.
   */
  send(
    command: ReportDataSurfaceVisibleCommand,
    context: { run: PrincipalRun },
  ): Promise<ReportDataSurfaceVisibleAck>;
}

export interface ReportDataSurfaceExportHost {
  /** The host captures an opaque immutable materialization binding. */
  captureSnapshot(context: {
    run: PrincipalRun;
    descriptor: ReportAdapterDescriptor;
    result: ReportDataQueryResult;
  }): Promise<ReportExportSnapshotBinding>;
  /** The returned host owns current authorization, audit, and queueing. */
  actionHost(context: {
    run: PrincipalRun;
  }): ReportExportActionHost | Promise<ReportExportActionHost>;
}

export interface ReportDataSurfaceRefreshHost {
  /** The returned host authorizes and audits against the live principal. */
  actionHost(context: {
    run: PrincipalRun;
  }): ReportRefreshActionHost | Promise<ReportRefreshActionHost>;
  /** Optional queue tuning that remains application-owned. */
  options?: Omit<
    Parameters<typeof applyReportRefresh>[1],
    'db' | 'host' | 'mode' | 'refreshAction'
  >;
}

export interface ReportDataSurfaceDefinition {
  /** Report model; never supplied by a model or browser argument. */
  report: ReportCtor;
  /** Permission-catalog collection used for the shared read gate. */
  collection: string;
  label?: string;
  description?: string;
  adapter?: ReportAdapterOptions;
  /** Application-owned collection/lifecycle seam for materialized reads. */
  query?: (
    context: DataSurfaceExecutionContext,
  ) => ReportReadOptions | Promise<ReportReadOptions>;
  /** Background execution never receives principal or tenant in its task. */
  enqueueBackgroundQuery?: (
    task: ReportBackgroundQueryTask,
    context: { run: PrincipalRun },
  ) => Promise<{ taskId: string }>;
  visible?: ReportDataSurfaceVisibleHost;
  refresh?: ReportDataSurfaceRefreshHost;
  export?: ReportDataSurfaceExportHost;
}

export interface ReportDataSurfaceAuditEntry {
  action: 'query' | 'refresh' | 'drilldown' | 'export';
  reportId: string;
  userId: string;
  tenantId: string | null;
}

export interface ReportDataSurfaceToolsOptions {
  reports:
    | readonly ReportDataSurfaceDefinition[]
    | ((
        run: PrincipalRun,
      ) =>
        | readonly ReportDataSurfaceDefinition[]
        | Promise<readonly ReportDataSurfaceDefinition[]>);
  /** Optional audit of agent-level handoffs; report action hosts audit mutations. */
  audit?: (entry: ReportDataSurfaceAuditEntry) => void | Promise<void>;
  /** Passed through to generic data.discover/data.inspect/data.query tools. */
  dataSurface?: Omit<DataSurfaceToolsOptions, 'surfaces' | 'execute' | 'audit'>;
}

export class ReportDataSurfaceVisibleError extends Error {
  constructor(reason?: string) {
    super(
      `Report visible command was not acknowledged${reason ? `: ${reason}` : ''}`,
    );
    this.name = 'ReportDataSurfaceVisibleError';
  }
}

export class ReportDataSurfaceConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportDataSurfaceConfigurationError';
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ReportDataSurfaceConfigurationError(
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

function principalFromRun(
  run: PrincipalRun,
): DataSurfaceExecutionContext['principal'] {
  const userId = run.context.userId;
  if (!userId) throw new DataSurfaceDeniedError();
  return { userId, tenantId: run.context.tenantId };
}

function reportDatabase(
  run: PrincipalRun,
  fallback: PrincipalToolContext['db'],
): DatabaseInterface | undefined {
  const database = run.context.database ?? fallback;
  if (database === undefined) return undefined;
  if (
    typeof database !== 'object' ||
    database === null ||
    !('query' in database) ||
    typeof database.query !== 'function'
  ) {
    throw new ReportDataSurfaceConfigurationError(
      'Report tools require a live database handle, not a database configuration',
    );
  }
  return database as DatabaseInterface;
}

function requireDatabase(
  run: PrincipalRun,
  fallback: PrincipalToolContext['db'],
): DatabaseInterface {
  const database = reportDatabase(run, fallback);
  if (!database) {
    throw new ReportDataSurfaceConfigurationError(
      'Report lifecycle and export tools require the authenticated database context',
    );
  }
  return database;
}

function querySchema(descriptor: ReportAdapterDescriptor): DataSurfaceSchema {
  return {
    ...descriptor.schema,
    fields: descriptor.columns.map((column) => ({
      id: column.id,
      type: column.type,
      projectable: column.projectable !== false,
      sortable: column.sortable === true,
      facetable: column.facetable === true,
      ...(column.filterOperators
        ? { filterOperators: [...column.filterOperators] }
        : {}),
      metadata: {
        kind: column.kind,
        filterScope: column.filterScope,
        capabilities: [...column.capabilities],
        ...(column.bucket ? { bucket: column.bucket } : {}),
        ...(column.aggregate ? { aggregate: column.aggregate } : {}),
        ...(column.format ? { format: column.format } : {}),
      },
      // The report descriptor is fail-closed: sensitive and permissioned
      // fields were already removed before reaching this catalog.
    })),
  };
}

function reportCatalogMetadata(
  definition: ReportDataSurfaceDefinition,
  descriptor: ReportAdapterDescriptor,
  run?: PrincipalRun,
  auditAvailable = false,
): NonNullable<DataSurfaceDefinition['metadata']> {
  const canUse = (tool: string) => run?.isToolAllowed(tool) ?? true;
  const canUseAction = (tool: string, requiredPermission: string) =>
    canUse(tool) && (run?.permissions.includes(requiredPermission) ?? true);
  const canQuery =
    canUse(DATA_QUERY_TOOL_SLUG) || canUse(REPORT_QUERY_TOOL_SLUG);
  const canDrilldown = auditAvailable && canUse(REPORT_DRILLDOWN_TOOL_SLUG);
  const queryModes = descriptor.queryExecution.modes.filter(
    (mode) =>
      (mode === 'silent' && canQuery) ||
      (mode === 'background' &&
        definition.enqueueBackgroundQuery !== undefined &&
        canUse(REPORT_QUERY_TOOL_SLUG)) ||
      (mode === 'visible' &&
        definition.visible !== undefined &&
        canUse(REPORT_QUERY_TOOL_SLUG)),
  );
  const allowedActions = [
    ...(canQuery ? ['query'] : []),
    ...(definition.refresh &&
    canUseAction(
      REPORT_REFRESH_TOOL_SLUG,
      descriptor.refresh.action.requiredPermission,
    )
      ? [descriptor.refresh.action.id]
      : []),
    ...(canDrilldown ? [descriptor.drilldown.id] : []),
    ...(definition.export &&
    canUseAction(REPORT_EXPORT_TOOL_SLUG, 'reports.export')
      ? ['export']
      : []),
  ];
  return {
    surfaceKind: 'report',
    queryModes,
    filterScopes: ['where', 'having'],
    freshnessSource: 'reportLifecycle',
    freshnessAvailableWithAuthenticatedDatabase: true,
    allowedActions,
    ...(definition.refresh &&
    canUseAction(
      REPORT_REFRESH_TOOL_SLUG,
      descriptor.refresh.action.requiredPermission,
    )
      ? {
          refreshPhases: descriptor.refresh.action.phases,
          refreshRequiredPermission:
            descriptor.refresh.action.requiredPermission,
          refreshAuditRequired: descriptor.refresh.action.auditRequired,
        }
      : {}),
    ...(canDrilldown
      ? { drilldownSourceClass: descriptor.drilldown.sourceClassName }
      : {}),
    ...(definition.export &&
    canUseAction(REPORT_EXPORT_TOOL_SLUG, 'reports.export')
      ? { exportPhases: ['preview', 'apply'], exportSnapshotBound: true }
      : {}),
  };
}

async function configuredReports(
  options: ReportDataSurfaceToolsOptions,
  run: PrincipalRun,
): Promise<readonly ReportDataSurfaceDefinition[]> {
  return typeof options.reports === 'function'
    ? options.reports(run)
    : options.reports;
}

async function reportEntry(
  options: ReportDataSurfaceToolsOptions,
  run: PrincipalRun,
  reportId: unknown,
): Promise<{
  definition: ReportDataSurfaceDefinition;
  descriptor: ReportAdapterDescriptor;
}> {
  const requested = requiredString(reportId, 'reportId');
  for (const definition of await configuredReports(options, run)) {
    const descriptor = await buildReportAdapterDescriptor(
      definition.report,
      definition.adapter,
    );
    if (descriptor.resourceId !== requested) continue;
    try {
      await run.assertOperation(definition.collection, 'read');
      return { definition, descriptor };
    } catch {
      break;
    }
  }
  // Do not reveal whether a report exists, has different field policy, or is
  // merely not readable under this principal.
  throw new DataSurfaceDeniedError();
}

async function readOptions(
  definition: ReportDataSurfaceDefinition,
  context: DataSurfaceExecutionContext,
): Promise<ReportReadOptions> {
  return (await definition.query?.(context)) ?? {};
}

async function audit(
  options: ReportDataSurfaceToolsOptions,
  action: ReportDataSurfaceAuditEntry['action'],
  reportId: string,
  run: PrincipalRun,
): Promise<void> {
  await options.audit?.({
    action,
    reportId,
    userId: principalFromRun(run).userId,
    tenantId: run.context.tenantId,
  });
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

/**
 * Convert a report adapter into the safe generic catalog consumed by
 * data.discover/data.inspect/data.query. Generic agent queries are always
 * silent; browser changes require the explicit report query tool below.
 */
export async function createReportDataSurfaceDefinition(
  definition: ReportDataSurfaceDefinition,
  run?: PrincipalRun,
  auditAvailable = false,
): Promise<DataSurfaceDefinition> {
  const descriptor = await buildReportAdapterDescriptor(
    definition.report,
    definition.adapter,
  );
  return {
    id: descriptor.resourceId,
    collection: definition.collection,
    className: descriptor.reportClassName,
    label: definition.label ?? descriptor.reportClassName,
    ...(definition.description ? { description: definition.description } : {}),
    metadata: reportCatalogMetadata(
      definition,
      descriptor,
      run,
      auditAvailable,
    ),
    schema: querySchema(descriptor),
    execute: async (_surface, request, context) => {
      const db = reportDatabase(context.run, context.db);
      const result = await queryReportMaterializedRows(
        definition.report,
        request,
        {
          ...(await readOptions(definition, context)),
          adapter: definition.adapter,
          ...(db ? { db, lifecycle: lifecycleOptions(db) } : {}),
          execution: 'silent',
        },
      );
      const {
        execution: _execution,
        reportLifecycle: _lifecycle,
        ...data
      } = result;
      return data;
    },
  };
}

async function dataSurfaceCatalog(
  options: ReportDataSurfaceToolsOptions,
  run: PrincipalRun,
): Promise<readonly DataSurfaceDefinition[]> {
  return Promise.all(
    (await configuredReports(options, run)).map((definition) =>
      createReportDataSurfaceDefinition(
        definition,
        run,
        typeof options.audit === 'function',
      ),
    ),
  );
}

function commandResultIsBound(
  ack: unknown,
  command: ReportDataSurfaceVisibleCommand,
): ack is ReportDataSurfaceVisibleAck {
  if (typeof ack !== 'object' || ack === null) return false;
  const value = ack as Record<string, unknown>;
  if (typeof value.identity !== 'object' || value.identity === null) {
    return false;
  }
  const identity = value.identity as Record<string, unknown>;
  return (
    value.commandId === command.commandId &&
    identity.surfaceId === command.identity.surfaceId &&
    identity.kind === command.identity.kind &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= command.expectedRevision
  );
}

function commandFailureReason(ack: unknown): string | undefined {
  if (typeof ack !== 'object' || ack === null) return undefined;
  const reason = (ack as Record<string, unknown>).reason;
  return typeof reason === 'string' ? reason : undefined;
}

function lifecycleOptions(
  db: NonNullable<SmrtClassOptions['db']>,
): Omit<ReportLifecycleOptions, 'db'> {
  // Lifecycle has no caller-controlled authority fields. This small helper
  // makes the export tool request the report's tenant-safe freshness snapshot.
  void db;
  return {};
}

/**
 * Build generic report discovery/query tools plus report-only operational
 * tools. Every report is looked up from a server-owned catalog per live run.
 */
export function createReportDataSurfaceTools(
  options: ReportDataSurfaceToolsOptions,
): PrincipalTool[] {
  const generic = createDataSurfaceTools({
    ...options.dataSurface,
    surfaces: (run) => dataSurfaceCatalog(options, run),
  });

  const query = aiTool(
    REPORT_QUERY_TOOL_SLUG,
    REPORT_QUERY_FUNCTION_NAME,
    'Run a bounded report query silently, in the background, or with an acknowledged browser update.',
    {
      type: 'object',
      required: ['reportId', 'request'],
      properties: {
        reportId: { type: 'string' },
        request: { type: 'object' },
        execution: { enum: ['silent', 'background', 'visible'] },
        expectedRevision: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
    async ({ run, args, db }) => {
      run.assertToolAllowed(REPORT_QUERY_TOOL_SLUG);
      const { definition, descriptor } = await reportEntry(
        options,
        run,
        args.reportId,
      );
      const request = normalizeDataQueryRequest(
        args.request,
        descriptor.schema,
      );
      let execution: 'silent' | 'background' | 'visible' = 'silent';
      if (args.execution !== undefined) {
        if (
          args.execution !== 'silent' &&
          args.execution !== 'background' &&
          args.execution !== 'visible'
        ) {
          throw new ReportDataSurfaceConfigurationError(
            'Report query execution is invalid',
          );
        }
        execution = args.execution;
      }
      const context: DataSurfaceExecutionContext = {
        run,
        principal: principalFromRun(run),
        db,
        signal: new AbortController().signal,
      };
      const reportDb = reportDatabase(run, db);
      const base = {
        ...(await readOptions(definition, context)),
        ...(reportDb
          ? { db: reportDb, lifecycle: lifecycleOptions(reportDb) }
          : {}),
      };
      if (execution === 'background') {
        if (!definition.enqueueBackgroundQuery) {
          throw new ReportDataSurfaceConfigurationError(
            'This report does not expose a background query host',
          );
        }
        const result = await queryReportMaterializedRows(
          definition.report,
          request,
          {
            ...base,
            adapter: definition.adapter,
            execution: 'background',
            enqueueBackgroundQuery: (task) =>
              definition.enqueueBackgroundQuery?.(task, { run }) ??
              Promise.reject(
                new ReportDataSurfaceConfigurationError(
                  'This report does not expose a background query host',
                ),
              ),
          },
        );
        await audit(options, 'query', descriptor.resourceId, run);
        return result;
      }

      const result =
        execution === 'silent'
          ? await queryReportMaterializedRows(definition.report, request, {
              ...base,
              adapter: definition.adapter,
              execution: 'silent',
            })
          : await queryReportMaterializedRows(definition.report, request, {
              ...base,
              adapter: definition.adapter,
              execution: 'visible',
            });
      if (execution === 'silent') {
        await audit(options, 'query', descriptor.resourceId, run);
        return result;
      }

      if (!definition.visible) {
        throw new ReportDataSurfaceConfigurationError(
          'This report does not expose a browser-visible query host',
        );
      }
      const expectedRevision = args.expectedRevision;
      if (
        typeof expectedRevision !== 'number' ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0
      ) {
        throw new ReportDataSurfaceConfigurationError(
          'Visible report queries require a non-negative expectedRevision',
        );
      }
      const command: ReportDataSurfaceVisibleCommand = {
        version: 1,
        commandId: randomUUID(),
        identity: { surfaceId: descriptor.resourceId, kind: 'report' },
        expectedRevision,
        controlId: 'query',
        payload: { request },
      };
      const acknowledged = await definition.visible.send(command, { run });
      if (
        !commandResultIsBound(acknowledged, command) ||
        acknowledged.ok !== true
      ) {
        throw new ReportDataSurfaceVisibleError(
          commandFailureReason(acknowledged),
        );
      }
      await audit(options, 'query', descriptor.resourceId, run);
      return { ...result, browser: acknowledged };
    },
  );

  const refresh = aiTool(
    REPORT_REFRESH_TOOL_SLUG,
    REPORT_REFRESH_FUNCTION_NAME,
    'Preview or apply an authorized, audited report refresh.',
    {
      type: 'object',
      required: ['reportId', 'phase'],
      properties: {
        reportId: { type: 'string' },
        phase: { enum: ['preview', 'apply'] },
        mode: { enum: ['rebuild', 'incremental'] },
      },
      additionalProperties: false,
    },
    async ({ run, args, db }) => {
      run.assertToolAllowed(REPORT_REFRESH_TOOL_SLUG);
      const { definition, descriptor } = await reportEntry(
        options,
        run,
        args.reportId,
      );
      if (!definition.refresh) {
        throw new ReportDataSurfaceConfigurationError(
          'This report does not expose refresh',
        );
      }
      if (args.phase !== 'preview' && args.phase !== 'apply') {
        throw new ReportDataSurfaceConfigurationError(
          'Report refresh phase is invalid',
        );
      }
      const mode =
        args.mode === undefined
          ? undefined
          : args.mode === 'rebuild' || args.mode === 'incremental'
            ? args.mode
            : (() => {
                throw new ReportDataSurfaceConfigurationError(
                  'Report refresh mode is invalid',
                );
              })();
      const host = await definition.refresh.actionHost({ run });
      const lifecycleDb = requireDatabase(run, db);
      const result: ReportRefreshPreview | AppliedReportRefresh =
        args.phase === 'preview'
          ? await previewReportRefresh(definition.report, {
              db: lifecycleDb,
              host,
              mode,
              refreshAction: descriptor.refresh.action,
            })
          : await applyReportRefresh(definition.report, {
              db: lifecycleDb,
              host,
              mode,
              ...definition.refresh.options,
              refreshAction: descriptor.refresh.action,
            });
      await audit(options, 'refresh', descriptor.resourceId, run);
      return result;
    },
  );

  const drilldown = aiTool(
    REPORT_DRILLDOWN_TOOL_SLUG,
    REPORT_DRILLDOWN_FUNCTION_NAME,
    'Create a principal-bound source drilldown from one readable materialized report row.',
    {
      type: 'object',
      required: ['reportId', 'rowId'],
      properties: { reportId: { type: 'string' }, rowId: { type: 'string' } },
      additionalProperties: false,
    },
    async ({ run, args, db }) => {
      run.assertToolAllowed(REPORT_DRILLDOWN_TOOL_SLUG);
      if (typeof options.audit !== 'function') {
        throw new ReportDataSurfaceConfigurationError(
          'Report drilldown requires a live audit sink',
        );
      }
      const { definition, descriptor } = await reportEntry(
        options,
        run,
        args.reportId,
      );
      const rowId = requiredString(args.rowId, 'rowId');
      const reportDb = reportDatabase(run, db);
      const context: DataSurfaceExecutionContext = {
        run,
        principal: principalFromRun(run),
        db: reportDb,
        signal: new AbortController().signal,
      };
      const result = await queryReportMaterializedRows(
        definition.report,
        {
          version: 1,
          requestId: randomUUID(),
          mode: 'rows',
          projection: descriptor.drilldown.fields.map((field) => field.id),
          filter: {
            kind: 'condition',
            field: 'id',
            operator: 'eq',
            value: rowId,
          },
          page: { kind: 'offset', offset: 0, limit: 1 },
        },
        {
          ...(await readOptions(definition, context)),
          adapter: definition.adapter,
          ...(reportDb ? { db: reportDb } : {}),
          execution: 'silent',
        },
      );
      if (result.rows.length !== 1) throw new DataSurfaceDeniedError();
      const handoff = await buildReportDrilldownQuery(
        definition.report,
        result.rows[0],
        definition.adapter,
      );
      await audit(options, 'drilldown', descriptor.resourceId, run);
      return handoff;
    },
  );

  const exportTool = aiTool(
    REPORT_EXPORT_TOOL_SLUG,
    REPORT_EXPORT_FUNCTION_NAME,
    'Preview or apply a principal-bound, snapshot-verified report export.',
    {
      type: 'object',
      required: ['reportId', 'phase', 'query', 'format'],
      properties: {
        reportId: { type: 'string' },
        phase: { enum: ['preview', 'apply'] },
        query: { type: 'object' },
        format: { enum: ['csv', 'json'] },
        limits: { type: 'object' },
        confirmed: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    async ({ run, args, db }) => {
      run.assertToolAllowed(REPORT_EXPORT_TOOL_SLUG);
      const { definition, descriptor } = await reportEntry(
        options,
        run,
        args.reportId,
      );
      if (!definition.export) {
        throw new ReportDataSurfaceConfigurationError(
          'This report does not expose export',
        );
      }
      if (args.phase !== 'preview' && args.phase !== 'apply') {
        throw new ReportDataSurfaceConfigurationError(
          'Report export phase is invalid',
        );
      }
      const exportDb = requireDatabase(run, db);
      const context: DataSurfaceExecutionContext = {
        run,
        principal: principalFromRun(run),
        db: exportDb,
        signal: new AbortController().signal,
      };
      const result = await queryReportMaterializedRows(
        definition.report,
        args.query,
        {
          ...(await readOptions(definition, context)),
          adapter: definition.adapter,
          db: exportDb,
          lifecycle: lifecycleOptions(exportDb),
          execution: 'silent',
        },
      );
      const binding = await definition.export.captureSnapshot({
        run,
        descriptor,
        result,
      });
      const snapshot = createReportExportSnapshot(
        descriptor,
        args.query,
        result,
        binding,
      );
      const request = createReportExportRequest(descriptor, snapshot, {
        format: args.format,
        ...(args.limits === undefined ? {} : { limits: args.limits }),
      });
      const host = await definition.export.actionHost({ run });
      const exported: ReportExportPreview | AppliedReportExport =
        args.phase === 'preview'
          ? await previewReportExport(descriptor, request, host)
          : await applyReportExport(descriptor, request, host, {
              confirmed: args.confirmed === true,
            });
      await audit(options, 'export', descriptor.resourceId, run);
      return exported;
    },
  );

  return [...generic, query, refresh, drilldown, exportTool];
}
