/**
 * Principal-bound, read-only data-surface tools (#2447).
 *
 * This module deliberately does not know how an application discovers or
 * executes a surface.  Applications provide a small, server-side catalog and
 * executor; this package supplies the principal, allow-list, catalog/RBAC,
 * tenant, projection, ordering, and result-boundary enforcement around them.
 */

import type { AITool } from '@happyvertical/ai';
import {
  createDataQueryFingerprint,
  normalizeDataQueryRequest,
  normalizeDataQueryResult,
  normalizeDataQuerySchema,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import type {
  DataQueryRequest,
  DataQueryResult,
  DataQueryRow,
  DataQuerySchema,
} from '@happyvertical/smrt-types';
import type { PrincipalRun } from './execute-as-principal.js';
import type { PrincipalTool, PrincipalToolContext } from './invoke-agent.js';

export const DATA_DISCOVER_TOOL_SLUG = 'data.discover';
export const DATA_INSPECT_TOOL_SLUG = 'data.inspect';
export const DATA_QUERY_TOOL_SLUG = 'data.query';

export const DATA_DISCOVER_FUNCTION_NAME = 'data-discover';
export const DATA_INSPECT_FUNCTION_NAME = 'data-inspect';
export const DATA_QUERY_FUNCTION_NAME = 'data-query';

export const DEFAULT_DATA_SURFACE_DEADLINE_MS = 5_000;
export const MAX_DATA_SURFACE_DEADLINE_MS = 30_000;

/** A server-owned data source. Never construct this from model/tool input. */
export interface DataSurfaceDefinition {
  /** Stable opaque id presented to the model. */
  id: string;
  /** Permission-catalog collection used for the read gate. */
  collection: string;
  /** Optional backing SMRT class, useful to registry-backed executors. */
  className?: string;
  label?: string;
  description?: string;
  schema: DataQuerySchema;
  /** Optional surface-specific executor. */
  execute?: DataSurfaceExecutor;
}

export interface DataSurfacePrincipal {
  /** The authenticated execution principal, copied from the live run. */
  userId: string;
  /** The authenticated tenant scope, copied from the live run. */
  tenantId: string | null;
}

export interface DataSurfaceExecutionContext {
  run: PrincipalRun;
  principal: DataSurfacePrincipal;
  db?: SmrtClassOptions['db'];
  /** Signal for adapters that can cancel database work. */
  signal: AbortSignal;
}

export type DataSurfaceExecutorResult =
  | DataQueryResult
  | DataQueryRow[]
  | {
      rows?: DataQueryRow[];
      total?: DataQueryResult['total'];
      facets?: DataQueryResult['facets'];
      freshness?: DataQueryResult['freshness'];
      warnings?: string[];
      truncated?: boolean;
      nextCursor?: string;
    };

export type DataSurfaceExecutor = (
  surface: DataSurfaceDefinition,
  request: DataQueryRequest,
  context: DataSurfaceExecutionContext,
) => Promise<DataSurfaceExecutorResult>;

export interface DataSurfaceAuditEntry {
  action: 'discover' | 'inspect' | 'query';
  surfaceId?: string;
  requestId?: string;
  userId: string;
  tenantId: string | null;
  rowCount?: number;
  truncated?: boolean;
}

export type DataSurfaceAuditSink = (
  entry: DataSurfaceAuditEntry,
) => void | Promise<void>;

type DataSurfaceAuditInput = Omit<DataSurfaceAuditEntry, 'userId' | 'tenantId'>;

export interface DataSurfaceToolsOptions {
  /** Server-owned catalog. A function is evaluated per authenticated run. */
  surfaces:
    | readonly DataSurfaceDefinition[]
    | ((
        run: PrincipalRun,
      ) =>
        | readonly DataSurfaceDefinition[]
        | Promise<readonly DataSurfaceDefinition[]>);
  /** Shared executor used when a definition does not provide one. */
  execute?: DataSurfaceExecutor;
  /** Audit sink for individual tool actions. */
  audit?: DataSurfaceAuditSink;
  /** Deadline for an adapter call. Defaults to five seconds. */
  deadlineMs?: number;
}

export class DataSurfaceDeniedError extends Error {
  readonly status = 403;

  constructor() {
    // Deliberately generic: callers must not learn whether a surface exists.
    super('Data surface is not available.');
    this.name = 'DataSurfaceDeniedError';
  }
}

export class DataSurfaceDeadlineError extends Error {
  readonly status = 504;

  constructor() {
    super('Data surface query exceeded its execution deadline.');
    this.name = 'DataSurfaceDeadlineError';
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function principalFromRun(run: PrincipalRun): DataSurfacePrincipal {
  const userId = run.context.userId;
  if (!userId) throw new DataSurfaceDeniedError();
  return { userId, tenantId: run.context.tenantId };
}

function visibleSchema(
  schema: DataQuerySchema,
  run: PrincipalRun,
): DataQuerySchema {
  const fields = schema.fields.filter((field) => {
    const extended = field as typeof field & {
      sensitive?: boolean;
      readPermission?: string;
      _meta?: { sensitive?: boolean; readPermission?: string };
    };
    if (extended.sensitive === true || extended._meta?.sensitive === true)
      return false;
    const readPermission =
      extended.readPermission ?? extended._meta?.readPermission;
    if (readPermission && !run.permissions.includes(readPermission)) {
      return false;
    }
    return true;
  });
  if (!fields.some((field) => field.id === schema.identityField)) {
    throw new DataSurfaceDeniedError();
  }
  return normalizeDataQuerySchema({ ...schema, fields });
}

function descriptor(surface: DataSurfaceDefinition, schema: DataQuerySchema) {
  return {
    id: surface.id,
    label: surface.label ?? surface.id,
    ...(surface.description ? { description: surface.description } : {}),
    collection: surface.collection,
    identityField: schema.identityField,
    fields: schema.fields.map((field) => ({
      id: field.id,
      type: field.type,
      projectable: field.projectable !== false,
      sortable: field.sortable === true,
      facetable: field.facetable === true,
      filterOperators: [...(field.filterOperators ?? [])].sort(),
    })),
    supports: schema.supports ?? {},
    limits: {
      defaultPageLimit: schema.defaultPageLimit,
      maxPageLimit: schema.maxPageLimit,
      maxResultBytes: schema.maxResultBytes,
    },
  };
}

async function availableSurfaces(
  options: DataSurfaceToolsOptions,
  run: PrincipalRun,
): Promise<Array<{ surface: DataSurfaceDefinition; schema: DataQuerySchema }>> {
  const configured =
    typeof options.surfaces === 'function'
      ? await options.surfaces(run)
      : options.surfaces;
  const result: Array<{
    surface: DataSurfaceDefinition;
    schema: DataQuerySchema;
  }> = [];
  for (const surface of configured) {
    if (
      !surface ||
      !nonEmptyString(surface.id) ||
      !nonEmptyString(surface.collection)
    )
      continue;
    try {
      // A missing catalog permission is intentionally indistinguishable from a
      // missing surface.  The allow-list gate is checked before this function.
      await run.assertOperation(surface.collection, 'read');
      result.push({ surface, schema: visibleSchema(surface.schema, run) });
    } catch {
      // Do not leak unauthorized surface ids, schemas, or permission errors.
    }
  }
  return result.sort((left, right) =>
    left.surface.id.localeCompare(right.surface.id),
  );
}

function findSurface(
  surfaces: Array<{ surface: DataSurfaceDefinition; schema: DataQuerySchema }>,
  id: unknown,
) {
  return surfaces.find((entry) => entry.surface.id === id);
}

function sortRows(
  rows: DataQueryRow[],
  request: DataQueryRequest,
  identity: string,
): DataQueryRow[] {
  const terms = request.sort ?? [];
  const compare = (left: unknown, right: unknown): number => {
    if (left === right) return 0;
    if (left === null || left === undefined) return -1;
    if (right === null || right === undefined) return 1;
    return String(left).localeCompare(String(right));
  };
  return [...rows].sort((left, right) => {
    for (const term of terms) {
      const result = compare(left[term.field], right[term.field]);
      if (result !== 0) return term.direction === 'desc' ? -result : result;
    }
    return compare(left[identity], right[identity]);
  });
}

async function bounded<T>(
  promise: Promise<T>,
  deadlineMs: number,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Adapters may observe this signal and cancel their database request.
      controller.abort();
      reject(new DataSurfaceDeadlineError());
    }, deadlineMs);
  });
  const abort = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(new DataSurfaceDeadlineError()),
      { once: true },
    );
  });
  try {
    return await Promise.race([promise, timeout, abort]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function requestFromArgs(args: Record<string, unknown>): unknown {
  return args.request ?? args;
}

function tool(
  slug: string,
  functionName: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: (context: PrincipalToolContext) => Promise<unknown>,
): PrincipalTool {
  const aiTool: AITool = {
    type: 'function',
    function: { name: functionName, description, parameters },
  };
  return { slug, aiTool, execute };
}

/** Build the discover/inspect/query tools for a persona conversation. */
export function createDataSurfaceTools(
  options: DataSurfaceToolsOptions,
): PrincipalTool[] {
  const deadlineMs = Math.min(
    Math.max(options.deadlineMs ?? DEFAULT_DATA_SURFACE_DEADLINE_MS, 1),
    MAX_DATA_SURFACE_DEADLINE_MS,
  );
  const audit = async (
    entry: DataSurfaceAuditInput,
    run: PrincipalRun,
  ): Promise<void> => {
    const principal = principalFromRun(run);
    await options.audit?.({ ...entry, ...principal });
  };

  const discover = tool(
    DATA_DISCOVER_TOOL_SLUG,
    DATA_DISCOVER_FUNCTION_NAME,
    'List data surfaces and their safe, readable fields.',
    { type: 'object', properties: {}, additionalProperties: false },
    async ({ run }) => {
      run.assertToolAllowed(DATA_DISCOVER_TOOL_SLUG);
      const entries = await availableSurfaces(options, run);
      await audit({ action: 'discover' }, run);
      return entries.map(({ surface, schema }) => descriptor(surface, schema));
    },
  );

  const inspect = tool(
    DATA_INSPECT_TOOL_SLUG,
    DATA_INSPECT_FUNCTION_NAME,
    'Inspect one readable data surface schema.',
    {
      type: 'object',
      required: ['surfaceId'],
      properties: { surfaceId: { type: 'string' } },
      additionalProperties: false,
    },
    async ({ run, args }) => {
      run.assertToolAllowed(DATA_INSPECT_TOOL_SLUG);
      const entry = findSurface(
        await availableSurfaces(options, run),
        args.surfaceId,
      );
      if (!entry) throw new DataSurfaceDeniedError();
      await audit({ action: 'inspect', surfaceId: entry.surface.id }, run);
      return descriptor(entry.surface, entry.schema);
    },
  );

  const query = tool(
    DATA_QUERY_TOOL_SLUG,
    DATA_QUERY_FUNCTION_NAME,
    'Run a bounded read query against one readable data surface.',
    {
      type: 'object',
      required: ['surfaceId', 'request'],
      properties: {
        surfaceId: { type: 'string' },
        request: { type: 'object' },
      },
      additionalProperties: false,
    },
    async ({ run, args, db }) => {
      run.assertToolAllowed(DATA_QUERY_TOOL_SLUG);
      const entry = findSurface(
        await availableSurfaces(options, run),
        args.surfaceId,
      );
      if (!entry) throw new DataSurfaceDeniedError();
      const request = normalizeDataQueryRequest(
        requestFromArgs(args),
        entry.schema,
      );
      const principal = principalFromRun(run);
      const signal = new AbortController();
      const executor = entry.surface.execute ?? options.execute;
      if (!executor) throw new DataSurfaceDeniedError();
      const raw = await bounded(
        executor(entry.surface, request, {
          run,
          principal,
          db: run.context.database ?? db,
          signal: signal.signal,
        }),
        deadlineMs,
        signal,
      );
      const rawRecord = record(raw);
      const rows = Array.isArray(raw)
        ? raw
        : Array.isArray(rawRecord.rows)
          ? (rawRecord.rows as DataQueryRow[])
          : [];
      const normalizedRows =
        request.mode === 'rows'
          ? sortRows(rows, request, entry.schema.identityField)
          : [];
      const validated = normalizeDataQueryResult(
        raw && !Array.isArray(raw) && 'version' in rawRecord
          ? raw
          : {
              version: 1,
              requestId: request.requestId,
              queryFingerprint: createDataQueryFingerprint(
                request,
                entry.schema,
              ),
              identityField: entry.schema.identityField,
              rows: normalizedRows,
              ...(request.page
                ? {
                    page:
                      request.page.kind === 'offset'
                        ? {
                            kind: 'offset',
                            offset: request.page.offset,
                            limit: request.page.limit,
                            hasMore: Boolean(rawRecord.nextCursor),
                          }
                        : {
                            kind: 'cursor',
                            limit: request.page.limit,
                            hasMore: Boolean(rawRecord.nextCursor),
                            ...(rawRecord.nextCursor
                              ? { nextCursor: rawRecord.nextCursor }
                              : {}),
                          },
                  }
                : {}),
              total: rawRecord.total ?? { kind: 'unavailable' },
              ...(rawRecord.facets ? { facets: rawRecord.facets } : {}),
              freshness: rawRecord.freshness ?? { state: 'unknown' },
              warnings: Array.isArray(rawRecord.warnings)
                ? rawRecord.warnings
                : [],
              truncated: rawRecord.truncated === true,
            },
        request,
        entry.schema,
      );
      // Adapters are free to use different storage engines, but the model
      // must see one deterministic order. The identity is the stable final
      // tie-breaker even when the adapter supplied a sort.
      const result: DataQueryResult = {
        ...validated,
        rows:
          request.mode === 'rows'
            ? sortRows(validated.rows, request, entry.schema.identityField)
            : validated.rows,
      };
      await audit(
        {
          action: 'query',
          surfaceId: entry.surface.id,
          requestId: result.requestId,
          rowCount: result.rows.length,
          truncated: result.truncated,
        },
        run,
      );
      return result;
    },
  );

  return [discover, inspect, query];
}
