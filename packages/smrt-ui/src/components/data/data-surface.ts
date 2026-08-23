/**
 * Transport-neutral contracts for mounted, addressable data surfaces.
 *
 * This module is intentionally a leaf: it owns no transport, DOM, query
 * execution, authorization, persistence, or domain workflow. A browser host
 * may register a mounted surface here; adapters above smrt-ui can expose the
 * resulting serializable contracts to people or agents.
 */

export type DataSurfaceJsonPrimitive = string | number | boolean | null;
export type DataSurfaceJsonValue =
  | DataSurfaceJsonPrimitive
  | DataSurfaceJsonValue[]
  | { [key: string]: DataSurfaceJsonValue };
export type DataSurfaceJsonObject = { [key: string]: DataSurfaceJsonValue };

export type DataSurfaceRowId = string | number;
export type DataSurfaceKind = 'table' | 'list' | 'report' | 'custom';
export type DataSurfaceSensitivity =
  | 'public'
  | 'personal'
  | 'sensitive'
  | 'secret';

export interface DataSurfaceSubject {
  type: string;
  id: string;
  label?: string;
}

/** Stable address for one mounted instance, never an authority boundary. */
export interface DataSurfaceIdentity {
  surfaceId: string;
  kind: DataSurfaceKind;
  subject?: DataSurfaceSubject;
}

export type DataSurfaceColumnCapability =
  | 'read'
  | 'search'
  | 'filter'
  | 'sort'
  | 'project';

export interface DataSurfaceColumnDescriptor {
  id: string;
  label: string;
  description?: string;
  sensitivity?: DataSurfaceSensitivity;
  capabilities: DataSurfaceColumnCapability[];
}

/** #2444 owns the canonical query language; this declares only its bounds. */
export type DataSurfaceQueryMode = 'rows' | 'count' | 'facets';

export interface DataSurfaceQueryCapabilities {
  modes: DataSurfaceQueryMode[];
  /** Explicit allowlist; field paths are not accepted in requests. */
  projectableColumnIds: string[];
}

export interface DataSurfaceVisibleControl {
  /** Stable command name accepted by the mounted surface. */
  id: string;
  label: string;
  description?: string;
}

export type DataSurfaceSelectionScope =
  | 'current-page'
  | 'explicit-ids'
  | 'all-matching';

export interface DataSurfaceActionDescriptor {
  id: string;
  label: string;
  description?: string;
  sensitivity?: DataSurfaceSensitivity;
  selectionScopes: DataSurfaceSelectionScope[];
  requiresConfirmation?: boolean;
}

/** Per-surface limits; generic envelopes use DATA_SURFACE_MAX_REQUEST_BYTES. */
export interface DataSurfaceLimits {
  maxQueryRows: number;
  maxQueryBytes: number;
  maxSelectionSize: number;
}

/** Public, serializable discovery metadata for a mounted data surface. */
export interface DataSurfaceDescriptor {
  version: 1;
  identity: DataSurfaceIdentity;
  /** Version of the domain adapter's descriptor and view-state schema. */
  schemaVersion: number;
  label: string;
  description?: string;
  /** Stable row-identity column, including when it is not visibly rendered. */
  rowKey: string;
  columns: DataSurfaceColumnDescriptor[];
  query: DataSurfaceQueryCapabilities;
  controls: DataSurfaceVisibleControl[];
  actions: DataSurfaceActionDescriptor[];
  limits: DataSurfaceLimits;
}

export type DataSurfaceSelectionReference =
  | { scope: 'current-page' }
  | { scope: 'explicit-ids'; rowIds: DataSurfaceRowId[] }
  | { scope: 'all-matching'; queryFingerprint: string };

/** Input supplied by a mounted renderer/controller, before registry wrapping. */
export interface DataSurfaceSnapshotState {
  revision: number;
  state: DataSurfaceJsonObject;
  selection?: DataSurfaceSelectionReference | null;
}

/** Deterministic inspect/result envelope. It intentionally has no timestamp. */
export interface DataSurfaceSnapshot {
  version: 1;
  descriptor: DataSurfaceDescriptor;
  revision: number;
  state: DataSurfaceJsonObject;
  selection: DataSurfaceSelectionReference | null;
}

/** A browser-visible state transition, not a server-side query or mutation. */
export interface DataSurfaceVisibleCommand {
  version: 1;
  commandId: string;
  identity: DataSurfaceIdentity;
  expectedRevision: number;
  controlId: string;
  payload?: DataSurfaceJsonValue;
}

export type DataSurfaceCommandFailureReason =
  | 'not_found'
  | 'unsupported'
  | 'stale_revision'
  | 'idempotency_conflict'
  | 'denied'
  | 'execution_failed'
  | 'non_monotonic_revision';

export interface DataSurfaceCommandResult {
  ok: boolean;
  commandId: string;
  identity: DataSurfaceIdentity;
  revision?: number;
  snapshot?: DataSurfaceSnapshot;
  reason?: DataSurfaceCommandFailureReason;
}

/**
 * This intentionally contains only bounded read shape. #2444 adds the
 * canonical filters, ordering, cursors, totals, and normalized result details.
 */
export type DataSurfaceQueryRequest =
  | {
      version: 1;
      requestId: string;
      identity: DataSurfaceIdentity;
      kind: 'rows';
      limit: number;
      cursor?: string;
      projection?: string[];
    }
  | {
      version: 1;
      requestId: string;
      identity: DataSurfaceIdentity;
      kind: 'count';
    }
  | {
      version: 1;
      requestId: string;
      identity: DataSurfaceIdentity;
      kind: 'facets';
      columnId: string;
      limit: number;
    };

export interface DataSurfaceQueryResult {
  version: 1;
  requestId: string;
  identity: DataSurfaceIdentity;
  revision: number;
  rowKey: string;
  rows: DataSurfaceJsonObject[];
  hasMore: boolean;
  truncated: boolean;
  nextCursor?: string;
}

/** Preview/apply is a contract only here; server-side adapters execute it. */
export interface DataSurfaceActionRequest {
  version: 1;
  requestId: string;
  identity: DataSurfaceIdentity;
  actionId: string;
  phase: 'preview' | 'apply';
  selection: DataSurfaceSelectionReference;
  payload?: DataSurfaceJsonValue;
  /** Opaque confirmation produced by a prior preview, never an authority. */
  confirmationToken?: string;
}

export interface DataSurfaceActionResult {
  version: 1;
  requestId: string;
  identity: DataSurfaceIdentity;
  actionId: string;
  phase: 'preview' | 'apply';
  ok: boolean;
  reason?: string;
  confirmationToken?: string;
  details?: DataSurfaceJsonObject;
}

export type DataSurfaceValidationReason =
  | 'not_found'
  | 'unsupported'
  | 'invalid_request'
  | 'limit_exceeded'
  | 'projection_not_allowed'
  | 'selection_not_supported'
  | 'confirmation_required';

export interface DataSurfaceValidationResult {
  ok: boolean;
  reason?: DataSurfaceValidationReason;
}

export type DataSurfaceCommandExecution = { ok: false } | undefined;

/** Runtime-only handle supplied by a mounted renderer or controller. */
export interface DataSurfaceRegistration {
  descriptor: DataSurfaceDescriptor;
  getSnapshot: () => DataSurfaceSnapshotState;
  execute?: (
    command: DataSurfaceVisibleCommand,
  ) => DataSurfaceCommandExecution | Promise<DataSurfaceCommandExecution>;
  /**
   * A host-owned redaction boundary. It cannot change identity or revision and
   * the registry validates its output before exposing it.
   */
  redact?: (snapshot: DataSurfaceSnapshot) => DataSurfaceSnapshot;
}

export interface DataSurfaceRegistryEvent {
  type: 'registered' | 'unregistered' | 'command';
  sequence: number;
  identity: DataSurfaceIdentity;
  revision: number;
  command?: DataSurfaceVisibleCommand;
  result?: DataSurfaceCommandResult;
}

export interface DataSurfaceRegistry {
  register(registration: DataSurfaceRegistration): () => void;
  unregister(identity: DataSurfaceIdentity): void;
  list(): DataSurfaceDescriptor[];
  inspect(identity: DataSurfaceIdentity): DataSurfaceSnapshot | undefined;
  execute(
    command: DataSurfaceVisibleCommand,
  ): Promise<DataSurfaceCommandResult>;
  validateQuery(request: DataSurfaceQueryRequest): DataSurfaceValidationResult;
  validateAction(
    request: DataSurfaceActionRequest,
  ): DataSurfaceValidationResult;
  subscribe(listener: (event: DataSurfaceRegistryEvent) => void): () => void;
}

/** Generic browser-transport ceiling for normalized command/action envelopes. */
export const DATA_SURFACE_MAX_REQUEST_BYTES = 100_000;

/** Per-surface LRU capacity for command acknowledgement replay. */
export const DATA_SURFACE_MAX_REPLAY_ENTRIES = 100;

const MAX_QUERY_LIMIT = 1_000;
const MAX_REQUEST_ID_LENGTH = 256;
const MAX_CURSOR_LENGTH = 2_048;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_CONTAINER_ITEMS = 1_000;
const PROTOTYPE_POLLUTION_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
const DATA_SURFACE_KINDS = new Set<DataSurfaceKind>([
  'table',
  'list',
  'report',
  'custom',
]);
const SENSITIVITIES = new Set<DataSurfaceSensitivity>([
  'public',
  'personal',
  'sensitive',
  'secret',
]);
const COLUMN_CAPABILITIES = new Set<DataSurfaceColumnCapability>([
  'read',
  'search',
  'filter',
  'sort',
  'project',
]);
const QUERY_MODES = new Set<DataSurfaceQueryMode>(['rows', 'count', 'facets']);
const SELECTION_SCOPES = new Set<DataSurfaceSelectionScope>([
  'current-page',
  'explicit-ids',
  'all-matching',
]);
const FORBIDDEN_BOUNDARY_KEYS = new Set([
  'tenantid',
  'principalid',
  'principal',
  'actorid',
  'authorization',
  'authorizationtoken',
  'accesstoken',
  'credential',
  'credentials',
  'sql',
  'rawsql',
  'rawquery',
  'where',
]);

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`${label} contains unsupported field: ${key}`);
    }
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, label);
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function revisionNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(
      'DataSurface revision must be a non-negative safe integer',
    );
  }
  return value;
}

function canonicalJson(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0,
): DataSurfaceJsonValue {
  if (depth > MAX_JSON_DEPTH) {
    throw new TypeError(
      `DataSurface values cannot exceed ${MAX_JSON_DEPTH} nested levels`,
    );
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        'DataSurface values cannot contain non-finite numbers',
      );
    }
    return value === 0 ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_CONTAINER_ITEMS) {
      throw new TypeError(
        `DataSurface arrays cannot contain more than ${MAX_JSON_CONTAINER_ITEMS} items`,
      );
    }
    if (ancestors.has(value)) {
      throw new TypeError('DataSurface values cannot be circular');
    }
    ancestors.add(value);
    const clone = value.map((entry) =>
      canonicalJson(entry, ancestors, depth + 1),
    );
    ancestors.delete(value);
    return clone;
  }
  if (value && typeof value === 'object') {
    const object = plainObject(value, 'DataSurface value');
    if (ancestors.has(object)) {
      throw new TypeError('DataSurface values cannot be circular');
    }
    ancestors.add(object);
    const clone: DataSurfaceJsonObject = {};
    const keys = Object.keys(object);
    if (keys.length > MAX_JSON_CONTAINER_ITEMS) {
      throw new TypeError(
        `DataSurface objects cannot contain more than ${MAX_JSON_CONTAINER_ITEMS} keys`,
      );
    }
    for (const key of keys.sort()) {
      if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
        throw new TypeError(
          `DataSurface values cannot contain prototype key: ${key}`,
        );
      }
      clone[key] = canonicalJson(object[key], ancestors, depth + 1);
    }
    ancestors.delete(object);
    return clone;
  }
  throw new TypeError('DataSurface values must be JSON-safe plain data');
}

function jsonObject(value: unknown, label: string): DataSurfaceJsonObject {
  const clone = canonicalJson(value);
  if (Array.isArray(clone) || clone === null || typeof clone !== 'object') {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return clone;
}

function jsonSignature(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

/** The UTF-8 size of the normalized, canonical query envelope. */
function canonicalQueryByteLength(request: DataSurfaceQueryRequest): number {
  return new TextEncoder().encode(jsonSignature(request)).byteLength;
}

function assertRequestByteLimit(value: unknown, label: string): void {
  const byteLength = new TextEncoder().encode(jsonSignature(value)).byteLength;
  if (byteLength > DATA_SURFACE_MAX_REQUEST_BYTES) {
    throw new TypeError(
      `${label} cannot exceed ${DATA_SURFACE_MAX_REQUEST_BYTES} UTF-8 bytes`,
    );
  }
}

function boundarySafe(value: unknown, label: string): DataSurfaceJsonValue {
  const clone = canonicalJson(value);
  const inspect = (entry: DataSurfaceJsonValue) => {
    if (Array.isArray(entry)) {
      for (const item of entry) inspect(item);
      return;
    }
    if (entry && typeof entry === 'object') {
      for (const [key, item] of Object.entries(entry)) {
        const normalizedKey = key.replaceAll(/[-_]/g, '').toLowerCase();
        if (FORBIDDEN_BOUNDARY_KEYS.has(normalizedKey)) {
          throw new TypeError(
            `${label} cannot contain authority or SQL field: ${key}`,
          );
        }
        inspect(item);
      }
    }
  };
  inspect(clone);
  return clone;
}

function boundarySafeObject(
  value: unknown,
  label: string,
): DataSurfaceJsonObject {
  const clone = boundarySafe(value, label);
  if (Array.isArray(clone) || clone === null || typeof clone !== 'object') {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return clone;
}

function normalizeIdentity(value: unknown): DataSurfaceIdentity {
  const object = plainObject(value, 'DataSurface identity');
  exactKeys(object, ['surfaceId', 'kind', 'subject'], 'DataSurface identity');
  const kind = stringValue(object.kind, 'DataSurface kind') as DataSurfaceKind;
  if (!DATA_SURFACE_KINDS.has(kind)) {
    throw new TypeError(`Unsupported DataSurface kind: ${kind}`);
  }
  let subject: DataSurfaceSubject | undefined;
  if (object.subject !== undefined) {
    const source = plainObject(object.subject, 'DataSurface subject');
    exactKeys(source, ['type', 'id', 'label'], 'DataSurface subject');
    const label = optionalString(source.label, 'DataSurface subject label');
    subject = {
      type: stringValue(source.type, 'DataSurface subject type'),
      id: stringValue(source.id, 'DataSurface subject id'),
      ...(label ? { label } : {}),
    };
  }
  return {
    surfaceId: stringValue(object.surfaceId, 'DataSurface surface id'),
    kind,
    ...(subject ? { subject } : {}),
  };
}

function identityKey(identity: DataSurfaceIdentity): string {
  return JSON.stringify([
    identity.kind,
    identity.surfaceId,
    identity.subject ? [identity.subject.type, identity.subject.id] : null,
  ]);
}

function cloneIdentity(identity: DataSurfaceIdentity): DataSurfaceIdentity {
  return normalizeIdentity(identity);
}

function normalizeStringArray(
  value: unknown,
  label: string,
  options: { sort?: boolean } = {},
): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length > MAX_JSON_CONTAINER_ITEMS) {
    throw new TypeError(
      `${label} cannot contain more than ${MAX_JSON_CONTAINER_ITEMS} items`,
    );
  }
  const values = value.map((entry) => stringValue(entry, label));
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} cannot contain duplicates`);
  }
  return options.sort ? values.sort() : values;
}

function normalizeCapabilityArray(
  value: unknown,
  label: string,
): DataSurfaceColumnCapability[] {
  const capabilities = normalizeStringArray(value, label, { sort: true });
  for (const capability of capabilities) {
    if (!COLUMN_CAPABILITIES.has(capability as DataSurfaceColumnCapability)) {
      throw new TypeError(
        `Unsupported DataSurface column capability: ${capability}`,
      );
    }
  }
  return capabilities as DataSurfaceColumnCapability[];
}

function normalizeSensitivity(
  value: unknown,
  label: string,
): DataSurfaceSensitivity | undefined {
  if (value === undefined) return undefined;
  const sensitivity = stringValue(value, label) as DataSurfaceSensitivity;
  if (!SENSITIVITIES.has(sensitivity)) {
    throw new TypeError(`Unsupported DataSurface sensitivity: ${sensitivity}`);
  }
  return sensitivity;
}

function normalizeSelection(value: unknown): DataSurfaceSelectionReference {
  const object = plainObject(value, 'DataSurface selection');
  const scope = stringValue(
    object.scope,
    'DataSurface selection scope',
  ) as DataSurfaceSelectionScope;
  if (!SELECTION_SCOPES.has(scope)) {
    throw new TypeError(`Unsupported DataSurface selection scope: ${scope}`);
  }
  if (scope === 'current-page') {
    exactKeys(object, ['scope'], 'DataSurface current-page selection');
    return { scope };
  }
  if (scope === 'explicit-ids') {
    exactKeys(object, ['scope', 'rowIds'], 'DataSurface explicit selection');
    if (!Array.isArray(object.rowIds)) {
      throw new TypeError(
        'DataSurface explicit selection rowIds must be an array',
      );
    }
    if (object.rowIds.length > MAX_JSON_CONTAINER_ITEMS) {
      throw new TypeError(
        `DataSurface explicit selection cannot contain more than ${MAX_JSON_CONTAINER_ITEMS} row ids`,
      );
    }
    const rowIds = new Map<string, DataSurfaceRowId>();
    for (const rowId of object.rowIds) {
      if (
        typeof rowId !== 'string' &&
        (typeof rowId !== 'number' || !Number.isFinite(rowId))
      ) {
        throw new TypeError(
          'DataSurface row ids must be finite strings or numbers',
        );
      }
      const normalized = typeof rowId === 'number' && rowId === 0 ? 0 : rowId;
      rowIds.set(`${typeof normalized}:${String(normalized)}`, normalized);
    }
    return {
      scope,
      rowIds: [...rowIds.values()].sort((left, right) => {
        if (typeof left !== typeof right)
          return typeof left === 'number' ? -1 : 1;
        if (typeof left === 'number' && typeof right === 'number')
          return left - right;
        return left < right ? -1 : left > right ? 1 : 0;
      }),
    };
  }
  exactKeys(
    object,
    ['scope', 'queryFingerprint'],
    'DataSurface all-matching selection',
  );
  return {
    scope,
    queryFingerprint: stringValue(
      object.queryFingerprint,
      'DataSurface query fingerprint',
    ),
  };
}

export function normalizeDataSurfaceDescriptor(
  value: DataSurfaceDescriptor,
): DataSurfaceDescriptor {
  const object = plainObject(value, 'DataSurface descriptor');
  exactKeys(
    object,
    [
      'version',
      'identity',
      'schemaVersion',
      'label',
      'description',
      'rowKey',
      'columns',
      'query',
      'controls',
      'actions',
      'limits',
    ],
    'DataSurface descriptor',
  );
  if (object.version !== 1) {
    throw new TypeError('Unsupported DataSurface descriptor version');
  }
  if (!Array.isArray(object.columns)) {
    throw new TypeError('DataSurface descriptor columns must be an array');
  }
  const columns = object.columns.map((value) => {
    const column = plainObject(value, 'DataSurface column');
    exactKeys(
      column,
      ['id', 'label', 'description', 'sensitivity', 'capabilities'],
      'DataSurface column',
    );
    const sensitivity = normalizeSensitivity(
      column.sensitivity,
      'DataSurface column sensitivity',
    );
    const description = optionalString(
      column.description,
      'DataSurface column description',
    );
    return {
      id: stringValue(column.id, 'DataSurface column id'),
      label: stringValue(column.label, 'DataSurface column label'),
      ...(description ? { description } : {}),
      ...(sensitivity ? { sensitivity } : {}),
      capabilities: normalizeCapabilityArray(
        column.capabilities,
        'DataSurface column capabilities',
      ),
    };
  });
  if (new Set(columns.map((column) => column.id)).size !== columns.length) {
    throw new TypeError('DataSurface descriptor column ids must be unique');
  }

  const query = plainObject(object.query, 'DataSurface query capabilities');
  exactKeys(
    query,
    ['modes', 'projectableColumnIds'],
    'DataSurface query capabilities',
  );
  const modes = normalizeStringArray(query.modes, 'DataSurface query modes', {
    sort: true,
  }) as DataSurfaceQueryMode[];
  for (const mode of modes) {
    if (!QUERY_MODES.has(mode)) {
      throw new TypeError(`Unsupported DataSurface query mode: ${mode}`);
    }
  }
  const projectableColumnIds = normalizeStringArray(
    query.projectableColumnIds,
    'DataSurface projectable column ids',
    { sort: true },
  );
  const knownColumns = new Set(columns.map((column) => column.id));
  for (const columnId of projectableColumnIds) {
    if (!knownColumns.has(columnId)) {
      throw new TypeError(
        `Unknown projectable DataSurface column: ${columnId}`,
      );
    }
  }

  if (!Array.isArray(object.controls)) {
    throw new TypeError('DataSurface controls must be an array');
  }
  const controls = object.controls.map((value) => {
    const control = plainObject(value, 'DataSurface control');
    exactKeys(control, ['id', 'label', 'description'], 'DataSurface control');
    const description = optionalString(
      control.description,
      'DataSurface control description',
    );
    return {
      id: stringValue(control.id, 'DataSurface control id'),
      label: stringValue(control.label, 'DataSurface control label'),
      ...(description ? { description } : {}),
    };
  });
  if (new Set(controls.map((control) => control.id)).size !== controls.length) {
    throw new TypeError('DataSurface control ids must be unique');
  }

  if (!Array.isArray(object.actions)) {
    throw new TypeError('DataSurface actions must be an array');
  }
  const actions = object.actions.map((value) => {
    const action = plainObject(value, 'DataSurface action');
    exactKeys(
      action,
      [
        'id',
        'label',
        'description',
        'sensitivity',
        'selectionScopes',
        'requiresConfirmation',
      ],
      'DataSurface action',
    );
    if (
      action.requiresConfirmation !== undefined &&
      typeof action.requiresConfirmation !== 'boolean'
    ) {
      throw new TypeError(
        'DataSurface action requiresConfirmation must be boolean',
      );
    }
    const scopes = normalizeStringArray(
      action.selectionScopes,
      'DataSurface action selection scopes',
      { sort: true },
    ) as DataSurfaceSelectionScope[];
    for (const scope of scopes) {
      if (!SELECTION_SCOPES.has(scope)) {
        throw new TypeError(
          `Unsupported DataSurface action selection scope: ${scope}`,
        );
      }
    }
    const sensitivity = normalizeSensitivity(
      action.sensitivity,
      'DataSurface action sensitivity',
    );
    const description = optionalString(
      action.description,
      'DataSurface action description',
    );
    return {
      id: stringValue(action.id, 'DataSurface action id'),
      label: stringValue(action.label, 'DataSurface action label'),
      ...(description ? { description } : {}),
      ...(sensitivity ? { sensitivity } : {}),
      selectionScopes: scopes,
      ...(action.requiresConfirmation === undefined
        ? {}
        : { requiresConfirmation: action.requiresConfirmation }),
    };
  });
  if (new Set(actions.map((action) => action.id)).size !== actions.length) {
    throw new TypeError('DataSurface action ids must be unique');
  }

  const limits = plainObject(object.limits, 'DataSurface limits');
  exactKeys(
    limits,
    ['maxQueryRows', 'maxQueryBytes', 'maxSelectionSize'],
    'DataSurface limits',
  );
  const maxQueryRows = positiveInteger(
    limits.maxQueryRows,
    'DataSurface maxQueryRows',
  );
  if (maxQueryRows > MAX_QUERY_LIMIT) {
    throw new TypeError(
      `DataSurface maxQueryRows cannot exceed ${MAX_QUERY_LIMIT}`,
    );
  }
  const rowKey = stringValue(object.rowKey, 'DataSurface row key');
  if (!knownColumns.has(rowKey)) {
    throw new TypeError('DataSurface rowKey must name a declared column');
  }

  const description = optionalString(
    object.description,
    'DataSurface description',
  );
  return {
    version: 1,
    identity: normalizeIdentity(object.identity),
    schemaVersion: positiveInteger(
      object.schemaVersion,
      'DataSurface schema version',
    ),
    label: stringValue(object.label, 'DataSurface label'),
    ...(description ? { description } : {}),
    rowKey,
    columns,
    query: { modes, projectableColumnIds },
    controls,
    actions,
    limits: {
      maxQueryRows,
      maxQueryBytes: positiveInteger(
        limits.maxQueryBytes,
        'DataSurface maxQueryBytes',
      ),
      maxSelectionSize: positiveInteger(
        limits.maxSelectionSize,
        'DataSurface maxSelectionSize',
      ),
    },
  };
}

export function normalizeDataSurfaceSnapshot(
  value: DataSurfaceSnapshot,
): DataSurfaceSnapshot {
  const object = plainObject(value, 'DataSurface snapshot');
  exactKeys(
    object,
    ['version', 'descriptor', 'revision', 'state', 'selection'],
    'DataSurface snapshot',
  );
  if (object.version !== 1) {
    throw new TypeError('Unsupported DataSurface snapshot version');
  }
  return {
    version: 1,
    descriptor: normalizeDataSurfaceDescriptor(
      object.descriptor as DataSurfaceDescriptor,
    ),
    revision: revisionNumber(object.revision),
    state: boundarySafeObject(object.state, 'DataSurface snapshot state'),
    selection:
      object.selection === null || object.selection === undefined
        ? null
        : normalizeSelection(object.selection),
  };
}

export function normalizeDataSurfaceVisibleCommand(
  value: DataSurfaceVisibleCommand,
): DataSurfaceVisibleCommand {
  const object = plainObject(value, 'DataSurface visible command');
  exactKeys(
    object,
    [
      'version',
      'commandId',
      'identity',
      'expectedRevision',
      'controlId',
      'payload',
    ],
    'DataSurface visible command',
  );
  if (object.version !== 1) {
    throw new TypeError('Unsupported DataSurface visible command version');
  }
  const commandId = stringValue(object.commandId, 'DataSurface command id');
  if (commandId.length > MAX_REQUEST_ID_LENGTH) {
    throw new TypeError('DataSurface command id is too long');
  }
  const normalized: DataSurfaceVisibleCommand = {
    version: 1,
    commandId,
    identity: normalizeIdentity(object.identity),
    expectedRevision: revisionNumber(object.expectedRevision),
    controlId: stringValue(object.controlId, 'DataSurface control id'),
    ...(object.payload === undefined
      ? {}
      : {
          payload: boundarySafe(object.payload, 'DataSurface command payload'),
        }),
  };
  assertRequestByteLimit(normalized, 'DataSurface visible command');
  return normalized;
}

export function normalizeDataSurfaceQueryRequest(
  value: DataSurfaceQueryRequest,
): DataSurfaceQueryRequest {
  const object = plainObject(value, 'DataSurface query request');
  const kind = stringValue(object.kind, 'DataSurface query kind');
  if (object.version !== 1) {
    throw new TypeError('Unsupported DataSurface query request version');
  }
  const requestId = stringValue(
    object.requestId,
    'DataSurface query request id',
  );
  if (requestId.length > MAX_REQUEST_ID_LENGTH) {
    throw new TypeError('DataSurface query request id is too long');
  }
  const identity = normalizeIdentity(object.identity);
  if (kind === 'rows') {
    exactKeys(
      object,
      [
        'version',
        'requestId',
        'identity',
        'kind',
        'limit',
        'cursor',
        'projection',
      ],
      'DataSurface rows query request',
    );
    const limit = positiveInteger(object.limit, 'DataSurface rows query limit');
    if (limit > MAX_QUERY_LIMIT) {
      throw new TypeError(
        `DataSurface rows query limit cannot exceed ${MAX_QUERY_LIMIT}`,
      );
    }
    const cursor = optionalString(
      object.cursor,
      'DataSurface rows query cursor',
    );
    if (cursor && cursor.length > MAX_CURSOR_LENGTH) {
      throw new TypeError('DataSurface rows query cursor is too long');
    }
    return {
      version: 1,
      requestId,
      identity,
      kind,
      limit,
      ...(cursor ? { cursor } : {}),
      ...(object.projection === undefined
        ? {}
        : {
            projection: normalizeStringArray(
              object.projection,
              'DataSurface query projection',
              { sort: true },
            ),
          }),
    };
  }
  if (kind === 'count') {
    exactKeys(
      object,
      ['version', 'requestId', 'identity', 'kind'],
      'DataSurface count query request',
    );
    return { version: 1, requestId, identity, kind };
  }
  if (kind === 'facets') {
    exactKeys(
      object,
      ['version', 'requestId', 'identity', 'kind', 'columnId', 'limit'],
      'DataSurface facets query request',
    );
    const limit = positiveInteger(
      object.limit,
      'DataSurface facets query limit',
    );
    if (limit > MAX_QUERY_LIMIT) {
      throw new TypeError(
        `DataSurface facets query limit cannot exceed ${MAX_QUERY_LIMIT}`,
      );
    }
    return {
      version: 1,
      requestId,
      identity,
      kind,
      columnId: stringValue(
        object.columnId,
        'DataSurface facets query column id',
      ),
      limit,
    };
  }
  throw new TypeError(`Unsupported DataSurface query kind: ${kind}`);
}

export function normalizeDataSurfaceActionRequest(
  value: DataSurfaceActionRequest,
): DataSurfaceActionRequest {
  const object = plainObject(value, 'DataSurface action request');
  exactKeys(
    object,
    [
      'version',
      'requestId',
      'identity',
      'actionId',
      'phase',
      'selection',
      'payload',
      'confirmationToken',
    ],
    'DataSurface action request',
  );
  if (object.version !== 1) {
    throw new TypeError('Unsupported DataSurface action request version');
  }
  const requestId = stringValue(
    object.requestId,
    'DataSurface action request id',
  );
  if (requestId.length > MAX_REQUEST_ID_LENGTH) {
    throw new TypeError('DataSurface action request id is too long');
  }
  const phase = stringValue(object.phase, 'DataSurface action phase');
  if (phase !== 'preview' && phase !== 'apply') {
    throw new TypeError(`Unsupported DataSurface action phase: ${phase}`);
  }
  const confirmationToken = optionalString(
    object.confirmationToken,
    'DataSurface confirmation token',
  );
  const normalized: DataSurfaceActionRequest = {
    version: 1,
    requestId,
    identity: normalizeIdentity(object.identity),
    actionId: stringValue(object.actionId, 'DataSurface action id'),
    phase,
    selection: normalizeSelection(object.selection),
    ...(object.payload === undefined
      ? {}
      : {
          payload: boundarySafe(object.payload, 'DataSurface action payload'),
        }),
    ...(confirmationToken ? { confirmationToken } : {}),
  };
  assertRequestByteLimit(normalized, 'DataSurface action request');
  return normalized;
}

interface Entry {
  key: string;
  descriptor: DataSurfaceDescriptor;
  registration: DataSurfaceRegistration;
  lastRevision: number;
  commandBlockedAtRevision?: number;
  replay: Map<string, { signature: string; result: DataSurfaceCommandResult }>;
  commandQueue: Promise<void>;
}

interface ReadSnapshot {
  raw: DataSurfaceSnapshot;
  exposed: DataSurfaceSnapshot;
}

function snapshotFrom(
  descriptor: DataSurfaceDescriptor,
  input: DataSurfaceSnapshotState,
): DataSurfaceSnapshot {
  return normalizeDataSurfaceSnapshot({
    version: 1,
    descriptor,
    revision: input.revision,
    state: input.state,
    selection: input.selection ?? null,
  });
}

function cloneSnapshot(snapshot: DataSurfaceSnapshot): DataSurfaceSnapshot {
  return normalizeDataSurfaceSnapshot(snapshot);
}

function cloneResult(
  result: DataSurfaceCommandResult,
): DataSurfaceCommandResult {
  return {
    ok: result.ok,
    commandId: result.commandId,
    identity: cloneIdentity(result.identity),
    ...(result.revision === undefined ? {} : { revision: result.revision }),
    ...(result.snapshot ? { snapshot: cloneSnapshot(result.snapshot) } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

function sameIdentity(
  left: DataSurfaceIdentity,
  right: DataSurfaceIdentity,
): boolean {
  return identityKey(left) === identityKey(right);
}

function sameSnapshotContent(
  left: DataSurfaceSnapshot,
  right: DataSurfaceSnapshot,
): boolean {
  return (
    jsonSignature(left.state) === jsonSignature(right.state) &&
    jsonSignature(left.selection) === jsonSignature(right.selection)
  );
}

/** Create an isolated registry; applications choose how it is exposed. */
export function createDataSurfaceRegistry(): DataSurfaceRegistry {
  const entries = new Map<string, Entry>();
  const listeners = new Set<(event: DataSurfaceRegistryEvent) => void>();
  let sequence = 0;

  const readSnapshot = (entry: Entry): ReadSnapshot => {
    const raw = snapshotFrom(
      entry.descriptor,
      entry.registration.getSnapshot(),
    );
    if (raw.revision < entry.lastRevision) {
      throw new RangeError('DataSurface revision must be monotonic');
    }
    entry.lastRevision = raw.revision;

    const exposed = entry.registration.redact
      ? normalizeDataSurfaceSnapshot(
          entry.registration.redact(cloneSnapshot(raw)),
        )
      : raw;
    if (
      !sameIdentity(exposed.descriptor.identity, entry.descriptor.identity) ||
      exposed.revision !== raw.revision
    ) {
      throw new TypeError(
        'DataSurface redaction cannot change identity or revision',
      );
    }
    return { raw, exposed };
  };

  const emit = (
    type: DataSurfaceRegistryEvent['type'],
    entry: Entry,
    revision: number,
    command?: DataSurfaceVisibleCommand,
    result?: DataSurfaceCommandResult,
  ) => {
    const event: DataSurfaceRegistryEvent = {
      type,
      sequence: ++sequence,
      identity: cloneIdentity(entry.descriptor.identity),
      revision,
      ...(command
        ? { command: normalizeDataSurfaceVisibleCommand(command) }
        : {}),
      ...(result ? { result: cloneResult(result) } : {}),
    };
    for (const listener of listeners) {
      try {
        listener({
          ...event,
          identity: cloneIdentity(event.identity),
          ...(event.command
            ? { command: normalizeDataSurfaceVisibleCommand(event.command) }
            : {}),
          ...(event.result ? { result: cloneResult(event.result) } : {}),
        });
      } catch {
        // Subscribers are observational and cannot alter registry operations.
      }
    }
  };

  const cacheResult = (
    entry: Entry,
    command: DataSurfaceVisibleCommand,
    result: DataSurfaceCommandResult,
  ) => {
    entry.replay.set(command.commandId, {
      signature: jsonSignature(command),
      result: cloneResult(result),
    });
    while (entry.replay.size > DATA_SURFACE_MAX_REPLAY_ENTRIES) {
      const oldestCommandId = entry.replay.keys().next().value;
      if (oldestCommandId === undefined) break;
      entry.replay.delete(oldestCommandId);
    }
    emit(
      'command',
      entry,
      result.revision ?? entry.lastRevision,
      command,
      result,
    );
    return cloneResult(result);
  };

  const validationForIdentity = (
    identity: DataSurfaceIdentity,
  ): Entry | undefined => entries.get(identityKey(identity));

  const serializeCommand = async <T>(
    entry: Entry,
    run: () => Promise<T>,
  ): Promise<T> => {
    const previous = entry.commandQueue;
    let releaseQueue!: () => void;
    entry.commandQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previous;
    try {
      return await run();
    } finally {
      releaseQueue();
    }
  };

  return {
    register(registration) {
      const descriptor = normalizeDataSurfaceDescriptor(
        registration.descriptor,
      );
      const key = identityKey(descriptor.identity);
      if (entries.has(key)) {
        throw new Error(
          `DataSurface identity is already registered: ${descriptor.identity.surfaceId}`,
        );
      }
      const entry: Entry = {
        key,
        descriptor,
        registration,
        lastRevision: -1,
        replay: new Map(),
        commandQueue: Promise.resolve(),
      };
      entries.set(key, entry);
      try {
        const snapshot = readSnapshot(entry);
        emit('registered', entry, snapshot.exposed.revision);
      } catch (error) {
        entries.delete(key);
        throw error;
      }
      return () => {
        if (entries.get(key) !== entry) return;
        entries.delete(key);
        emit('unregistered', entry, Math.max(0, entry.lastRevision));
      };
    },

    unregister(identity) {
      const normalized = normalizeIdentity(identity);
      const entry = entries.get(identityKey(normalized));
      if (!entry) return;
      entries.delete(entry.key);
      emit('unregistered', entry, Math.max(0, entry.lastRevision));
    },

    list() {
      return [...entries.values()]
        .sort((left, right) => left.key.localeCompare(right.key))
        .map((entry) => normalizeDataSurfaceDescriptor(entry.descriptor));
    },

    inspect(identity) {
      const normalized = normalizeIdentity(identity);
      const entry = entries.get(identityKey(normalized));
      return entry ? cloneSnapshot(readSnapshot(entry).exposed) : undefined;
    },

    async execute(command) {
      const normalized = normalizeDataSurfaceVisibleCommand(command);
      const entry = entries.get(identityKey(normalized.identity));
      if (!entry) {
        return {
          ok: false,
          commandId: normalized.commandId,
          identity: cloneIdentity(normalized.identity),
          reason: 'not_found',
        };
      }

      return serializeCommand(entry, async () => {
        if (entries.get(entry.key) !== entry) {
          return {
            ok: false,
            commandId: normalized.commandId,
            identity: cloneIdentity(normalized.identity),
            reason: 'not_found' as const,
          };
        }
        const signature = jsonSignature(normalized);
        const replay = entry.replay.get(normalized.commandId);
        if (replay) {
          if (replay.signature === signature) {
            entry.replay.delete(normalized.commandId);
            entry.replay.set(normalized.commandId, replay);
            return cloneResult(replay.result);
          }
          const snapshot = readSnapshot(entry).exposed;
          const result: DataSurfaceCommandResult = {
            ok: false,
            commandId: normalized.commandId,
            identity: cloneIdentity(entry.descriptor.identity),
            revision: snapshot.revision,
            snapshot,
            reason: 'idempotency_conflict',
          };
          emit('command', entry, snapshot.revision, normalized, result);
          return cloneResult(result);
        }

        const before = readSnapshot(entry);
        if (
          entry.commandBlockedAtRevision !== undefined &&
          before.raw.revision <= entry.commandBlockedAtRevision
        ) {
          return cacheResult(entry, normalized, {
            ok: false,
            commandId: normalized.commandId,
            identity: cloneIdentity(entry.descriptor.identity),
            revision: before.exposed.revision,
            snapshot: before.exposed,
            reason: 'non_monotonic_revision',
          });
        }
        entry.commandBlockedAtRevision = undefined;
        if (before.raw.revision !== normalized.expectedRevision) {
          return cacheResult(entry, normalized, {
            ok: false,
            commandId: normalized.commandId,
            identity: cloneIdentity(entry.descriptor.identity),
            revision: before.exposed.revision,
            snapshot: before.exposed,
            reason: 'stale_revision',
          });
        }
        if (
          !entry.descriptor.controls.some(
            (control) => control.id === normalized.controlId,
          )
        ) {
          return cacheResult(entry, normalized, {
            ok: false,
            commandId: normalized.commandId,
            identity: cloneIdentity(entry.descriptor.identity),
            revision: before.exposed.revision,
            snapshot: before.exposed,
            reason: 'unsupported',
          });
        }
        if (!entry.registration.execute) {
          return cacheResult(entry, normalized, {
            ok: false,
            commandId: normalized.commandId,
            identity: cloneIdentity(entry.descriptor.identity),
            revision: before.exposed.revision,
            snapshot: before.exposed,
            reason: 'unsupported',
          });
        }

        try {
          const execution = await entry.registration.execute(
            normalizeDataSurfaceVisibleCommand(normalized),
          );
          const after = readSnapshot(entry);
          if (
            sameSnapshotContent(before.raw, after.raw) === false &&
            after.raw.revision <= before.raw.revision
          ) {
            entry.commandBlockedAtRevision = after.raw.revision;
            return cacheResult(entry, normalized, {
              ok: false,
              commandId: normalized.commandId,
              identity: cloneIdentity(entry.descriptor.identity),
              revision: after.exposed.revision,
              snapshot: after.exposed,
              reason: 'non_monotonic_revision',
            });
          }
          if (execution && execution.ok === false) {
            return cacheResult(entry, normalized, {
              ok: false,
              commandId: normalized.commandId,
              identity: cloneIdentity(entry.descriptor.identity),
              revision: after.exposed.revision,
              snapshot: after.exposed,
              reason: 'denied',
            });
          }
          return cacheResult(entry, normalized, {
            ok: true,
            commandId: normalized.commandId,
            identity: cloneIdentity(entry.descriptor.identity),
            revision: after.exposed.revision,
            snapshot: after.exposed,
          });
        } catch {
          let current: ReadSnapshot | undefined;
          try {
            current = readSnapshot(entry);
          } catch {
            // A teardown can make snapshot retrieval fail after the handler.
          }
          if (
            current &&
            sameSnapshotContent(before.raw, current.raw) === false &&
            current.raw.revision <= before.raw.revision
          ) {
            entry.commandBlockedAtRevision = current.raw.revision;
            return cacheResult(entry, normalized, {
              ok: false,
              commandId: normalized.commandId,
              identity: cloneIdentity(entry.descriptor.identity),
              revision: current.exposed.revision,
              snapshot: current.exposed,
              reason: 'non_monotonic_revision',
            });
          }
          return cacheResult(entry, normalized, {
            ok: false,
            commandId: normalized.commandId,
            identity: cloneIdentity(entry.descriptor.identity),
            ...(current
              ? {
                  revision: current.exposed.revision,
                  snapshot: current.exposed,
                }
              : {}),
            reason: 'execution_failed',
          });
        }
      });
    },

    validateQuery(request) {
      try {
        const normalized = normalizeDataSurfaceQueryRequest(request);
        const entry = validationForIdentity(normalized.identity);
        if (!entry) return { ok: false, reason: 'not_found' };
        if (!entry.descriptor.query.modes.includes(normalized.kind)) {
          return { ok: false, reason: 'unsupported' };
        }
        if (
          canonicalQueryByteLength(normalized) >
          entry.descriptor.limits.maxQueryBytes
        ) {
          return { ok: false, reason: 'limit_exceeded' };
        }
        if (
          'limit' in normalized &&
          normalized.limit > entry.descriptor.limits.maxQueryRows
        ) {
          return { ok: false, reason: 'limit_exceeded' };
        }
        if (normalized.kind === 'rows' && normalized.projection) {
          if (
            normalized.projection.some(
              (columnId) =>
                !entry.descriptor.query.projectableColumnIds.includes(columnId),
            )
          ) {
            return { ok: false, reason: 'projection_not_allowed' };
          }
        }
        if (
          normalized.kind === 'facets' &&
          !entry.descriptor.query.projectableColumnIds.includes(
            normalized.columnId,
          )
        ) {
          return { ok: false, reason: 'projection_not_allowed' };
        }
        return { ok: true };
      } catch {
        return { ok: false, reason: 'invalid_request' };
      }
    },

    validateAction(request) {
      try {
        const normalized = normalizeDataSurfaceActionRequest(request);
        const entry = validationForIdentity(normalized.identity);
        if (!entry) return { ok: false, reason: 'not_found' };
        const action = entry.descriptor.actions.find(
          (candidate) => candidate.id === normalized.actionId,
        );
        if (!action) return { ok: false, reason: 'unsupported' };
        if (!action.selectionScopes.includes(normalized.selection.scope)) {
          return { ok: false, reason: 'selection_not_supported' };
        }
        if (
          normalized.selection.scope === 'explicit-ids' &&
          normalized.selection.rowIds.length >
            entry.descriptor.limits.maxSelectionSize
        ) {
          return { ok: false, reason: 'limit_exceeded' };
        }
        if (
          normalized.phase === 'apply' &&
          action.requiresConfirmation !== false &&
          !normalized.confirmationToken
        ) {
          return { ok: false, reason: 'confirmation_required' };
        }
        return { ok: true };
      } catch {
        return { ok: false, reason: 'invalid_request' };
      }
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
