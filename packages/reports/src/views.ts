/**
 * Saved report-view and export contracts.
 *
 * This module owns only the serializable report boundary. Applications own
 * durable view storage, principal binding, authorization, auditing, artifact
 * storage, download tokens, and background-job execution.
 */
import { createHash } from 'node:crypto';
import {
  createDataQueryFingerprint,
  normalizeDataQueryRequest,
} from '@happyvertical/smrt-core';
import type {
  DataQueryFreshness,
  DataQueryRequest,
  DataQueryResult,
  DataQuerySort,
} from '@happyvertical/smrt-types';
import {
  type ReportAdapterDescriptor,
  type ReportColumnCapability,
  type ReportDataQueryResult,
  splitReportFilterScopes,
} from './adapter.js';

const INHERITED_REPORT_SCOPE = [
  'principal',
  'tenant',
  'report-definition',
  'field-policy',
] as const;

const EXPORT_FORMATS = new Set<ReportExportFormat>(['csv', 'json']);
const PINNED_COLUMN_SIDES = new Set<ReportSavedViewPinnedSide>([
  'start',
  'end',
]);
const DISPLAY_DENSITIES = new Set<ReportSavedViewDisplay['density']>([
  'compact',
  'comfortable',
]);
const RFC_3339_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

const DEFAULT_EXPORT_LIMITS: ReportExportLimits = {
  maxRows: 100_000,
  maxBytes: 25_000_000,
  deadlineMs: 60_000,
  foregroundRowLimit: 1_000,
};

const MAX_EXPORT_LIMITS = {
  maxRows: 1_000_000,
  maxBytes: 100_000_000,
  deadlineMs: 300_000,
  foregroundRowLimit: 100_000,
} as const;

export class ReportSurfaceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportSurfaceValidationError';
  }
}

export type ReportSavedViewPinnedSide = 'start' | 'end';

/** A view's column order is its array order; ids are always adapter-defined. */
export interface ReportSavedViewColumn {
  id: string;
  width?: number;
  pinned?: ReportSavedViewPinnedSide;
}

export interface ReportSavedViewGrouping {
  fields: string[];
  expanded?: boolean;
}

export interface ReportSavedViewDisplay {
  density: 'compact' | 'comfortable';
  showTotals?: boolean;
}

/**
 * A normalized, policy-neutral stored view. The storage host associates it
 * with its owner and tenant; neither identity is accepted here.
 */
export interface ReportSavedView {
  version: 1;
  id: string;
  title: string;
  resourceId: string;
  reportClassName: string;
  definitionFingerprint: string;
  query: DataQueryRequest;
  columns: ReportSavedViewColumn[];
  grouping?: ReportSavedViewGrouping;
  display?: ReportSavedViewDisplay;
}

export type ReportExportFormat = 'csv' | 'json';

/**
 * Opaque identity of a host-captured materialization snapshot. The application
 * creates and verifies it while bound to its principal and tenant; callers
 * cannot turn an `asOf` label into a snapshot by supplying this id alone.
 */
export interface ReportExportSnapshotBinding {
  id: string;
}

export interface ReportExportSnapshot {
  version: 1;
  resourceId: string;
  reportClassName: string;
  definitionFingerprint: string;
  binding: ReportExportSnapshotBinding;
  request: DataQueryRequest;
  queryFingerprint: string;
  projection: string[];
  sort: DataQuerySort[];
  freshness: DataQueryFreshness;
  snapshot: {
    asOf: string;
    refreshedAt?: string;
    stale: boolean;
  };
  total: {
    kind: 'exact';
    value: number;
  };
  inherits: Array<(typeof INHERITED_REPORT_SCOPE)[number]>;
}

/** Every export is bounded before it is streamed or delegated to a worker. */
export interface ReportExportLimits {
  maxRows: number;
  maxBytes: number;
  deadlineMs: number;
  /** Exports above this exact row count must use the application queue. */
  foregroundRowLimit: number;
}

/**
 * A deterministic offset-page plan over the immutable host snapshot. A worker
 * starts at offset zero and advances by `page.limit` until `rowCount` rows have
 * been produced or the byte/deadline limits are reached.
 */
export interface ReportExportReadPlan {
  snapshotId: string;
  queryFingerprint: string;
  asOf: string;
  page: {
    kind: 'offset';
    offset: 0;
    limit: number;
  };
}

export interface ReportExportRequest {
  version: 1;
  format: ReportExportFormat;
  execution: 'stream' | 'background';
  snapshot: ReportExportSnapshot;
  limits: ReportExportLimits;
  read: ReportExportReadPlan;
  rowCount: number;
  truncated: boolean;
  action: {
    id: 'export';
    requiredPermission: string;
    auditRequired: true;
    confirmationRequired: boolean;
  };
}

/**
 * An authority-free job handoff. The queue must re-enter the bound principal
 * and tenant, resolve the current report definition/field policy, and verify
 * this snapshot before materializing an artifact.
 */
export interface ReportBackgroundExportTask {
  version: 1;
  execution: 'background';
  request: ReportExportRequest;
  inherits: Array<(typeof INHERITED_REPORT_SCOPE)[number]>;
}

export interface ReportExportProgress {
  state: 'queued' | 'running' | 'completed' | 'failed';
  rowCount: number;
  byteCount: number;
  truncated: boolean;
}

/**
 * Artifact metadata is deliberately URL- and token-free. An application-owned
 * serving boundary must authorize every download using the caller's current
 * principal and tenant before it reveals any artifact location.
 */
export interface ReportExportArtifact {
  id: string;
  request: ReportExportRequest;
  progress: ReportExportProgress;
  expiresAt: string;
}

export interface ReportExportActionContext {
  phase: 'preview' | 'apply';
  reportClassName: string;
  resourceId: string;
  requiredPermission: string;
  confirmationRequired: boolean;
  execution: 'stream' | 'background';
  queryFingerprint: string;
  definitionFingerprint: string;
  snapshotId: string;
  asOf: string;
  pageSize: number;
}

/** The same host is used by human and agent callers. */
export interface ReportExportActionHost {
  /**
   * Prove that this opaque binding still resolves to the exact immutable
   * materialization snapshot under the host's current principal and tenant.
   * The background worker must call `validateReportExportExecution()` again
   * before reading or serving any rows.
   */
  assertSnapshot(context: ReportExportSnapshotContext): Promise<void> | void;
  authorize(context: ReportExportActionContext): Promise<void> | void;
  audit(context: ReportExportActionContext): Promise<void> | void;
  enqueue?(
    task: ReportBackgroundExportTask,
  ): Promise<{ taskId: string }> | { taskId: string };
}

export interface ReportExportSnapshotContext {
  bindingId: string;
  resourceId: string;
  reportClassName: string;
  definitionFingerprint: string;
  queryFingerprint: string;
  asOf: string;
}

export interface ReportExportPreview {
  phase: 'preview';
  action: ReportExportActionContext;
  request: ReportExportRequest;
}

export type AppliedReportExport =
  | {
      phase: 'apply';
      execution: 'stream';
      status: 'ready';
      request: ReportExportRequest;
    }
  | {
      phase: 'apply';
      execution: 'background';
      status: 'queued';
      taskId: string;
      request: ReportExportRequest;
    };

interface SavedViewInput {
  version?: unknown;
  id: unknown;
  title: unknown;
  resourceId?: unknown;
  reportClassName?: unknown;
  definitionFingerprint?: unknown;
  query: unknown;
  columns?: unknown;
  grouping?: unknown;
  display?: unknown;
}

interface ExportRequestInput {
  format: unknown;
  limits?: unknown;
}

function fail(message: string): never {
  throw new ReportSurfaceValidationError(message);
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  label: string,
  maxLength = 256,
): string {
  if (typeof value !== 'string') return fail(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized) return fail(`${label} cannot be empty`);
  if (normalized.length > maxLength) {
    return fail(`${label} cannot exceed ${String(maxLength)} characters`);
  }
  return normalized;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') return fail(`${label} must be a boolean`);
  return value;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    return fail(`${label} must be an integer of at least ${String(minimum)}`);
  }
  if ((value as number) > maximum) {
    return fail(`${label} cannot exceed ${String(maximum)}`);
  }
  return value as number;
}

function normalizeIso(value: unknown, label: string): string {
  const text = requiredString(value, label, 64);
  const match = RFC_3339_INSTANT.exec(text);
  if (!match) return fail(`${label} must be an RFC 3339 instant`);
  const [year, month, day] = match.slice(1, 4).map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(0, 0, 0, 0);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    return fail(`${label} must be an RFC 3339 instant`);
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return fail(`${label} must be an RFC 3339 instant`);
  }
  return parsed.toISOString();
}

function normalizeSnapshotBinding(value: unknown): ReportExportSnapshotBinding {
  const input = plainObject(value, 'Report export snapshot binding');
  return {
    id: requiredString(input.id, 'Report export snapshot binding id'),
  };
}

function stable(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object = plainObject(value, 'Report surface value');
  return (
    '{' +
    Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
      .join(',') +
    '}'
  );
}

/**
 * A change to report fields, their capabilities, schema, scope, or source
 * invalidates a stored view/export snapshot rather than silently widening it.
 */
export function reportDefinitionFingerprint(
  descriptor: ReportAdapterDescriptor,
): string {
  const definition = {
    resourceId: descriptor.resourceId,
    reportClassName: descriptor.reportClassName,
    sourceClassName: descriptor.sourceClassName,
    tenantScoped: descriptor.tenantScoped,
    tenantField: descriptor.tenantField ?? null,
    identityField: descriptor.identityField,
    columns: descriptor.columns.map((column) => ({
      id: column.id,
      fieldName: column.fieldName,
      kind: column.kind,
      filterScope: column.filterScope,
      type: column.type,
      projectable: column.projectable === true,
      sortable: column.sortable === true,
      facetable: column.facetable === true,
      filterOperators: column.filterOperators ?? [],
      capabilities: [...column.capabilities].sort(),
      sensitivity: column.sensitivity ?? null,
      sourceColumn: column.sourceColumn ?? null,
      bucket: column.bucket ?? null,
      aggregate: column.aggregate ?? null,
      distinct: column.distinct ?? null,
    })),
    schema: descriptor.schema,
  };
  return (
    'rv1_' +
    createHash('sha256').update(stable(definition), 'utf8').digest('base64url')
  );
}

function columnMap(
  descriptor: ReportAdapterDescriptor,
): Map<string, ReportAdapterDescriptor['columns'][number]> {
  return new Map(descriptor.columns.map((column) => [column.id, column]));
}

function requireColumnCapability(
  descriptor: ReportAdapterDescriptor,
  id: unknown,
  capability: ReportColumnCapability,
  label: string,
): string {
  const columnId = requiredString(id, label);
  const column = columnMap(descriptor).get(columnId);
  if (!column?.capabilities.includes(capability)) {
    return fail(`${label} is not available under the current report policy`);
  }
  return columnId;
}

function normalizeColumns(
  descriptor: ReportAdapterDescriptor,
  value: unknown,
): ReportSavedViewColumn[] {
  if (value === undefined) {
    return descriptor.columns
      .filter((column) => column.capabilities.includes('project'))
      .map((column) => ({ id: column.id }));
  }
  if (!Array.isArray(value))
    return fail('Saved report view columns must be an array');
  if (value.length > descriptor.columns.length) {
    return fail(
      'Saved report view columns cannot repeat or exceed exposed columns',
    );
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const input = plainObject(
      entry,
      `Saved report view columns[${String(index)}]`,
    );
    const id = requireColumnCapability(
      descriptor,
      input.id,
      'project',
      `Saved report view columns[${String(index)}].id`,
    );
    if (ids.has(id)) return fail('Saved report view columns cannot repeat ids');
    ids.add(id);
    const width =
      input.width === undefined
        ? undefined
        : boundedInteger(
            input.width,
            `Saved report view columns[${String(index)}].width`,
            40,
            2_000,
          );
    const pinned =
      input.pinned === undefined
        ? undefined
        : requiredString(
            input.pinned,
            `Saved report view columns[${String(index)}].pinned`,
            16,
          );
    if (
      pinned !== undefined &&
      !PINNED_COLUMN_SIDES.has(pinned as ReportSavedViewPinnedSide)
    ) {
      return fail(
        `Saved report view columns[${String(index)}].pinned is invalid`,
      );
    }
    return {
      id,
      ...(width === undefined ? {} : { width }),
      ...(pinned === undefined
        ? {}
        : { pinned: pinned as ReportSavedViewPinnedSide }),
    };
  });
}

function normalizeGrouping(
  descriptor: ReportAdapterDescriptor,
  value: unknown,
): ReportSavedViewGrouping | undefined {
  if (value === undefined) return undefined;
  const input = plainObject(value, 'Saved report view grouping');
  if (!Array.isArray(input.fields)) {
    return fail('Saved report view grouping.fields must be an array');
  }
  const fields = input.fields.map((field, index) =>
    requireColumnCapability(
      descriptor,
      field,
      'group',
      `Saved report view grouping.fields[${String(index)}]`,
    ),
  );
  if (new Set(fields).size !== fields.length) {
    return fail('Saved report view grouping.fields cannot repeat ids');
  }
  const expanded = optionalBoolean(
    input.expanded,
    'Saved report view grouping.expanded',
  );
  return {
    fields,
    ...(expanded === undefined ? {} : { expanded }),
  };
}

function normalizeDisplay(value: unknown): ReportSavedViewDisplay | undefined {
  if (value === undefined) return undefined;
  const input = plainObject(value, 'Saved report view display');
  const density = requiredString(
    input.density,
    'Saved report view display.density',
    16,
  );
  if (!DISPLAY_DENSITIES.has(density as ReportSavedViewDisplay['density'])) {
    return fail('Saved report view display.density is invalid');
  }
  const showTotals = optionalBoolean(
    input.showTotals,
    'Saved report view display.showTotals',
  );
  return {
    density: density as ReportSavedViewDisplay['density'],
    ...(showTotals === undefined ? {} : { showTotals }),
  };
}

/**
 * Version 0 is the original unversioned persisted layout shape. It contains
 * the same allowlisted fields as v1, so the migration only records the schema
 * version; current descriptor normalization still revalidates every field.
 */
export function migrateReportSavedView(value: unknown): SavedViewInput {
  const input = plainObject(
    value,
    'Saved report view',
  ) as unknown as SavedViewInput;
  if (input.version === undefined || input.version === 0) {
    return { ...input, version: 1 };
  }
  if (input.version === 1) return input;
  return fail('Saved report view version is unsupported');
}

/**
 * Normalize a view both when it is saved and when it is restored. Re-running
 * this against the live descriptor is what prevents a former field/action
 * grant from surviving a policy or definition change.
 */
export function normalizeReportSavedView(
  descriptor: ReportAdapterDescriptor,
  value: unknown,
): ReportSavedView {
  const input = migrateReportSavedView(value);
  const fingerprint = reportDefinitionFingerprint(descriptor);
  if (
    input.resourceId !== undefined &&
    input.resourceId !== descriptor.resourceId
  ) {
    return fail('Saved report view belongs to a different report resource');
  }
  if (
    input.reportClassName !== undefined &&
    input.reportClassName !== descriptor.reportClassName
  ) {
    return fail('Saved report view belongs to a different report class');
  }
  if (
    input.definitionFingerprint !== undefined &&
    input.definitionFingerprint !== fingerprint
  ) {
    return fail('Saved report view definition has changed');
  }
  const query = normalizeDataQueryRequest(input.query, descriptor.schema);
  if (query.mode !== 'rows') {
    return fail('Saved report views must use a rows query');
  }
  splitReportFilterScopes(descriptor, query.filter);
  const columns = normalizeColumns(descriptor, input.columns);
  const grouping = normalizeGrouping(descriptor, input.grouping);
  const display = normalizeDisplay(input.display);
  return {
    version: 1,
    id: requiredString(input.id, 'Saved report view id'),
    title: requiredString(input.title, 'Saved report view title', 240),
    resourceId: descriptor.resourceId,
    reportClassName: descriptor.reportClassName,
    definitionFingerprint: fingerprint,
    query,
    columns,
    ...(grouping === undefined ? {} : { grouping }),
    ...(display === undefined ? {} : { display }),
  };
}

/** Restore through current policy rather than trusting a stored JSON record. */
export function restoreReportSavedView(
  descriptor: ReportAdapterDescriptor,
  savedView: ReportSavedView,
): ReportSavedView {
  return normalizeReportSavedView(descriptor, savedView);
}

/**
 * Freeze a previously executed materialized read for export. The caller must
 * supply the exact request and a result that exposes lifecycle freshness; an
 * export never invents an as-of value or accepts a caller-supplied tenant.
 */
export function createReportExportSnapshot(
  descriptor: ReportAdapterDescriptor,
  input: unknown,
  result: Pick<
    DataQueryResult,
    'queryFingerprint' | 'identityField' | 'total' | 'freshness' | 'truncated'
  > &
    Pick<ReportDataQueryResult, 'reportLifecycle'>,
  binding: unknown,
): ReportExportSnapshot {
  const request = normalizeDataQueryRequest(input, descriptor.schema);
  if (request.mode !== 'rows') {
    return fail('Report export snapshots require a rows query');
  }
  const queryFingerprint = createDataQueryFingerprint(
    request,
    descriptor.schema,
  );
  if (result.queryFingerprint !== queryFingerprint) {
    return fail(
      'Report export result does not match the requested query fingerprint',
    );
  }
  if (result.identityField !== descriptor.identityField) {
    return fail('Report export result has an unexpected row identity field');
  }
  if (result.total.kind !== 'exact') {
    return fail('Report export snapshots require an exact row count');
  }
  if (!Number.isSafeInteger(result.total.value) || result.total.value < 0) {
    return fail(
      'Report export snapshots require a safe non-negative row count',
    );
  }
  if (result.truncated) {
    return fail('Report export snapshots cannot use a truncated query result');
  }
  if (result.freshness.state === 'unknown') {
    return fail('Report export snapshots require lifecycle freshness');
  }
  const lifecycleAsOf = result.reportLifecycle?.snapshot.asOf;
  const freshnessAsOf = result.freshness.asOf;
  const normalizedLifecycleAsOf = lifecycleAsOf
    ? normalizeIso(lifecycleAsOf, 'Report export lifecycle snapshot asOf')
    : undefined;
  const normalizedFreshnessAsOf = freshnessAsOf
    ? normalizeIso(freshnessAsOf, 'Report export freshness asOf')
    : undefined;
  if (
    normalizedLifecycleAsOf !== undefined &&
    normalizedFreshnessAsOf !== undefined &&
    normalizedLifecycleAsOf !== normalizedFreshnessAsOf
  ) {
    return fail(
      'Report export lifecycle freshness does not match its snapshot',
    );
  }
  const normalizedAsOf = normalizedLifecycleAsOf ?? normalizedFreshnessAsOf;
  if (!normalizedAsOf) {
    return fail(
      'Report export snapshots require an as-of materialization instant',
    );
  }
  const refreshedAt = result.reportLifecycle?.snapshot.refreshedAt;
  return {
    version: 1,
    resourceId: descriptor.resourceId,
    reportClassName: descriptor.reportClassName,
    definitionFingerprint: reportDefinitionFingerprint(descriptor),
    binding: normalizeSnapshotBinding(binding),
    request,
    queryFingerprint,
    projection: [...(request.projection ?? [descriptor.identityField])],
    sort: [
      ...(request.sort ??
        descriptor.schema.defaultSort ?? [
          { field: descriptor.identityField, direction: 'asc' },
        ]),
    ],
    freshness: {
      state: result.freshness.state,
      asOf: normalizedAsOf,
    },
    snapshot: {
      asOf: normalizedAsOf,
      ...(refreshedAt
        ? {
            refreshedAt: normalizeIso(
              refreshedAt,
              'Report export snapshot refreshedAt',
            ),
          }
        : {}),
      stale: result.freshness.state === 'stale',
    },
    total: { kind: 'exact', value: result.total.value },
    inherits: [...INHERITED_REPORT_SCOPE],
  };
}

/** Reject definitions/policies that changed after a snapshot was frozen. */
export function verifyReportExportSnapshot(
  descriptor: ReportAdapterDescriptor,
  snapshot: ReportExportSnapshot,
): ReportExportSnapshot {
  if (snapshot.version !== 1)
    return fail('Report export snapshot version is unsupported');
  if (
    snapshot.resourceId !== descriptor.resourceId ||
    snapshot.reportClassName !== descriptor.reportClassName
  ) {
    return fail('Report export snapshot belongs to a different report');
  }
  if (
    snapshot.definitionFingerprint !== reportDefinitionFingerprint(descriptor)
  ) {
    return fail('Report export definition has changed');
  }
  const binding = normalizeSnapshotBinding(snapshot.binding);
  const normalized = normalizeDataQueryRequest(
    snapshot.request,
    descriptor.schema,
  );
  if (normalized.mode !== 'rows') {
    return fail('Report export snapshot query must remain a rows query');
  }
  if (
    createDataQueryFingerprint(normalized, descriptor.schema) !==
    snapshot.queryFingerprint
  ) {
    return fail('Report export snapshot query fingerprint is invalid');
  }
  const expectedProjection = normalized.projection ?? [
    descriptor.identityField,
  ];
  const expectedSort = normalized.sort ??
    descriptor.schema.defaultSort ?? [
      { field: descriptor.identityField, direction: 'asc' },
    ];
  if (
    stable(snapshot.projection) !== stable(expectedProjection) ||
    stable(snapshot.sort) !== stable(expectedSort)
  ) {
    return fail('Report export snapshot projection or sort has changed');
  }
  const asOf = normalizeIso(
    snapshot.snapshot.asOf,
    'Report export snapshot asOf',
  );
  if (
    snapshot.freshness.state !== 'fresh' &&
    snapshot.freshness.state !== 'stale'
  ) {
    return fail('Report export snapshot freshness state is invalid');
  }
  const freshnessAsOf = normalizeIso(
    snapshot.freshness.asOf,
    'Report export snapshot freshness asOf',
  );
  if (freshnessAsOf !== asOf) {
    return fail(
      'Report export snapshot freshness does not match its as-of instant',
    );
  }
  const refreshedAt = snapshot.snapshot.refreshedAt
    ? normalizeIso(
        snapshot.snapshot.refreshedAt,
        'Report export snapshot refreshedAt',
      )
    : undefined;
  if (snapshot.snapshot.stale !== (snapshot.freshness.state === 'stale')) {
    return fail('Report export snapshot stale state is invalid');
  }
  if (
    snapshot.total.kind !== 'exact' ||
    !Number.isSafeInteger(snapshot.total.value) ||
    snapshot.total.value < 0
  ) {
    return fail('Report export snapshot row count is invalid');
  }
  if (stable(snapshot.inherits) !== stable([...INHERITED_REPORT_SCOPE])) {
    return fail('Report export snapshot inheritance contract is invalid');
  }
  return {
    ...snapshot,
    binding,
    request: normalized,
    projection: [...expectedProjection],
    sort: [...expectedSort],
    freshness: { ...snapshot.freshness, asOf: freshnessAsOf },
    snapshot: {
      ...snapshot.snapshot,
      asOf,
      ...(refreshedAt === undefined ? {} : { refreshedAt }),
    },
    inherits: [...INHERITED_REPORT_SCOPE],
  };
}

function normalizeExportLimits(value: unknown): ReportExportLimits {
  if (value === undefined) return { ...DEFAULT_EXPORT_LIMITS };
  const input = plainObject(value, 'Report export limits');
  const maxRows = boundedInteger(
    input.maxRows ?? DEFAULT_EXPORT_LIMITS.maxRows,
    'Report export limits.maxRows',
    1,
    MAX_EXPORT_LIMITS.maxRows,
  );
  const maxBytes = boundedInteger(
    input.maxBytes ?? DEFAULT_EXPORT_LIMITS.maxBytes,
    'Report export limits.maxBytes',
    1,
    MAX_EXPORT_LIMITS.maxBytes,
  );
  const deadlineMs = boundedInteger(
    input.deadlineMs ?? DEFAULT_EXPORT_LIMITS.deadlineMs,
    'Report export limits.deadlineMs',
    1,
    MAX_EXPORT_LIMITS.deadlineMs,
  );
  const foregroundRowLimit = boundedInteger(
    input.foregroundRowLimit ??
      Math.min(DEFAULT_EXPORT_LIMITS.foregroundRowLimit, maxRows),
    'Report export limits.foregroundRowLimit',
    1,
    Math.min(maxRows, MAX_EXPORT_LIMITS.foregroundRowLimit),
  );
  return { maxRows, maxBytes, deadlineMs, foregroundRowLimit };
}

function hasSensitiveProjection(
  descriptor: ReportAdapterDescriptor,
  snapshot: ReportExportSnapshot,
): boolean {
  const columns = columnMap(descriptor);
  return snapshot.projection.some((id) => {
    const sensitivity = columns.get(id)?.sensitivity;
    return (
      sensitivity === 'personal' ||
      sensitivity === 'sensitive' ||
      sensitivity === 'secret'
    );
  });
}

function createReadPlan(
  descriptor: ReportAdapterDescriptor,
  snapshot: ReportExportSnapshot,
  limits: ReportExportLimits,
): ReportExportReadPlan {
  return {
    snapshotId: snapshot.binding.id,
    queryFingerprint: snapshot.queryFingerprint,
    asOf: snapshot.snapshot.asOf,
    page: {
      kind: 'offset',
      offset: 0,
      limit: Math.min(
        limits.maxRows,
        descriptor.schema.maxPageLimit ??
          DEFAULT_EXPORT_LIMITS.foregroundRowLimit,
      ),
    },
  };
}

/**
 * Build one common request for both agent and human export clients. The
 * resulting request carries no actor, tenant, storage location, or token.
 */
export function createReportExportRequest(
  descriptor: ReportAdapterDescriptor,
  snapshot: ReportExportSnapshot,
  value: unknown,
): ReportExportRequest {
  const input = plainObject(
    value,
    'Report export request',
  ) as unknown as ExportRequestInput;
  const verified = verifyReportExportSnapshot(descriptor, snapshot);
  const format = requiredString(input.format, 'Report export format', 16);
  if (!EXPORT_FORMATS.has(format as ReportExportFormat)) {
    return fail('Report export format is unsupported');
  }
  const limits = normalizeExportLimits(input.limits);
  const rowCount = Math.min(verified.total.value, limits.maxRows);
  const confirmationRequired = hasSensitiveProjection(descriptor, verified);
  return {
    version: 1,
    format: format as ReportExportFormat,
    execution:
      verified.total.value > limits.foregroundRowLimit
        ? 'background'
        : 'stream',
    snapshot: verified,
    limits,
    read: createReadPlan(descriptor, verified, limits),
    rowCount,
    truncated: verified.total.value > limits.maxRows,
    action: {
      id: 'export',
      requiredPermission: 'reports.export',
      auditRequired: true,
      confirmationRequired,
    },
  };
}

/**
 * Recreate the deterministic request from its current descriptor and frozen
 * snapshot. Preview, apply, queue, and serving hosts call this instead of
 * trusting browser- or agent-supplied action metadata.
 */
export function validateReportExportRequest(
  descriptor: ReportAdapterDescriptor,
  request: ReportExportRequest,
): ReportExportRequest {
  const expected = createReportExportRequest(descriptor, request.snapshot, {
    format: request.format,
    limits: request.limits,
  });
  if (stable(request) !== stable(expected)) {
    return fail('Report export request does not match current policy');
  }
  return expected;
}

/**
 * Build one bounded page of the immutable export read. The host applies the
 * opaque snapshot binding separately; this function preserves the frozen
 * projection, predicate, and deterministic sort while replacing only visible
 * pagination. A zero-row export therefore has no pages to execute.
 */
export function createReportExportPageRequest(
  descriptor: ReportAdapterDescriptor,
  request: ReportExportRequest,
  offset: number,
): DataQueryRequest {
  const verified = validateReportExportRequest(descriptor, request);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset >= verified.rowCount
  ) {
    return fail('Report export page offset is outside the bounded export');
  }
  const limit = Math.min(verified.read.page.limit, verified.rowCount - offset);
  return normalizeDataQueryRequest(
    {
      ...verified.snapshot.request,
      page: { kind: 'offset', offset, limit },
    },
    descriptor.schema,
  );
}

function actionContext(
  phase: ReportExportActionContext['phase'],
  request: ReportExportRequest,
): ReportExportActionContext {
  return {
    phase,
    reportClassName: request.snapshot.reportClassName,
    resourceId: request.snapshot.resourceId,
    requiredPermission: request.action.requiredPermission,
    confirmationRequired: request.action.confirmationRequired,
    execution: request.execution,
    queryFingerprint: request.snapshot.queryFingerprint,
    definitionFingerprint: request.snapshot.definitionFingerprint,
    snapshotId: request.read.snapshotId,
    asOf: request.read.asOf,
    pageSize: request.read.page.limit,
  };
}

function snapshotContext(
  request: ReportExportRequest,
): ReportExportSnapshotContext {
  return {
    bindingId: request.snapshot.binding.id,
    resourceId: request.snapshot.resourceId,
    reportClassName: request.snapshot.reportClassName,
    definitionFingerprint: request.snapshot.definitionFingerprint,
    queryFingerprint: request.snapshot.queryFingerprint,
    asOf: request.snapshot.snapshot.asOf,
  };
}

/**
 * Revalidate the request and prove the opaque snapshot binding through the
 * application host. Preview, apply, and every background worker use this same
 * operation before reading or serving export data.
 */
export async function validateReportExportExecution(
  descriptor: ReportAdapterDescriptor,
  request: ReportExportRequest,
  host: Pick<ReportExportActionHost, 'assertSnapshot'>,
): Promise<ReportExportRequest> {
  const verified = validateReportExportRequest(descriptor, request);
  await host.assertSnapshot(snapshotContext(verified));
  return verified;
}

export async function previewReportExport(
  descriptor: ReportAdapterDescriptor,
  request: ReportExportRequest,
  host: ReportExportActionHost,
): Promise<ReportExportPreview> {
  const initial = validateReportExportRequest(descriptor, request);
  const action = actionContext('preview', initial);
  await host.authorize(action);
  const verified = await validateReportExportExecution(
    descriptor,
    initial,
    host,
  );
  await host.audit(action);
  return { phase: 'preview', action, request: verified };
}

/**
 * Queue large exports without embedding rows in a browser/agent response.
 * A host must verify current principal, tenant, report definition, and field
 * policy again before it renders or serves the artifact.
 */
export async function applyReportExport(
  descriptor: ReportAdapterDescriptor,
  request: ReportExportRequest,
  host: ReportExportActionHost,
  options: { confirmed?: boolean } = {},
): Promise<AppliedReportExport> {
  const initial = validateReportExportRequest(descriptor, request);
  if (initial.action.confirmationRequired && options.confirmed !== true) {
    return fail('Sensitive report exports require explicit confirmation');
  }
  const action = actionContext('apply', initial);
  await host.authorize(action);
  const verified = await validateReportExportExecution(
    descriptor,
    initial,
    host,
  );
  await host.audit(action);
  if (verified.execution === 'stream') {
    return {
      phase: 'apply',
      execution: 'stream',
      status: 'ready',
      request: verified,
    };
  }
  if (!host.enqueue) {
    return fail('Background report exports require an application queue host');
  }
  const queued = await host.enqueue({
    version: 1,
    execution: 'background',
    request: verified,
    inherits: [...INHERITED_REPORT_SCOPE],
  });
  if (typeof queued.taskId !== 'string' || queued.taskId.trim().length === 0) {
    return fail('Background report export hosts must return a task id');
  }
  return {
    phase: 'apply',
    execution: 'background',
    status: 'queued',
    taskId: queued.taskId,
    request: verified,
  };
}

/**
 * Validate artifact metadata before a host serves it. Download locations and
 * tokens stay application-private; expired artifacts fail before that boundary.
 */
export function validateReportExportArtifact(
  descriptor: ReportAdapterDescriptor,
  artifact: ReportExportArtifact,
  now = new Date(),
): ReportExportArtifact {
  const request = validateReportExportRequest(descriptor, artifact.request);
  requiredString(artifact.id, 'Report export artifact id');
  const expiresAt = normalizeIso(
    artifact.expiresAt,
    'Report export artifact expiresAt',
  );
  if (new Date(expiresAt).getTime() <= now.getTime()) {
    return fail('Report export artifact has expired');
  }
  const progress = plainObject(
    artifact.progress,
    'Report export artifact progress',
  );
  const state = progress.state;
  if (
    state !== 'queued' &&
    state !== 'running' &&
    state !== 'completed' &&
    state !== 'failed'
  ) {
    return fail('Report export artifact progress state is invalid');
  }
  const rowCount = boundedInteger(
    progress.rowCount,
    'Report export artifact rowCount',
    0,
    request.rowCount,
  );
  const byteCount = boundedInteger(
    progress.byteCount,
    'Report export artifact byteCount',
    0,
    request.limits.maxBytes,
  );
  const truncated = progress.truncated;
  if (typeof truncated !== 'boolean') {
    return fail('Report export artifact truncated must be a boolean');
  }
  if (state === 'completed' && rowCount !== request.rowCount) {
    return fail(
      'Completed report export artifacts must contain the requested row count',
    );
  }
  if (state === 'completed' && truncated !== request.truncated) {
    return fail(
      'Completed report export artifacts must match the requested truncation state',
    );
  }
  return {
    ...artifact,
    request,
    expiresAt,
    progress: { state, rowCount, byteCount, truncated },
  };
}
