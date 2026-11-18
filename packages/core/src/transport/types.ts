/**
 * Transport kernel types (#5158).
 *
 * The one vocabulary every generated transport shares: who is calling
 * ({@link Principal}), what they are doing ({@link OperationDescriptor}), on
 * which model ({@link TransportModel}), and how a transport that has not been
 * moved onto the kernel's contract yet behaves ({@link TransportProfile}).
 *
 * Type-only imports only. The two runtime constants below are what the
 * contract-test matrix enumerates, so a new operation or surface cannot be
 * added without every cell of that matrix being decided.
 *
 * See `agents/transport-kernel.md` for the pipeline order and the profile rule.
 */
import type { SmrtCollection, SmrtListWhereClause } from '../collection.js';
import type { MCPResponse } from '../generators/mcp.js';
import type { McpToolTarget } from '../generators/mcp-tool-name.js';
import type { ToolJsonSchema } from '../generators/tool-schema.js';
import type { PublicJsonOptions, SmrtObject } from '../object.js';
import type {
  RegisteredClass,
  SmrtObjectConstructor,
} from '../registry/types.js';
import type { RuntimeExposureContext } from '../runtime-exposure.js';
import type { SyncApplyHost } from '../sync/apply.js';

// ---------------------------------------------------------------------------
// Surfaces and operations
// ---------------------------------------------------------------------------

/**
 * A family of transports that shares one wire convention.
 *
 * `assistant` is the in-process tool loop of `@happyvertical/smrt-chat`. It is
 * a surface of its own because runtime exposure already treats it as one
 * (`RuntimeExposureContext['surface']`) and its operations are named by the
 * permission catalog (`read`), not by HTTP verbs or MCP tool suffixes.
 */
export type Surface = 'rest' | 'mcp' | 'sync' | 'cli' | 'assistant';

/** The generated operations every surface is measured against. */
export type CrudOperation =
  | 'list'
  | 'get'
  | 'count'
  | 'create'
  | 'update'
  | 'delete';

/** Every {@link CrudOperation}, in pipeline-documentation order. */
export const TRANSPORT_OPERATIONS: readonly CrudOperation[] = Object.freeze([
  'list',
  'get',
  'count',
  'create',
  'update',
  'delete',
]);

/** Every {@link Surface}. */
export const TRANSPORT_SURFACES: readonly Surface[] = Object.freeze([
  'rest',
  'mcp',
  'sync',
  'cli',
  'assistant',
]);

/** The surface name `isRuntimeModelEnabled()` is asked about. */
export type ExposureSurface = RuntimeExposureContext['surface'];

/**
 * Which runtime-exposure surface gates each transport surface. `sync` has no
 * exposure surface of its own: both sync hosts ask about `rest` today.
 */
export const SURFACE_EXPOSURE: Readonly<Record<Surface, ExposureSurface>> =
  Object.freeze({
    rest: 'rest',
    mcp: 'mcp',
    sync: 'rest',
    cli: 'cli',
    assistant: 'assistant',
  });

/** Operations that change stored state. */
export const MUTATING_OPERATIONS: ReadonlySet<CrudOperation> =
  new Set<CrudOperation>(['create', 'update', 'delete']);

/** A custom (non-CRUD) method exposed as an operation. */
export interface CustomActionOperation {
  /** Method name as declared on the model or its collection. */
  readonly action: string;
}

/**
 * The action segment of an operation permission slug. Reads share one slug:
 * the permission catalog publishes `<collection>.read` for list, get and count.
 */
export type PermissionAction = 'read' | 'create' | 'update' | 'delete';

// ---------------------------------------------------------------------------
// Principal
// ---------------------------------------------------------------------------

/**
 * The caller, resolved once per request by the host and never from request
 * bodies, query strings or tool arguments.
 */
export interface Principal {
  /** False for an anonymous caller. A principal with no `userId` can still be authenticated. */
  readonly authenticated: boolean;
  readonly userId?: string;
  /**
   * The tenant the caller acts in. `null` is an authenticated caller with no
   * tenant; `undefined` means the host did not resolve one.
   */
  readonly tenantId?: string | null;
  /**
   * Operation permission slugs (`<collection>.<action>`). `'all'` means the
   * host has already authorised the call (an operator process, or a host that
   * authorises in its own middleware) and the kernel must not re-check slugs.
   */
  readonly permissions: ReadonlySet<string> | 'all';
  /**
   * Permission slugs used for field-level read projection
   * (`@field({ readPermission })`). Kept apart from {@link permissions}
   * because no transport derives the two from the same source today:
   * `'all'` operation authority never implies a field grant, and generated
   * SvelteKit routes read operation slugs from four places but field slugs
   * from three. Empty when the caller holds none.
   */
  readonly fieldPermissions: ReadonlySet<string>;
  /** Operator or super-admin opt-in to act outside a single tenant. */
  readonly allowCrossTenant?: boolean;
}

// ---------------------------------------------------------------------------
// Model identity
// ---------------------------------------------------------------------------

/**
 * One model as the kernel sees it: a strict identity plus the profile that
 * decides which behaviours are still legacy for the calling transport.
 *
 * Deliberately small. Each kernel module derives what it needs from the
 * registry by {@link qualifiedName} and memoises it against {@link generation},
 * so adding a derived fact never edits this interface.
 */
export interface TransportModel {
  /** Registry key. Always qualified (`@scope/pkg:Class`) when the registration has a package. */
  readonly qualifiedName: string;
  /** Simple class name, for messages only. Never used for a lookup. */
  readonly name: string;
  readonly packageName?: string;
  /** Route and sync segment (the manifest `collection`). */
  readonly collection: string;
  /** `<collection>` prefix of operation permission slugs; an STI subtype keeps its base's. */
  readonly permissionCollection: string;
  /** The surface this descriptor was resolved for. */
  readonly surface: Surface;
  /** The registration the identity resolved to. */
  readonly registered: RegisteredClass;
  /** Registry generation the descriptor was built at; a stale descriptor must be re-resolved. */
  readonly generation: number;
  /**
   * Behaviours this transport still performs the legacy way. A section that is
   * present selects the legacy behaviour its data describes; an absent section
   * selects the kernel contract. Empty for a fully migrated transport.
   */
  readonly profile: Partial<TransportProfile>;
}

/** What an authorisation hook is told about the call it is deciding. */
export interface OperationDescriptor {
  /** Qualified model name, always. For a create that names an STI subtype, the subtype. */
  readonly model: string;
  /** Route and sync segment. */
  readonly collection: string;
  readonly surface: Surface;
  readonly operation: CrudOperation | CustomActionOperation;
  /** `<permissionCollection>.<action>`, with `operationPermissions` aliases already resolved. */
  readonly permission: string;
  readonly mutating: boolean;
}

/**
 * Resolves the collection for a qualified model name. Called inside the
 * request, after authorisation: the kernel never caches the result, so a
 * request-scoped database or transaction is honoured. A host may cache.
 */
export type CollectionResolver = (
  qualifiedName: string,
) => Promise<SmrtCollection<SmrtObject>>;

/**
 * A custom response serialiser. May be asynchronous, and receives the caller's
 * projection options because `mcp.serializers.get` already does.
 */
export type TransportSerializer = (
  item: SmrtObject,
  options: PublicJsonOptions,
) => unknown | Promise<unknown>;

/** Host hook consulted after the kernel's own checks pass; throw to refuse. */
export type AuthorizeHook = (
  operation: OperationDescriptor,
  principal: Principal,
) => void | Promise<void>;

/** Everything a transport hands the kernel about one model. */
export interface TransportBinding {
  /** A qualified name or a constructor. An ambiguous simple name throws `CONFIG_AMBIGUOUS_CLASS`. */
  readonly model: string | SmrtObjectConstructor;
  readonly surface: Surface;
  readonly getCollection: CollectionResolver;
  /**
   * Custom serialisers, run inside the tenant gate. Which operations `item`
   * covers is profile data ({@link SerializeProfile.customSerializers}).
   */
  readonly serializers?: {
    readonly item?: TransportSerializer;
    readonly listItem?: TransportSerializer;
  };
  readonly authorize?: AuthorizeHook;
  /** Legacy behaviours to keep. Removed with the last legacy profile. */
  readonly profile?: Partial<TransportProfile>;
}

// ---------------------------------------------------------------------------
// Operation input and result
// ---------------------------------------------------------------------------

/** Untrusted list arguments, exactly as the transport received them. */
export interface ListInput {
  readonly where?: unknown;
  readonly orderBy?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface CountInput {
  readonly where?: unknown;
}

/** A point read. MCP tools accept a slug in place of the id. */
export interface GetInput {
  readonly id?: unknown;
  readonly slug?: unknown;
}

/** `createType` / `_meta_type` selectors are read from `body`. */
export interface CreateInput {
  readonly body: unknown;
  /**
   * A caller-chosen row id from a validated envelope (sync). Never read from
   * `body`, where `id` is always dropped.
   */
  readonly id?: string;
}

export interface UpdateInput {
  readonly id: unknown;
  readonly body: unknown;
}

export interface DeleteInput {
  readonly id: unknown;
}

export interface OperationInputMap {
  list: ListInput;
  get: GetInput;
  count: CountInput;
  create: CreateInput;
  update: UpdateInput;
  delete: DeleteInput;
}

export type OperationInput<Op extends CrudOperation = CrudOperation> =
  OperationInputMap[Op];

/**
 * Per-request facts that are not about the caller's identity. Runtime exposure
 * gates may read `request` and `locals`, so the kernel has to pass them on.
 */
export interface OperationContext {
  readonly request?: Request;
  readonly locals?: unknown;
}

/** A validated list query, ready for `collection.list()` / `collection.count()`. */
export interface ListQuery {
  /** AND-only record or bounded DNF (`Record[][]`, outer OR, inner AND). */
  readonly where?: SmrtListWhereClause<SmrtObject>;
  /** Absent when the transport applies no ordering. */
  readonly orderBy?: string | readonly string[];
  readonly limit: number;
  readonly offset: number;
}

/** One field a caller may write through a generated transport. */
export interface WritableField {
  readonly name: string;
  /** Why it is writable; lets schema emitters and tests explain a field's presence. */
  readonly source: 'field' | 'meta' | 'write-through' | 'input' | 'system';
  /** Operations the field is accepted on. `slug` and `context` are create-only. */
  readonly operations: readonly ('create' | 'update')[];
}

/** The tenant decision a gate hands to the code it wraps. */
export interface TenantScope {
  /** `tenant`: inside one tenant. `global`: global rows only. `system`: cross-tenant. `none`: not tenant-scoped or tenancy off. */
  readonly kind: 'tenant' | 'global' | 'system' | 'none';
  readonly tenantId?: string | null;
  /** Predicate the caller must AND into reads when `kind` is `global`. */
  readonly readPredicate?: Readonly<Record<string, null>>;
}

/**
 * Transport-neutral result. Adapters render it: `{ items, count, limit,
 * offset }`, a bare array, or MCP's `{ data, meta }` all come from `list`.
 * Values are already public projections.
 */
export type OperationResult =
  | {
      readonly operation: 'list';
      readonly items: readonly unknown[];
      /** Absent when the profile runs no count query for a list. */
      readonly total?: number;
      readonly limit: number;
      readonly offset: number;
    }
  | { readonly operation: 'count'; readonly count: number }
  | {
      readonly operation: 'get' | 'create' | 'update';
      readonly item: unknown;
    }
  | { readonly operation: 'delete'; readonly id: string };

/** A failure as every surface reports it. */
export interface TransportErrorBody {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  /** Server-created reference for an opaque failure. */
  readonly requestId?: string;
}

/** What the error path may know about the failed call. */
export interface TransportErrorContext {
  /** For the server-side log entry of an opaque failure (method and path only). */
  readonly request?: Request;
  /** Selects the anonymous status where the contract has one. */
  readonly principal?: Principal;
  /** Legacy rendering to keep; absent selects the error contract. */
  readonly profile?: Pick<Partial<TransportProfile>, 'errors' | 'body'>;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/** The request facts an HTTP adapter needs, satisfied by a SvelteKit event. */
export interface HttpRequestEvent {
  readonly request: Request;
  readonly url?: URL;
  readonly params?: Readonly<Record<string, string | undefined>>;
  readonly locals?: unknown;
}

export type Handler = (event: HttpRequestEvent) => Promise<Response>;

export interface HttpBinding extends TransportBinding {
  readonly surface: 'rest';
  /** Resolve the caller, or answer the request directly (a redirect, a 401). */
  resolvePrincipal(
    event: HttpRequestEvent,
  ): Principal | Response | Promise<Principal | Response>;
}

/** Handlers by route file. `count` exists because runtime REST serves `GET /<collection>/count`. */
export interface HttpHandlers {
  readonly collection: Readonly<Record<'GET' | 'POST', Handler>>;
  readonly item: Readonly<Record<'GET' | 'PUT' | 'PATCH' | 'DELETE', Handler>>;
  readonly count: Readonly<Record<'GET', Handler>>;
}

/** The static tool catalogue entry an MCP runtime dispatches on. */
export interface McpToolDefinition {
  readonly name: string;
  readonly inputSchema: ToolJsonSchema;
}

export interface McpRuntimeOptions {
  readonly tools: readonly McpToolDefinition[];
  /** Tool name to execution identity; `registryKey` wins over `objectName`. */
  readonly targets: Readonly<Record<string, McpToolTarget>>;
  readonly getCollection: CollectionResolver;
  /** Used when a call supplies no principal (a stdio server has one for its lifetime). */
  readonly principal?: Principal;
  /** `mcp.serializers.get` by tool name. */
  readonly getSerializers?: Readonly<Record<string, TransportSerializer>>;
  readonly authorize?: AuthorizeHook;
  readonly profile?: Partial<TransportProfile>;
}

export interface McpToolRuntime {
  handleToolCall(
    name: string,
    args: unknown,
    principal?: Principal,
  ): Promise<MCPResponse>;
}

export interface SyncApplyHostOptions {
  /** `null` for a segment that is unknown or not exposed. */
  resolveSegment(
    segment: string,
  ): TransportBinding | null | Promise<TransportBinding | null>;
  readonly principal: Principal;
  readonly context?: OperationContext;
}

export type { SyncApplyHost };

// ---------------------------------------------------------------------------
// Legacy profiles
// ---------------------------------------------------------------------------

/** The transports that exist today, each with its own legacy profile. */
export type LegacyTransportId =
  | 'rest-runtime'
  | 'sveltekit-emitted'
  | 'mcp-inprocess'
  | 'mcp-emitted-single'
  | 'mcp-emitted-modular'
  | 'sync-runtime'
  | 'sync-emitted'
  | 'cli'
  | 'chat-tool-loop';

/** How one generated operation is reachable on a transport. */
export type OperationAvailability =
  /** Served; the string names the verb, tool suffix or command. */
  | { readonly served: true; readonly as: string }
  /** Not served; the reason is what the contract matrix reports. */
  | { readonly served: false; readonly reason: string };

/** Behaviour 1a: which request keys reach the model. */
export interface WriteProfile {
  /** Keys always dropped. The same seven names on every transport. */
  readonly serverManagedKeys: readonly string[];
  /** Keys starting with `_` are dropped everywhere. */
  readonly underscorePrefixedKeys: 'dropped';
  /**
   * Where `@field({ readonly })` names come from. `registry` is
   * `ObjectRegistry.getFields(key)` at request time; `manifest` is the list
   * baked at build; `manifest-or-registry-for-subtype` is `manifest` except for
   * a create that names another STI type, which reads that type from the
   * registry.
   */
  readonly readonlyFields:
    | 'registry'
    | 'manifest'
    | 'manifest-or-registry-for-subtype';
  /**
   * Generated (database-computed) fields. `dropped-except-subtype-create`
   * drops them wherever the baked manifest list is used. `passed-through`
   * leaves them for the model to refuse (a create throws
   * `VALIDATION_GENERATED_FIELD_WRITE`).
   */
  readonly generatedFields: 'dropped-except-subtype-create' | 'passed-through';
  /** `displayLabel` on a model that declares a display-label projection. */
  readonly displayLabelKey: 'dropped-when-projected' | 'passed-through';
  /** The allowlist consulted. Every transport reads `api.writable`, whatever its surface. */
  readonly allowlist: 'api.writable';
  /** Keys the transport sets itself, from the caller's user id, after filtering. */
  readonly serverSetKeys: {
    readonly create: readonly string[];
    readonly update: readonly string[];
  };
  /**
   * What the filter does with an array where a record is expected. A create
   * body first passes `ObjectRegistry.resolveCreateTarget()`, which turns any
   * non-record into `{}`, so this is observable on update only.
   */
  readonly arrayBody: 'index-keys-kept' | 'empty-object' | 'refused';
  /** How filtered values reach an existing instance. */
  readonly assign: 'object-assign';
  readonly updateSeam: 'withAuditMutation' | 'instance-save';
  /**
   * `collection-delete-after-get`: `get(id)` then `collection.delete(id)`.
   * `audited-guarded-instance-delete`: `withAuditMutation` around
   * `delete({ expectedUpdatedAt })`. `instance-delete`: `item.delete()`.
   */
  readonly deleteSeam:
    | 'collection-delete-after-get'
    | 'audited-guarded-instance-delete'
    | 'instance-delete';
}

/** Behaviour 1b: how a row becomes a response. */
export interface SerializeProfile {
  /**
   * `toPublicJSON-if-present` returns the raw value when it has no
   * `toPublicJSON` function. `public-walk` recurses through arrays and plain
   * objects, projecting every value that has one. `toJSON` is
   * `JSON.stringify(row)`.
   */
  readonly item:
    | 'toPublicJSON'
    | 'toPublicJSON-if-present'
    | 'public-walk'
    | 'toJSON'
    | 'toPublicJSON-else-toJSON'
    | 'not-returned';
  /** Where field read permissions come from. */
  readonly fieldPermissions:
    | 'construction-context'
    | 'locals-first-present'
    | 'environment'
    | 'principal-run'
    | 'none';
  readonly customSerializers:
    | { readonly config: 'none' }
    | {
        readonly config: 'api.serializers';
        readonly item: readonly ('get' | 'create' | 'update')[];
        readonly listItem: readonly ['list'];
        /** Result passes field-name redaction of read-permission fields. */
        readonly resultProjection: 'read-permission-redaction';
      }
    | {
        readonly config: 'mcp.serializers.get';
        readonly item: readonly ['get'];
        readonly resultProjection: 'public-walk' | 'as-returned';
      };
}

/** Behaviour 2: what a create does when the natural key already exists. */
export interface CreateProfile {
  /**
   * `adopt`: `collection.create()`; an explicit natural key adopts the
   * same-owner row and updates it, a derived slug renumbers. Audited models
   * are insert-only either way. `insert-only`: `_insertOnly: true`.
   */
  readonly conflict: 'adopt' | 'insert-only';
  /** Framework options the transport adds to the create input. */
  readonly frameworkOptions: readonly ('_skipLoad' | '_insertOnly')[];
  /** `envelope`: the validated sync item id. `generated`: never caller-supplied. */
  readonly id: 'generated' | 'envelope';
  /** The tool loop saves the created row a second time. */
  readonly savesAfterCreate: boolean;
}

/** Behaviour 3: filter, sort, page and count. */
export interface QueryProfile {
  /** `none`: the transport has no list or count. */
  readonly where:
    | 'rest-bracket-query'
    | 'passed-through'
    | 'json-option'
    | 'record-only'
    | 'none';
  /** Whether a DNF array (`Record[][]`) can reach the collection. */
  readonly dnf: boolean;
  /**
   * Which rules decide that a key may be filtered on. `collection-rules`: the
   * collection's own key validation, the same for every caller.
   */
  readonly filterFieldAccess: 'collection-rules';
  /**
   * `shared-parser`: `resolveListLimit`/`resolveListOffset` (typed 400).
   * `inline-parser`: the same rule re-implemented in the emitted file.
   * `unvalidated-default-50`: `?? 50`, any value reaches the collection.
   * `parse-int`: `Number.parseInt` of a string option (default `'50'`).
   * `validated-integer-default-50`: refused unless an integer of at least the
   * minimum, 50 when absent, and no ceiling applied by the transport.
   */
  readonly bounds:
    | 'shared-parser'
    | 'inline-parser'
    | 'unvalidated-default-50'
    | 'parse-int'
    | 'validated-integer-default-50'
    | 'none';
  /** `caller-or-default` falls back to `created_at DESC` plus the primary key. */
  readonly orderBy: 'caller-or-default' | 'caller-only' | 'never' | 'none';
  /**
   * `route`: a separate `GET /count`. `with-list`: a count query on every
   * list, same `where`. `none`: no total anywhere.
   */
  readonly count: 'route' | 'with-list' | 'none';
  /** Whether list and get ask the collection for `displayLabel`. */
  readonly displayLabel: 'when-projected' | 'always' | 'never';
}

/** Behaviour 4: tenant context. */
export interface TenantProfile {
  /**
   * `read-predicate`: no context is established; reads of a tenant-scoped
   * model add `tenantId: null` when tenancy is enforced with no active tenant.
   * `sticky-context`: `enterTenantContext()` for the rest of the request.
   * `gate`: `runWithTenantGate()` / `runTenantScopedEntryPoint()` around the
   * operation. `principal-context`: the whole turn runs in
   * `executeAsPrincipal()`. `none`: nothing.
   */
  readonly mechanism:
    | 'read-predicate'
    | 'sticky-context'
    | 'gate'
    | 'principal-context'
    | 'none';
  readonly operations: 'reads' | 'all' | 'none';
  /** What decides that a model is tenant-scoped. */
  readonly scopedWhen:
    | 'registry-config-or-tenancy-resolver'
    | 'manifest-decorator-config'
    | 'manifest-any-target-scoped'
    | 'tenancy-by-class-name'
    | 'baked-lowercase-simple-name'
    | 'not-consulted';
  /** Where the tenant id comes from. */
  readonly tenantSource:
    | 'ambient-dispatch-scope'
    | 'locals'
    | 'locals-without-tenant-context'
    | 'construction-context'
    | 'environment'
    | 'principal-run'
    | 'none';
  /** A context already active for another tenant or user. */
  readonly activeContextMismatch: 'refused-403' | 'kept-silently' | 'n/a';
  /**
   * Model opt-in (`api.principalContext`) that requires tenant, user and
   * permissions on `locals` (403 otherwise) and publishes all three.
   */
  readonly principalContext?: 'api.principalContext';
  /**
   * A caller-supplied filter on the tenant column when the global-rows
   * predicate applies. `stripped`: `tenantId`/`tenant_id` keys with any
   * operator are removed. `overridden-exact-key`: only the exact `tenantId`
   * key is replaced.
   */
  readonly callerTenantFilter: 'stripped' | 'overridden-exact-key' | 'n/a';
  /**
   * A tenant-scoped call with no tenant and no cross-tenant opt-in.
   * `global-rows-on-read` leaves writes to the tenancy interceptor.
   */
  readonly noTenant:
    | 'global-rows-on-read'
    | 'refused-by-runner'
    | 'interceptor-decides';
}

/** Behaviour 5: what a caller sees when something throws. */
export interface ErrorProfile {
  /**
   * `typed-4xx-else-opaque-500`: `normalizeTypedHttpError()` (any integer 4xx
   * `status`), else `reportUnexpectedHttpError()`. `message-shown`: the
   * error's message is returned whatever it is. `per-item-reason`: a sync item
   * becomes `rejected`/`write_failed` with no detail.
   * `classified-observation`: the tool loop's `not_permitted` /
   * `invalid_request` / `execution_error`.
   */
  readonly render:
    | 'typed-4xx-else-opaque-500'
    | 'message-shown'
    | 'per-item-reason'
    | 'classified-observation';
  /** Which operations run inside the transport's own catch. */
  readonly guarded: 'all' | 'writes-only';
  /** Wire shape of a failure the transport renders from a thrown error. */
  readonly shape:
    | 'error-object-with-ok-false'
    | 'mcp-is-error'
    | 'sync-item'
    | 'observation'
    | 'stderr-exit-1';
  /** Wire shape of the transport's own refusals (not found, not allowed). */
  readonly refusalShape:
    | 'error-string'
    | 'kit-error'
    | 'thrown-message'
    | 'sync-item'
    | 'observation'
    | 'stderr-exit-1';
  /** Prefix put in front of the message in MCP text content. */
  readonly textPrefix?: 'Error: ' | 'Error executing tool <name>: ';
  /** When the thrown error's own message reaches the caller. */
  readonly messageVisible: 'typed-4xx-only' | 'always' | 'never';
  /**
   * When a machine code reaches the caller. `typed-4xx-only` falls back to
   * `permission_denied` (403) or `request_rejected`. `code-with-publicMessage`
   * needs both properties on the error.
   */
  readonly codeVisible:
    | 'typed-4xx-only'
    | 'code-with-publicMessage'
    | 'string-code'
    | 'never';
  /** Error classes shown as `{ code, message }` without a `publicMessage`. */
  readonly alsoPublic?: readonly 'GeneratedFieldError'[];
}

/** Behaviour 6: may this caller do this. */
export interface AuthorizationProfile {
  /**
   * `host-middleware`: `authMiddleware(objectName, verb)`; without one,
   * `api.public` decides and everything else is 401. `locals-principal`: an
   * object-shaped `locals.user`/`locals.session` or `smrtAuth === true`.
   * `context-user`: `context.user` exists. `process`: the launching process is
   * the trust boundary, as the emitted server's header states. `principal-run`: allow-list plus catalog permission.
   */
  readonly authentication:
    | 'host-middleware'
    | 'locals-principal'
    | 'context-user'
    | 'process'
    | 'principal-run';
  /** What the middleware is told the action is. */
  readonly middlewareAction?: 'lowercase-http-method' | 'sync-op-as-verb';
  /** `mutations`: `<permissionCollection>.<action>` on create/update/delete only. */
  readonly operationPermission: 'none' | 'mutations' | 'all';
  /** Skips the operation permission check. */
  readonly permissionBypass: readonly (
    | 'api.public-true'
    | 'tenantContext.superAdminBypass'
  )[];
  /** `api.public` is honoured by every transport that authenticates, MCP included. */
  readonly publicAccess: 'api.public' | 'api.public-true-only' | 'ignored';
  /** Order of the exposure check, authentication and the per-action gate. */
  readonly order: readonly (
    | 'exposure'
    | 'authenticate'
    | 'custom-action-dispatch'
    | 'action-enabled'
    | 'permission'
    | 'tool-catalogue'
    | 'allow-list'
  )[];
  /** Which config decides that an operation is enabled. */
  readonly actionEnabledBy:
    | 'api.include-exclude'
    | 'mcp-tool-catalogue'
    | 'cli.include-exclude'
    | 'permission-catalog';
  /** Custom actions that count as mutating. */
  readonly customActionMutating: 'non-get-method' | 'always' | 'n/a';
  /**
   * Task creation is an entry point of its own, beside the tool-call path;
   * the tenant id is handed to the task store.
   */
  readonly taskAdmission?: 'separate-entry-point';
}

/** Behaviour 7: which registration a request resolves to. */
export interface LookupProfile {
  /**
   * `simple-name`: the registration's simple name, resolved through the
   * registry's simple-name lookup. `registry-key`: the qualified key. `registry-key-or-simple-name`: qualified for a registered
   * collection, simple for auto-discovery.
   */
  readonly policyName:
    | 'simple-name'
    | 'registry-key'
    | 'registry-key-or-simple-name';
  /** How a URL or sync segment finds its class. */
  readonly segment:
    | 'first-registry-match'
    | 'baked-manifest-key'
    | 'baked-tool-target'
    | 'first-simple-name-match'
    | 'catalog-qualified-name';
  /**
   * How the collection instance is obtained. `registered-instance-else-registry`:
   * an instance the host registered for the segment, else
   * `ObjectRegistry.getCollection(qualifiedName)`. `registry`: always
   * `ObjectRegistry.getCollection(registryKey)`. `declared-constructor-else-registry`:
   * `new collectionConstructor()` when the model declares a collection class,
   * cached for the generator's lifetime. `declared-constructor-by-simple-name`:
   * the same, found through `ObjectRegistry.getClass(simpleName)`, and an
   * error when the model declares none.
   */
  readonly collection:
    | 'registered-instance-else-registry'
    | 'registry'
    | 'declared-constructor-else-registry'
    | 'declared-constructor-by-simple-name';
}

/** Behaviour 8: creating an STI subtype through the base collection. */
export interface StiProfile {
  /** `none`: `_meta_type` is dropped with every `_` key and no selector is read. */
  readonly createType: 'resolveCreateTarget' | 'none';
  readonly exposureSurface: ExposureSurface;
  /** Which model the transport's own checks are evaluated against once a subtype is chosen. */
  readonly policySubject: {
    readonly writablePolicy: 'subtype' | 'base';
    readonly authentication: 'subtype' | 'base' | 'n/a';
    readonly tenant: 'subtype' | 'base' | 'n/a';
  };
}

/** Behaviour 9: how identifiers are validated before they reach the collection. */
export interface ArgumentProfile {
  /**
   * `url-segment`: always a string. `truthiness`: any truthy value is passed
   * to `collection.get()`, which treats a non-string as a filter.
   * `string-typed`: refused unless a non-empty string. `uuid-envelope`: the
   * sync envelope pattern. `cli-argument`: an argv string.
   */
  readonly id:
    | 'url-segment'
    | 'truthiness'
    | 'string-typed'
    | 'uuid-envelope'
    | 'cli-argument';
  /** Whether `get` accepts a slug in place of the id. */
  readonly getBySlug: 'argument' | 'same-argument' | 'no';
  /** Whether tool arguments are checked against the advertised schema. */
  readonly schemaValidation:
    | 'none'
    | 'read-arguments-only'
    | 'envelope'
    | 'n/a';
}

/** Behaviour 10: response shapes. */
export interface ResultProfile {
  readonly list:
    | 'bare-array'
    | 'items-count-limit-offset'
    | 'data-meta'
    | 'data-meta-with-array-text'
    | 'printed'
    | 'n/a';
  readonly create: 'item-201' | 'item' | 'printed' | 'sync-item';
  /** A miss on get. */
  readonly notFound:
    | '404'
    | 'thrown-message'
    | 'found-false'
    | 'exit-1'
    | 'n/a';
  readonly delete:
    | '204-empty'
    | '200-success-true'
    | 'success-message'
    | 'success-id'
    | 'printed'
    | 'sync-item';
  /** A delete of a row that does not exist. */
  readonly deleteMissing:
    | '404'
    | 'thrown-message'
    | 'found-false'
    | 'exit-1'
    | 'applied';
  /** HTTP methods that update. */
  readonly updateMethods?: readonly ('PUT' | 'PATCH')[];
}

/** Behaviour 11: reading the request body. */
export interface BodyProfile {
  /** `sdk`: the MCP SDK or the model provider parses. `file-or-flags`: CLI. */
  readonly source: 'request-json' | 'buffered-text' | 'sdk' | 'file-or-flags';
  readonly limit: 'unbounded' | 'batch-size-only' | 'n/a';
  /** Whether the body is read before the caller is authenticated. */
  readonly readBeforeAuth: boolean;
  /** A body that is not valid JSON. */
  readonly malformed:
    | 'opaque-500'
    | 'framework-500'
    | '400-error-string'
    | '400-invalid-batch'
    | 'invalid-request-observation'
    | 'thrown-message'
    | 'n/a';
}

/**
 * How one transport behaves today for each of the eleven behaviours the kernel
 * takes over. Pure data: a legacy profile is the difference between that
 * transport and the kernel contract, written down so a migration onto the
 * kernel can be checked to change nothing.
 */
export interface TransportProfile {
  readonly transport: LegacyTransportId;
  readonly surface: Surface;
  readonly operations: Readonly<Record<CrudOperation, OperationAvailability>>;
  readonly write: WriteProfile;
  readonly serialize: SerializeProfile;
  readonly create: CreateProfile;
  readonly query: QueryProfile;
  readonly tenant: TenantProfile;
  readonly errors: ErrorProfile;
  readonly authorization: AuthorizationProfile;
  readonly lookup: LookupProfile;
  readonly sti: StiProfile;
  readonly arguments: ArgumentProfile;
  readonly results: ResultProfile;
  readonly body: BodyProfile;
}

/** The profile sections that carry a behaviour, i.e. everything but identity. */
export type TransportProfileSection = Exclude<
  keyof TransportProfile,
  'transport' | 'surface'
>;
