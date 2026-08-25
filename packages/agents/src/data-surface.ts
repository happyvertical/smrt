/**
 * Principal-bound, read-only data-surface tools (#2447).
 *
 * This module deliberately does not know how an application discovers or
 * executes a surface.  Applications provide a small, server-side catalog and
 * executor; this package supplies the principal, allow-list, catalog/RBAC,
 * tenant, projection, ordering, and result-boundary enforcement around them.
 */

import { createHash } from 'node:crypto';
import type { AITool } from '@happyvertical/ai';
import {
  createDataQueryFingerprint,
  DataQueryValidationError,
  DEFAULT_DATA_QUERY_RESULT_BYTES,
  MAX_DATA_QUERY_FILTERS,
  MAX_DATA_QUERY_REQUEST_BYTES,
  normalizeDataQueryRequest,
  normalizeDataQueryResult,
  normalizeDataQuerySchema,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import type {
  DataQueryFieldDescriptor,
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

/** Declarative, non-authoritative metadata that a server-owned catalog may expose. */
export type DataSurfaceMetadataValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<string | number | boolean | null>;

export type DataSurfaceFieldMetadata = Readonly<
  Record<string, DataSurfaceMetadataValue>
>;

/** Surface-level metadata is descriptive only; it never enters query normalization. */
export type DataSurfaceMetadata = Readonly<
  Record<string, DataSurfaceMetadataValue>
>;

/** A data field plus server-owned visibility policy annotations. */
export interface DataSurfaceField extends DataQueryFieldDescriptor {
  sensitive?: boolean;
  readPermission?: string;
  metadata?: DataSurfaceFieldMetadata;
}

/** Server-owned schema; policy annotations never cross the core query boundary. */
export interface DataSurfaceSchema extends Omit<DataQuerySchema, 'fields'> {
  fields: DataSurfaceField[];
}

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
  /** Safe catalog metadata, returned only after the read gate succeeds. */
  metadata?: DataSurfaceMetadata;
  schema: DataSurfaceSchema;
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
      hasMore?: boolean;
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
  /** Receives detailed server-side failures; never surfaced to the model. */
  onFailure?: DataSurfaceFailureSink;
}

export interface DataSurfaceFailureEntry {
  action: 'discover' | 'inspect' | 'query';
  surfaceId?: string;
  requestId?: string;
  userId: string;
  tenantId: string | null;
  error: unknown;
}

export type DataSurfaceFailureSink = (
  entry: DataSurfaceFailureEntry,
) => void | Promise<void>;

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

/** Adapter output was not in the requested deterministic order. */
export class DataSurfaceResultOrderError extends Error {
  readonly status = 502;

  constructor() {
    // Do not include field/row values in the public error.
    super('Data surface returned results in an invalid order.');
    this.name = 'DataSurfaceResultOrderError';
  }
}

/** Stable public failure for executor and result-boundary errors. */
export class DataSurfaceQueryError extends Error {
  readonly status = 502;
  readonly code = 'DATA_SURFACE_QUERY_FAILED';

  constructor() {
    super('Data surface query failed.');
    this.name = 'DataSurfaceQueryError';
  }
}

// Audit failures are reported at the point where the audit sink rejects. Keep
// the wrapped public error marked so the query boundary does not report it a
// second time when it unwinds through the outer executor catch.
const reportedFailureErrors = new WeakSet<object>();

/** Stable public failure for requests that name hidden schema capabilities. */
export class DataSurfaceRequestError extends Error {
  readonly status = 400;
  readonly code = 'DATA_SURFACE_REQUEST_INVALID';

  constructor() {
    super('Data surface query request is invalid.');
    this.name = 'DataSurfaceRequestError';
  }
}

const HIDDEN_SCHEMA_REQUEST_CODES = new Set([
  'DATA_QUERY_FIELD_NOT_ALLOWED',
  'DATA_QUERY_PROJECTION_NOT_ALLOWED',
  'DATA_QUERY_SORT_NOT_ALLOWED',
  'DATA_QUERY_FACET_NOT_ALLOWED',
]);

function normalizeSurfaceRequest(
  value: unknown,
  schema: DataQuerySchema,
): DataQueryRequest {
  try {
    return normalizeDataQueryRequest(value, schema);
  } catch (error) {
    if (
      error instanceof DataQueryValidationError &&
      HIDDEN_SCHEMA_REQUEST_CODES.has(error.code)
    ) {
      throw new DataSurfaceRequestError();
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDataQueryRows(value: unknown[]): value is DataQueryRow[] {
  return value.every(isRecord);
}

function dataQueryRowsOrThrow(value: unknown[]): DataQueryRow[] {
  if (!isDataQueryRows(value)) throw new DataSurfaceQueryError();
  return value;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function principalFromRun(run: PrincipalRun): DataSurfacePrincipal {
  const userId = run.context.userId;
  if (!userId) throw new DataSurfaceDeniedError();
  return { userId, tenantId: run.context.tenantId };
}

function coreSchema(schema: DataSurfaceSchema): DataQuerySchema {
  return {
    ...schema,
    fields: schema.fields.map(
      ({
        sensitive: _sensitive,
        readPermission: _readPermission,
        metadata: _metadata,
        ...field
      }) => field,
    ),
  };
}

function visibleSchema(
  schema: DataSurfaceSchema,
  run: PrincipalRun,
): DataQuerySchema {
  const fields = schema.fields.filter((field) => {
    if (field.sensitive === true) return false;
    const readPermission = field.readPermission;
    if (readPermission && !run.permissions.includes(readPermission)) {
      return false;
    }
    return true;
  });
  if (!fields.some((field) => field.id === schema.identityField)) {
    throw new DataSurfaceDeniedError();
  }
  return normalizeDataQuerySchema(coreSchema({ ...schema, fields }));
}

function descriptor(surface: DataSurfaceDefinition, schema: DataQuerySchema) {
  const metadataByFieldId = new Map(
    surface.schema.fields.map((field) => [field.id, field.metadata]),
  );
  return {
    id: surface.id,
    label: surface.label ?? surface.id,
    ...(surface.description ? { description: surface.description } : {}),
    ...(surface.metadata ? { metadata: surface.metadata } : {}),
    collection: surface.collection,
    identityField: schema.identityField,
    fields: schema.fields.map((field) => ({
      id: field.id,
      type: field.type,
      projectable: field.projectable !== false,
      sortable: field.sortable === true,
      facetable: field.facetable === true,
      filterOperators: [...(field.filterOperators ?? [])].sort(),
      ...(metadataByFieldId.get(field.id)
        ? { metadata: metadataByFieldId.get(field.id) }
        : {}),
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
    left.surface.id === right.surface.id
      ? 0
      : left.surface.id < right.surface.id
        ? -1
        : 1,
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
  schema: DataQuerySchema,
): DataQueryRow[] {
  const terms = request.sort ?? [];
  return [...rows].sort((left, right) =>
    compareRows(left, right, terms, schema),
  );
}

function compareDataValues(
  left: unknown,
  right: unknown,
  type: DataQuerySchema['fields'][number]['type'],
): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (type === 'number') return Number(left) - Number(right);
  if (type === 'datetime') {
    const leftTime = Date.parse(String(left));
    const rightTime = Date.parse(String(right));
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
      return leftTime - rightTime;
    }
  }
  if (type === 'boolean') return Number(Boolean(left)) - Number(Boolean(right));
  const leftString = String(left);
  const rightString = String(right);
  return leftString === rightString ? 0 : leftString < rightString ? -1 : 1;
}

function compareRows(
  left: DataQueryRow,
  right: DataQueryRow,
  terms: readonly NonNullable<DataQueryRequest['sort']>[number][],
  schema: DataQuerySchema,
): number {
  for (const term of terms) {
    const type =
      schema.fields.find((field) => field.id === term.field)?.type ?? 'string';
    const result = compareDataValues(left[term.field], right[term.field], type);
    if (result !== 0) return term.direction === 'desc' ? -result : result;
  }
  const identityType =
    schema.fields.find((field) => field.id === schema.identityField)?.type ??
    'string';
  return compareDataValues(
    left[schema.identityField],
    right[schema.identityField],
    identityType,
  );
}

function isCanonicalOrder(
  rows: DataQueryRow[],
  request: DataQueryRequest,
  schema: DataQuerySchema,
): boolean {
  const terms = request.sort ?? [];
  for (let index = 1; index < rows.length; index += 1) {
    if (compareRows(rows[index - 1], rows[index], terms, schema) > 0) {
      return false;
    }
  }
  return true;
}

function projectionForResult(request: DataQueryRequest): string[] {
  return request.projection ?? [];
}

function externalValidationRequest(
  request: DataQueryRequest,
  schema: DataQuerySchema,
): DataQueryRequest {
  if (
    request.mode !== 'rows' ||
    !request.projection ||
    request.projection.length <= MAX_DATA_QUERY_FILTERS
  ) {
    return request;
  }
  return {
    ...request,
    projection: request.projection.filter(
      (field) => field !== schema.identityField,
    ),
  };
}

function canonicalRequestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalRequestValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalRequestValue(value[key])]),
    );
  }
  return value;
}

/**
 * Create the fingerprint for the already-normalized request passed to a
 * surface executor. This supports internal projections beyond core's public
 * 50-field projection limit; callers must use the exact request received.
 */
export function createDataSurfaceQueryFingerprint(
  request: DataQueryRequest,
): string {
  const { requestId: _requestId, page: _page, ...semanticQuery } = request;
  return `dq1_${createHash('sha256')
    .update(JSON.stringify(canonicalRequestValue(semanticQuery)))
    .digest('base64url')}`;
}

function shorthandResultCandidate(
  request: DataQueryRequest,
  schema: DataQuerySchema,
  rawRecord: Record<string, unknown> | undefined,
  rows: readonly unknown[],
): Record<string, unknown> {
  const rawPage = isRecord(rawRecord?.page) ? rawRecord.page : undefined;
  const explicitHasMore =
    typeof rawPage?.hasMore === 'boolean'
      ? rawPage.hasMore
      : typeof rawRecord?.hasMore === 'boolean'
        ? rawRecord.hasMore
        : undefined;
  const nextCursor =
    typeof rawPage?.nextCursor === 'string'
      ? rawPage.nextCursor
      : typeof rawRecord?.nextCursor === 'string'
        ? rawRecord.nextCursor
        : undefined;
  if (
    request.page &&
    rows.length === request.page.limit &&
    explicitHasMore === undefined &&
    !nextCursor
  ) {
    // An exact-limit shorthand page may have more rows. Require the adapter
    // to provide continuation metadata instead of falsely declaring a final
    // page and silently truncating a result set.
    throw new DataSurfaceQueryError();
  }
  return {
    version: 1,
    requestId: request.requestId,
    queryFingerprint: createDataQueryFingerprint(request, schema),
    identityField: schema.identityField,
    rows,
    ...(request.page
      ? {
          page:
            request.page.kind === 'offset'
              ? {
                  kind: 'offset',
                  offset: request.page.offset,
                  limit: request.page.limit,
                  hasMore: explicitHasMore ?? Boolean(nextCursor),
                }
              : {
                  kind: 'cursor',
                  limit: request.page.limit,
                  hasMore: explicitHasMore ?? Boolean(nextCursor),
                  ...(nextCursor ? { nextCursor } : {}),
                },
        }
      : {}),
    total: rawRecord?.total ?? { kind: 'unavailable' },
    ...(rawRecord?.facets ? { facets: rawRecord.facets } : {}),
    freshness: rawRecord?.freshness ?? { state: 'unknown' },
    warnings: Array.isArray(rawRecord?.warnings) ? rawRecord.warnings : [],
    truncated: rawRecord?.truncated === true,
  };
}

function normalizeWideRows(
  rawRecord: Record<string, unknown> | undefined,
  rawRows: unknown[],
  request: DataQueryRequest,
  resultRequest: DataQueryRequest,
  schema: DataQuerySchema,
  internal: { request: DataQueryRequest; schema: DataQuerySchema },
): DataQueryResult {
  const hasVersionedResult =
    rawRecord !== undefined && Object.hasOwn(rawRecord, 'version');
  if (
    hasVersionedResult &&
    (rawRecord.version !== 1 ||
      rawRecord.requestId !== internal.request.requestId ||
      rawRecord.identityField !== internal.schema.identityField ||
      rawRecord.queryFingerprint !==
        createDataSurfaceQueryFingerprint(internal.request))
  ) {
    throw new DataSurfaceQueryError();
  }
  const requestedFields = resultRequest.projection ?? [schema.identityField];
  const sortOnlyFields = new Set(
    (request.sort ?? [])
      .map((term) => term.field)
      .filter((field) => !requestedFields.includes(field)),
  );
  const chunkSize = MAX_DATA_QUERY_FILTERS - 1;
  const chunks: DataQueryResult[] = [];
  for (let offset = 0; offset < requestedFields.length; offset += chunkSize) {
    const fields = requestedFields.slice(offset, offset + chunkSize);
    const allowedFields = new Set([
      schema.identityField,
      ...requestedFields,
      ...sortOnlyFields,
    ]);
    const chunkFields = new Set([schema.identityField, ...fields]);
    const chunkRows = rawRows.map((row) => {
      if (!isRecord(row)) return row;
      if (Object.keys(row).some((field) => !allowedFields.has(field))) {
        return row;
      }
      return Object.fromEntries(
        Object.entries(row).filter(([field]) => chunkFields.has(field)),
      );
    });
    // Chunk validation checks field values and page bounds; ordering is
    // validated separately against the complete internal request below.
    const chunkRequest = { ...resultRequest, projection: fields, sort: [] };
    // Correlation fields on a versioned result are checked above before this
    // per-chunk validation envelope is constructed.  The chunk fingerprint
    // is necessarily different from the full internal projection's
    // fingerprint because core's normalizer has a 50-field projection cap.
    const candidate = hasVersionedResult
      ? {
          ...rawRecord,
          requestId: chunkRequest.requestId,
          queryFingerprint: createDataQueryFingerprint(chunkRequest, schema),
          identityField: schema.identityField,
          rows: chunkRows,
        }
      : shorthandResultCandidate(chunkRequest, schema, rawRecord, chunkRows);
    chunks.push(normalizeDataQueryResult(candidate, chunkRequest, schema));
  }
  if (chunks.length === 0) {
    throw new DataSurfaceQueryError();
  }
  const rows = chunks[0].rows.map((_, index) =>
    Object.assign({}, ...chunks.map((chunk) => chunk.rows[index])),
  );
  const result = {
    ...chunks[0],
    requestId: request.requestId,
    queryFingerprint: createDataSurfaceQueryFingerprint(request),
    identityField: schema.identityField,
    rows,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  if (bytes > (schema.maxResultBytes ?? DEFAULT_DATA_QUERY_RESULT_BYTES)) {
    throw new DataSurfaceQueryError();
  }
  return result;
}

function addSortOnlyValues(
  rows: DataQueryRow[],
  rawRows: DataQueryRow[],
  request: DataQueryRequest,
  internalSchema: DataQuerySchema,
  rawRecord: Record<string, unknown> | undefined,
): DataQueryRow[] {
  const projection = new Set(
    request.projection ?? [internalSchema.identityField],
  );
  const sortOnly = (request.sort ?? [])
    .map((term) => term.field)
    .filter((field) => !projection.has(field));
  if (sortOnly.length === 0) return rows;
  const chunkSize = MAX_DATA_QUERY_FILTERS - 1;
  const validatedChunks: DataQueryResult[] = [];
  for (let offset = 0; offset < sortOnly.length; offset += chunkSize) {
    const fields = sortOnly.slice(offset, offset + chunkSize);
    const validationProjection = [
      ...new Set([internalSchema.identityField, ...fields]),
    ].sort();
    const validationRequest = {
      ...request,
      projection: validationProjection,
      sort: [],
    };
    const validationRows = rawRows.map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(([field]) =>
          validationProjection.includes(field),
        ),
      ),
    );
    validatedChunks.push(
      normalizeDataQueryResult(
        shorthandResultCandidate(
          validationRequest,
          internalSchema,
          rawRecord,
          validationRows,
        ),
        validationRequest,
        internalSchema,
      ),
    );
  }
  return rows.map((row, index) => {
    const result = { ...row };
    for (const field of sortOnly) {
      for (const chunk of validatedChunks) {
        const validatedRow = chunk.rows[index];
        if (Object.hasOwn(validatedRow, field)) {
          result[field] = validatedRow[field];
          break;
        }
      }
    }
    return result;
  });
}

function buildInternalQuery(
  request: DataQueryRequest,
  schema: DataQuerySchema,
): { request: DataQueryRequest; schema: DataQuerySchema } {
  const sort = request.sort ?? [];
  if (request.mode !== 'rows' || sort.length === 0) {
    return { request, schema };
  }
  const sortFields = new Set(sort.map((term) => term.field));
  const internalSchema = {
    ...schema,
    fields: schema.fields.map((field) =>
      sortFields.has(field.id) ? { ...field, projectable: true } : field,
    ),
  };
  const projection = [
    ...new Set([
      ...(request.projection ?? [schema.identityField]),
      ...sortFields,
    ]),
  ].sort();
  const internalRequest = { ...request, projection };
  const requestBytes = new TextEncoder().encode(
    JSON.stringify(internalRequest),
  ).byteLength;
  if (requestBytes > MAX_DATA_QUERY_REQUEST_BYTES) {
    throw new DataSurfaceQueryError();
  }
  return {
    schema: internalSchema,
    request: internalRequest,
  };
}

function requireSortValues(
  rows: DataQueryRow[],
  request: DataQueryRequest,
): void {
  for (const row of rows) {
    for (const term of request.sort ?? []) {
      if (!Object.hasOwn(row, term.field)) {
        throw new DataSurfaceResultOrderError();
      }
    }
  }
}

function stripInternalProjection(
  rows: DataQueryRow[],
  request: DataQueryRequest,
): DataQueryRow[] {
  const projection = projectionForResult(request).filter(Boolean);
  return rows.map((row) =>
    Object.fromEntries(
      projection
        .filter((field) => Object.hasOwn(row, field))
        .map((field) => [field, row[field]]),
    ),
  );
}

async function reportFailure(
  options: DataSurfaceToolsOptions,
  run: PrincipalRun,
  action: DataSurfaceFailureEntry['action'],
  surfaceId: string | undefined,
  requestId: string | undefined,
  error: unknown,
): Promise<void> {
  try {
    const principal = principalFromRun(run);
    await options.onFailure?.({
      action,
      ...(surfaceId !== undefined ? { surfaceId } : {}),
      requestId,
      ...principal,
      error,
    });
  } catch {
    // Failure telemetry must never alter the stable public error contract.
  }
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
    try {
      const principal = principalFromRun(run);
      await options.audit?.({ ...entry, ...principal });
    } catch (error) {
      await reportFailure(
        options,
        run,
        entry.action,
        entry.surfaceId,
        entry.requestId,
        error,
      );
      const publicError = new DataSurfaceQueryError();
      reportedFailureErrors.add(publicError);
      throw publicError;
    }
  };
  const catalog = async (
    run: PrincipalRun,
    action: DataSurfaceFailureEntry['action'],
  ) => {
    try {
      return await availableSurfaces(options, run);
    } catch (error) {
      await reportFailure(options, run, action, undefined, undefined, error);
      throw new DataSurfaceQueryError();
    }
  };

  const discover = tool(
    DATA_DISCOVER_TOOL_SLUG,
    DATA_DISCOVER_FUNCTION_NAME,
    'List data surfaces and their safe, readable fields.',
    { type: 'object', properties: {}, additionalProperties: false },
    async ({ run }) => {
      run.assertToolAllowed(DATA_DISCOVER_TOOL_SLUG);
      const entries = await catalog(run, 'discover');
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
      const entry = findSurface(await catalog(run, 'inspect'), args.surfaceId);
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
      const entry = findSurface(await catalog(run, 'query'), args.surfaceId);
      if (!entry) throw new DataSurfaceDeniedError();
      const request = normalizeSurfaceRequest(
        requestFromArgs(args),
        entry.schema,
      );
      const principal = principalFromRun(run);
      const signal = new AbortController();
      const executor = entry.surface.execute ?? options.execute;
      if (!executor) throw new DataSurfaceDeniedError();
      try {
        const internal = buildInternalQuery(request, entry.schema);
        const raw = await bounded(
          executor(entry.surface, internal.request, {
            run,
            principal,
            db: run.context.database ?? db,
            signal: signal.signal,
          }),
          deadlineMs,
          signal,
        );
        const rawRecord = isRecord(raw) ? raw : undefined;
        const rawRows = Array.isArray(raw)
          ? raw
          : rawRecord && Array.isArray(rawRecord.rows)
            ? rawRecord.rows
            : [];
        if (
          request.mode === 'rows' &&
          request.page &&
          rawRows.length > request.page.limit
        ) {
          throw new DataSurfaceQueryError();
        }
        const resultRequest = externalValidationRequest(request, entry.schema);
        const hasVersionedResult =
          rawRecord && Object.hasOwn(rawRecord, 'version');
        const canValidateInternal =
          (internal.request.projection?.length ?? 0) <= MAX_DATA_QUERY_FILTERS;
        const validated = canValidateInternal
          ? normalizeDataQueryResult(
              hasVersionedResult
                ? raw
                : shorthandResultCandidate(
                    internal.request,
                    internal.schema,
                    rawRecord,
                    rawRows,
                  ),
              internal.request,
              internal.schema,
            )
          : normalizeWideRows(
              rawRecord,
              rawRows,
              request,
              resultRequest,
              entry.schema,
              internal,
            );
        const rawOrderRows =
          request.mode === 'rows' && !canValidateInternal
            ? dataQueryRowsOrThrow(rawRows)
            : validated.rows;
        const orderRows =
          request.mode === 'rows' && !canValidateInternal
            ? addSortOnlyValues(
                validated.rows,
                rawOrderRows,
                request,
                internal.schema,
                rawRecord,
              )
            : rawOrderRows;
        if (request.mode === 'rows') {
          requireSortValues(orderRows, internal.request);
        }
        const orderedRows =
          request.mode === 'rows' && request.page === undefined
            ? sortRows(orderRows, internal.request, internal.schema)
            : orderRows;
        if (
          request.mode === 'rows' &&
          request.page !== undefined &&
          !isCanonicalOrder(orderedRows, internal.request, internal.schema)
        ) {
          throw new DataSurfaceResultOrderError();
        }
        const resultCandidate = {
          ...validated,
          requestId: resultRequest.requestId,
          queryFingerprint: canValidateInternal
            ? createDataQueryFingerprint(resultRequest, entry.schema)
            : createDataSurfaceQueryFingerprint(request),
          identityField: entry.schema.identityField,
          rows: stripInternalProjection(orderedRows, request),
        };
        const result: DataQueryResult = canValidateInternal
          ? normalizeDataQueryResult(
              resultCandidate,
              resultRequest,
              entry.schema,
            )
          : {
              ...resultCandidate,
              queryFingerprint: createDataSurfaceQueryFingerprint(request),
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
      } catch (error) {
        const alreadyReported =
          (typeof error === 'object' && error !== null) ||
          typeof error === 'function'
            ? reportedFailureErrors.has(error)
            : false;
        if (!alreadyReported) {
          await reportFailure(
            options,
            run,
            'query',
            entry.surface.id,
            request.requestId,
            error,
          );
        }
        if (
          error instanceof DataSurfaceDeadlineError ||
          error instanceof DataSurfaceResultOrderError ||
          error instanceof DataSurfaceQueryError
        ) {
          throw error;
        }
        throw new DataSurfaceQueryError();
      }
    },
  );

  return [discover, inspect, query];
}
