/**
 * Node-safe canonical validation for the server-side data-surface bridge.
 *
 * Keep this leaf free of Svelte imports. The browser-facing smrt-ui barrel
 * includes component modules and is not safe to load from a plain Node server.
 */

const MAX_REQUEST_BYTES = 100_000;
export const DATA_SURFACE_IDENTIFIER_MAX_LENGTH = 256;
const MAX_QUERY_LIMIT = 1_000;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_CONTAINER_ITEMS = 1_000;
const PROTOTYPE_POLLUTION_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
const FORBIDDEN_BOUNDARY_KEYS = new Set([
  'tenant',
  'tenantid',
  'principalid',
  'principal',
  'actorid',
  'auth',
  'authtoken',
  'authorization',
  'authorizationtoken',
  'authorizationheader',
  'authentication',
  'authenticationtoken',
  'accesstoken',
  'token',
  'bearer',
  'bearertoken',
  'apikey',
  'sessiontoken',
  'credential',
  'credentials',
  'sql',
  'rawsql',
  'rawquery',
  'where',
]);
const KINDS = new Set(['table', 'list', 'report', 'custom']);
const SENSITIVITIES = new Set(['public', 'personal', 'sensitive', 'secret']);
const CAPABILITIES = new Set(['read', 'search', 'filter', 'sort', 'project']);
const QUERY_MODES = new Set(['rows', 'count', 'facets']);
const SELECTION_SCOPES = new Set([
  'current-page',
  'explicit-ids',
  'all-matching',
]);

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface Budget {
  used: number;
  limit: number;
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) {
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

function identifierValue(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (result.length > DATA_SURFACE_IDENTIFIER_MAX_LENGTH) {
    throw new TypeError(`${label} is too long`);
  }
  return result;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, label);
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function revisionNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('DataSurface revision must be a non-negative integer');
  }
  return value;
}

function addBytes(budget: Budget | undefined, bytes: number): void {
  if (!budget) return;
  if (bytes > budget.limit - budget.used) {
    throw new TypeError(
      `DataSurface envelope cannot exceed ${budget.limit} UTF-8 bytes`,
    );
  }
  budget.used += bytes;
}

function jsonStringByteLength(value: string, budget?: Budget): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0x22 || codeUnit === 0x5c) bytes += 2;
    else if (
      codeUnit === 0x08 ||
      codeUnit === 0x09 ||
      codeUnit === 0x0a ||
      codeUnit === 0x0c ||
      codeUnit === 0x0d
    )
      bytes += 2;
    else if (codeUnit <= 0x1f) bytes += 6;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 6;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) bytes += 6;
    else if (codeUnit <= 0x7f) bytes += 1;
    else if (codeUnit <= 0x7ff) bytes += 2;
    else bytes += 3;
    if (budget && bytes > budget.limit - budget.used) {
      throw new TypeError(
        `DataSurface envelope cannot exceed ${budget.limit} UTF-8 bytes`,
      );
    }
  }
  addBytes(budget, bytes);
  return bytes;
}

function canonicalJson(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0,
  budget?: Budget,
): JsonValue {
  if (depth > MAX_JSON_DEPTH) {
    throw new TypeError(
      `DataSurface values cannot exceed ${MAX_JSON_DEPTH} levels`,
    );
  }
  if (value === null) {
    addBytes(budget, 4);
    return null;
  }
  if (typeof value === 'string') {
    jsonStringByteLength(value, budget);
    return value;
  }
  if (typeof value === 'boolean') {
    addBytes(budget, value ? 4 : 5);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        'DataSurface values cannot contain non-finite numbers',
      );
    }
    const normalized = value === 0 ? 0 : value;
    addBytes(budget, String(normalized).length);
    return normalized;
  }
  if (!value || typeof value !== 'object') {
    throw new TypeError('DataSurface values must be JSON-safe plain data');
  }
  if (ancestors.has(value)) {
    throw new TypeError('DataSurface values cannot be circular');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_JSON_CONTAINER_ITEMS) {
        throw new TypeError('DataSurface arrays contain too many items');
      }
      addBytes(budget, 1);
      const clone: JsonValue[] = [];
      for (const [index, entry] of value.entries()) {
        if (index > 0) addBytes(budget, 1);
        clone.push(canonicalJson(entry, ancestors, depth + 1, budget));
      }
      addBytes(budget, 1);
      return clone;
    }
    const object = plainObject(value, 'DataSurface value');
    const clone: { [key: string]: JsonValue } = {};
    const keys = Object.keys(object).sort();
    if (keys.length > MAX_JSON_CONTAINER_ITEMS) {
      throw new TypeError('DataSurface objects contain too many keys');
    }
    addBytes(budget, 1);
    for (const [index, key] of keys.entries()) {
      if (index > 0) addBytes(budget, 1);
      if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
        throw new TypeError(
          `DataSurface values cannot contain prototype key: ${key}`,
        );
      }
      jsonStringByteLength(key, budget);
      addBytes(budget, 1);
      clone[key] = canonicalJson(object[key], ancestors, depth + 1, budget);
    }
    addBytes(budget, 1);
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function assertRequestByteLimit(value: unknown): void {
  canonicalJson(value, new Set<object>(), 0, {
    used: 0,
    limit: MAX_REQUEST_BYTES,
  });
}

export function assertDataSurfaceEnvelope(value: unknown): void {
  assertRequestByteLimit(value);
}

function boundarySafe(value: unknown): JsonValue {
  const clone = canonicalJson(value);
  const inspect = (entry: JsonValue): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) inspect(item);
    } else if (entry && typeof entry === 'object') {
      for (const [key, item] of Object.entries(entry)) {
        if (
          FORBIDDEN_BOUNDARY_KEYS.has(key.replaceAll(/[-_]/g, '').toLowerCase())
        ) {
          throw new TypeError(
            `DataSurface boundary field is forbidden: ${key}`,
          );
        }
        inspect(item);
      }
    }
  };
  inspect(clone);
  return clone;
}

function boundarySafeObject(value: unknown): { [key: string]: JsonValue } {
  const clone = boundarySafe(value);
  if (!clone || Array.isArray(clone) || typeof clone !== 'object') {
    throw new TypeError('DataSurface snapshot state must be an object');
  }
  return clone;
}

function normalizeIdentity(value: unknown): Record<string, unknown> {
  const object = plainObject(value, 'DataSurface identity');
  exactKeys(object, ['surfaceId', 'kind', 'subject'], 'DataSurface identity');
  const kind = stringValue(object.kind, 'DataSurface kind');
  if (!KINDS.has(kind))
    throw new TypeError(`Unsupported DataSurface kind: ${kind}`);
  let subject: Record<string, string> | undefined;
  if (object.subject !== undefined) {
    const source = plainObject(object.subject, 'DataSurface subject');
    exactKeys(source, ['type', 'id', 'label'], 'DataSurface subject');
    subject = {
      type: identifierValue(source.type, 'DataSurface subject type'),
      id: identifierValue(source.id, 'DataSurface subject id'),
      ...(source.label === undefined
        ? {}
        : { label: stringValue(source.label, 'DataSurface subject label') }),
    };
  }
  return {
    surfaceId: identifierValue(object.surfaceId, 'DataSurface surface id'),
    kind,
    ...(subject ? { subject } : {}),
  };
}

function normalizeStringArray(
  value: unknown,
  label: string,
  sort = false,
): string[] {
  if (!Array.isArray(value) || value.length > MAX_JSON_CONTAINER_ITEMS) {
    throw new TypeError(`${label} must be a bounded array`);
  }
  const values = value.map((entry) => stringValue(entry, label));
  if (new Set(values).size !== values.length) {
    throw new TypeError(`${label} cannot contain duplicates`);
  }
  return sort ? values.sort() : values;
}

function normalizeIdentifierArray(
  value: unknown,
  label: string,
  sort = false,
): string[] {
  return normalizeStringArray(value, label, sort).map((entry) =>
    identifierValue(entry, label),
  );
}

function normalizeSensitivity(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  const sensitivity = stringValue(value, label);
  if (!SENSITIVITIES.has(sensitivity)) {
    throw new TypeError(`Unsupported DataSurface sensitivity: ${sensitivity}`);
  }
  return sensitivity;
}

function normalizeSelection(value: unknown): Record<string, unknown> {
  const object = plainObject(value, 'DataSurface selection');
  const scope = stringValue(object.scope, 'DataSurface selection scope');
  if (!SELECTION_SCOPES.has(scope)) {
    throw new TypeError(`Unsupported DataSurface selection scope: ${scope}`);
  }
  if (scope === 'current-page') {
    exactKeys(object, ['scope'], 'DataSurface current-page selection');
    return { scope };
  }
  if (scope === 'explicit-ids') {
    exactKeys(object, ['scope', 'rowIds'], 'DataSurface explicit selection');
    if (
      !Array.isArray(object.rowIds) ||
      object.rowIds.length > MAX_JSON_CONTAINER_ITEMS
    ) {
      throw new TypeError(
        'DataSurface explicit selection rowIds must be bounded',
      );
    }
    const rowIds = new Map<string, string | number>();
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

export function normalizeDataSurfaceDescriptor(value: unknown): unknown {
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
  if (object.version !== 1)
    throw new TypeError('Unsupported DataSurface descriptor version');
  if (
    !Array.isArray(object.columns) ||
    object.columns.length > MAX_JSON_CONTAINER_ITEMS
  ) {
    throw new TypeError('DataSurface descriptor columns must be bounded');
  }
  const columns = object.columns.map((value) => {
    const column = plainObject(value, 'DataSurface column');
    exactKeys(
      column,
      ['id', 'label', 'description', 'sensitivity', 'capabilities'],
      'DataSurface column',
    );
    const capabilities = normalizeStringArray(
      column.capabilities,
      'DataSurface column capabilities',
      true,
    );
    if (capabilities.some((capability) => !CAPABILITIES.has(capability))) {
      throw new TypeError('Unsupported DataSurface column capability');
    }
    return {
      id: identifierValue(column.id, 'DataSurface column id'),
      label: stringValue(column.label, 'DataSurface column label'),
      ...(column.description === undefined
        ? {}
        : {
            description: stringValue(
              column.description,
              'DataSurface column description',
            ),
          }),
      ...(column.sensitivity === undefined
        ? {}
        : {
            sensitivity: normalizeSensitivity(
              column.sensitivity,
              'DataSurface column sensitivity',
            ),
          }),
      capabilities,
    };
  });
  if (new Set(columns.map((column) => column.id)).size !== columns.length)
    throw new TypeError('DataSurface descriptor column ids must be unique');
  const query = plainObject(object.query, 'DataSurface query capabilities');
  exactKeys(
    query,
    ['modes', 'projectableColumnIds'],
    'DataSurface query capabilities',
  );
  const modes = normalizeStringArray(
    query.modes,
    'DataSurface query modes',
    true,
  );
  if (modes.some((mode) => !QUERY_MODES.has(mode)))
    throw new TypeError('Unsupported DataSurface query mode');
  const projectableColumnIds = normalizeIdentifierArray(
    query.projectableColumnIds,
    'DataSurface projectable column ids',
    true,
  );
  const knownColumns = new Set(columns.map((column) => column.id));
  if (projectableColumnIds.some((columnId) => !knownColumns.has(columnId)))
    throw new TypeError('Unknown projectable DataSurface column');
  if (
    !Array.isArray(object.controls) ||
    object.controls.length > MAX_JSON_CONTAINER_ITEMS
  )
    throw new TypeError('DataSurface controls must be bounded');
  const controls = object.controls.map((value) => {
    const control = plainObject(value, 'DataSurface control');
    exactKeys(control, ['id', 'label', 'description'], 'DataSurface control');
    return {
      id: identifierValue(control.id, 'DataSurface control id'),
      label: stringValue(control.label, 'DataSurface control label'),
      ...(control.description === undefined
        ? {}
        : {
            description: stringValue(
              control.description,
              'DataSurface control description',
            ),
          }),
    };
  });
  if (new Set(controls.map((control) => control.id)).size !== controls.length)
    throw new TypeError('DataSurface control ids must be unique');
  if (
    !Array.isArray(object.actions) ||
    object.actions.length > MAX_JSON_CONTAINER_ITEMS
  )
    throw new TypeError('DataSurface actions must be bounded');
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
    )
      throw new TypeError(
        'DataSurface action requiresConfirmation must be boolean',
      );
    const selectionScopes = normalizeStringArray(
      action.selectionScopes,
      'DataSurface action selection scopes',
      true,
    );
    if (selectionScopes.some((scope) => !SELECTION_SCOPES.has(scope)))
      throw new TypeError('Unsupported DataSurface action selection scope');
    return {
      id: identifierValue(action.id, 'DataSurface action id'),
      label: stringValue(action.label, 'DataSurface action label'),
      ...(action.description === undefined
        ? {}
        : {
            description: stringValue(
              action.description,
              'DataSurface action description',
            ),
          }),
      ...(action.sensitivity === undefined
        ? {}
        : {
            sensitivity: normalizeSensitivity(
              action.sensitivity,
              'DataSurface action sensitivity',
            ),
          }),
      selectionScopes,
      ...(action.requiresConfirmation === undefined
        ? {}
        : { requiresConfirmation: action.requiresConfirmation }),
    };
  });
  if (new Set(actions.map((action) => action.id)).size !== actions.length)
    throw new TypeError('DataSurface action ids must be unique');
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
  if (maxQueryRows > MAX_QUERY_LIMIT)
    throw new TypeError('DataSurface maxQueryRows exceeds its limit');
  const rowKey = identifierValue(object.rowKey, 'DataSurface row key');
  if (!knownColumns.has(rowKey))
    throw new TypeError('DataSurface rowKey must name a declared column');
  return {
    version: 1,
    identity: normalizeIdentity(object.identity),
    schemaVersion: positiveInteger(
      object.schemaVersion,
      'DataSurface schema version',
    ),
    label: stringValue(object.label, 'DataSurface label'),
    ...(object.description === undefined
      ? {}
      : {
          description: stringValue(
            object.description,
            'DataSurface description',
          ),
        }),
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

export function normalizeDataSurfaceSnapshot(value: unknown): unknown {
  const object = plainObject(value, 'DataSurface snapshot');
  exactKeys(
    object,
    ['version', 'descriptor', 'revision', 'state', 'selection'],
    'DataSurface snapshot',
  );
  if (object.version !== 1)
    throw new TypeError('Unsupported DataSurface snapshot version');
  return {
    version: 1,
    descriptor: normalizeDataSurfaceDescriptor(object.descriptor),
    revision: revisionNumber(object.revision),
    state: boundarySafeObject(object.state),
    selection:
      object.selection === null || object.selection === undefined
        ? null
        : normalizeSelection(object.selection),
  };
}

export function normalizeDataSurfaceVisibleCommand(value: unknown): unknown {
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
  if (object.version !== 1)
    throw new TypeError('Unsupported DataSurface visible command version');
  const commandId = identifierValue(object.commandId, 'DataSurface command id');
  const normalized = {
    version: 1 as const,
    commandId,
    identity: normalizeIdentity(object.identity),
    expectedRevision: revisionNumber(object.expectedRevision),
    controlId: identifierValue(object.controlId, 'DataSurface control id'),
    ...(object.payload === undefined
      ? {}
      : { payload: boundarySafe(object.payload) }),
  };
  assertRequestByteLimit(value);
  assertRequestByteLimit(normalized);
  return normalized;
}
