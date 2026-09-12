/**
 * Transport-neutral data-surface contracts.
 *
 * These declarations describe bounded browser/server action envelopes and
 * mounted-surface metadata. They carry neither authority nor execution:
 * authenticated adapters own both.
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

/** Presentation tier emitted by policy-aware domain adapters. */
export type DataSurfaceColumnVisibility = 'basic' | 'advanced' | 'hidden';

/** A domain-neutral column role. Adapters use roles to protect structural columns. */
export type DataSurfaceColumnRole =
  | 'data'
  | 'status'
  | 'computed'
  | 'row-key'
  | 'selection'
  | 'action';

/** Operator allowlists are intentionally strings: #2444 owns query semantics. */
export interface DataSurfaceColumnOperators {
  search?: string[];
  filter?: string[];
  sort?: string[];
}

export interface DataSurfaceColumnDescriptor {
  id: string;
  label: string;
  description?: string;
  sensitivity?: DataSurfaceSensitivity;
  capabilities: DataSurfaceColumnCapability[];
  /** Domain field identity; never accepted as a request path. */
  fieldName?: string;
  /** Effective policy visibility, when a domain adapter supplies one. */
  visibility?: DataSurfaceColumnVisibility;
  /** Stable policy order; domain column ids remain unchanged. */
  order?: number;
  /** Structural columns are preserved even when field policy narrows data columns. */
  role?: DataSurfaceColumnRole;
  /** Responsive adapters consume this without importing DataTable types. */
  responsivePriority?: number;
  /** Per-operation operator allowlists, narrowed by policy adapters. */
  operators?: DataSurfaceColumnOperators;
  /** Explicit aliases for adapters that mirror the canonical query schema. */
  searchOperators?: string[];
  filterOperators?: string[];
  sortOperators?: string[];
  /** Explicit readability is useful when read capability is policy-gated. */
  readable?: boolean;
}

/** #2444 owns the canonical query language; this declares only its bounds. */
export type DataSurfaceQueryMode = 'rows' | 'count' | 'facets';

export interface DataSurfaceQueryCapabilities {
  modes: DataSurfaceQueryMode[];
  /** Explicit allowlist; field paths are not accepted in requests. */
  projectableColumnIds: string[];
  /** Explicit allowlists for non-projection query operations. */
  searchableColumnIds?: string[];
  filterableColumnIds?: string[];
  sortableColumnIds?: string[];
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
  /** Optional column dependencies used by field-policy adapters. */
  columnIds?: string[];
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

interface DataSurfaceQueryResultBase {
  version: 1;
  requestId: string;
  identity: DataSurfaceIdentity;
  revision: number;
}

/** Bounded read result shapes; #2444 owns their canonical query semantics. */
export type DataSurfaceQueryResult =
  | (DataSurfaceQueryResultBase & {
      kind: 'rows';
      rowKey: string;
      rows: DataSurfaceJsonObject[];
      hasMore: boolean;
      truncated: boolean;
      nextCursor?: string;
    })
  | (DataSurfaceQueryResultBase & {
      kind: 'count';
      count: number;
    })
  | (DataSurfaceQueryResultBase & {
      kind: 'facets';
      columnId: string;
      facets: Array<{ value: DataSurfaceJsonPrimitive; count: number }>;
      truncated: boolean;
    });

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

/**
 * Canonical wire request for principal-bound server adapters. A preview can
 * omit the idempotency key; apply requires it at the server boundary.
 */
export interface DataSurfaceActionWireRequest extends DataSurfaceActionRequest {
  expectedRevision: number;
  idempotencyKey?: string;
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

/** Serializable outcome for one server-resolved row in an action. */
export interface DataSurfaceActionRowOutcome {
  rowId: DataSurfaceRowId;
  status: 'accepted' | 'skipped' | 'failed';
  reason?: string;
  metadata?: DataSurfaceJsonObject;
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
