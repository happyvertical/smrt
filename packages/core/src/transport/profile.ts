/**
 * Legacy transport profiles (#5158).
 *
 * Each table below records, as data, how every generated transport behaves
 * today for one of the eleven behaviours the kernel takes over. A transport
 * moves onto the kernel carrying its profile, so the move changes nothing; a
 * later contract change then deletes one table here and the branch that read
 * it, in one place.
 *
 * The tables are grouped by behaviour, not by transport, so two contract
 * changes never edit the same lines. Every cell was read off the transport
 * source named beside it; `__tests__/profile-source-pins.test.ts` fails when
 * that source changes, which is the prompt to re-verify the cell.
 *
 * Nothing in the codebase reads these yet.
 */
import type {
  ArgumentProfile,
  AuthorizationProfile,
  BodyProfile,
  CreateProfile,
  CrudOperation,
  ErrorProfile,
  LegacyTransportId,
  LookupProfile,
  OperationAvailability,
  QueryProfile,
  ResultProfile,
  SerializeProfile,
  StiProfile,
  Surface,
  TenantProfile,
  TransportProfile,
  WriteProfile,
} from './types.js';

/** Every legacy transport, in inventory order. */
export const LEGACY_TRANSPORTS: readonly LegacyTransportId[] = Object.freeze([
  'rest-runtime',
  'sveltekit-emitted',
  'mcp-inprocess',
  'mcp-emitted-single',
  'mcp-emitted-modular',
  'sync-runtime',
  'sync-emitted',
  'cli',
  'chat-tool-loop',
]);

type ByTransport<T> = Readonly<Record<LegacyTransportId, T>>;

/**
 * Where each transport lives. Paths are relative to `packages/`.
 *
 * - `rest-runtime`: `APIGenerator` request handling.
 * - `sveltekit-emitted`: the `+server.ts` files the Vite plugin writes.
 * - `mcp-inprocess`: `MCPGenerator.handleToolCall()`.
 * - `mcp-emitted-single`: the one-file stdio server template.
 * - `mcp-emitted-modular`: the `handlers/` module of the modular stdio server.
 * - `sync-runtime`: `APIGenerator.resolveSyncApplyTarget()` as a sync host.
 * - `sync-emitted`: the `sync/apply/+server.ts` route.
 * - `cli`: the `smrt <object>:<action>` commands.
 * - `chat-tool-loop`: `invokeManifestTool()`.
 */
export const LEGACY_TRANSPORT_SOURCES: ByTransport<{
  readonly surface: Surface;
  readonly source: string;
}> = Object.freeze({
  'rest-runtime': { surface: 'rest', source: 'core/src/generators/rest.ts' },
  'sveltekit-emitted': {
    surface: 'rest',
    source: 'core/src/vite-plugin/sveltekit-generator.ts',
  },
  'mcp-inprocess': { surface: 'mcp', source: 'core/src/generators/mcp.ts' },
  'mcp-emitted-single': {
    surface: 'mcp',
    source: 'core/src/generators/mcp-runtime-template.ts',
  },
  'mcp-emitted-modular': {
    surface: 'mcp',
    source: 'core/src/generators/mcp.ts',
  },
  'sync-runtime': { surface: 'sync', source: 'core/src/generators/rest.ts' },
  'sync-emitted': {
    surface: 'sync',
    source: 'core/src/vite-plugin/sync-apply-route.ts',
  },
  cli: { surface: 'cli', source: 'cli/src/cli-generator.ts' },
  'chat-tool-loop': {
    surface: 'assistant',
    source: 'chat/src/tool-loop.ts',
  },
});

/**
 * The seven keys every write filter drops. Identical in all nine copies of
 * the filter; camelCase and snake_case forms are listed separately because
 * each copy compares raw key text.
 */
export const LEGACY_SERVER_MANAGED_KEYS: readonly string[] = Object.freeze([
  'id',
  'tenantId',
  'tenant_id',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
]);

const served = (as: string): OperationAvailability => ({ served: true, as });
const notServed = (reason: string): OperationAvailability => ({
  served: false,
  reason,
});

type Operations = Readonly<Record<CrudOperation, OperationAvailability>>;

const MCP_OPERATIONS: Operations = {
  list: served('<object>_list'),
  get: served('<object>_get'),
  count: notServed('the list result carries meta.total'),
  create: served('<object>_create'),
  update: served('<object>_update'),
  delete: served('<object>_delete'),
};

const SYNC_OPERATIONS: Operations = {
  list: notServed('sync/apply is a write contract'),
  get: notServed('sync/apply is a write contract'),
  count: notServed('sync/apply is a write contract'),
  create: served("item op 'create' in POST /sync/apply"),
  update: served("item op 'update' in POST /sync/apply"),
  delete: served("item op 'delete' in POST /sync/apply"),
};

/** How each generated operation is reached. */
export const LEGACY_OPERATIONS: ByTransport<Operations> = {
  'rest-runtime': {
    list: served('GET /<collection>'),
    get: served('GET /<collection>/:id'),
    count: served('GET /<collection>/count'),
    create: served('POST /<collection>'),
    update: served('PUT or PATCH /<collection>/:id'),
    delete: served('DELETE /<collection>/:id'),
  },
  'sveltekit-emitted': {
    list: served('GET /<collection>'),
    get: served('GET /<collection>/[id]'),
    count: notServed('the list envelope carries the count'),
    create: served('POST /<collection>'),
    update: served('PUT /<collection>/[id]'),
    delete: served('DELETE /<collection>/[id]'),
  },
  'mcp-inprocess': MCP_OPERATIONS,
  'mcp-emitted-single': MCP_OPERATIONS,
  'mcp-emitted-modular': MCP_OPERATIONS,
  'sync-runtime': SYNC_OPERATIONS,
  'sync-emitted': SYNC_OPERATIONS,
  cli: {
    list: served('<object>:list'),
    get: served('<object>:get <id>'),
    count: notServed('no count command'),
    create: served('<object>:create'),
    update: served('<object>:update <id>'),
    delete: served('<object>:delete <id>'),
  },
  'chat-tool-loop': {
    list: served('<collection>.read without id'),
    get: served('<collection>.read with id'),
    count: notServed('no count operation in the permission catalog'),
    create: served('<collection>.create'),
    update: served('<collection>.update'),
    delete: served('<collection>.delete'),
  },
};

// ---------------------------------------------------------------------------
// 1a. Write filter
// ---------------------------------------------------------------------------

const REGISTRY_WRITE: WriteProfile = {
  serverManagedKeys: LEGACY_SERVER_MANAGED_KEYS,
  underscorePrefixedKeys: 'dropped',
  readonlyFields: 'registry',
  generatedFields: 'passed-through',
  displayLabelKey: 'passed-through',
  allowlist: 'api.writable',
  serverSetKeys: { create: [], update: [] },
  arrayBody: 'index-keys-kept',
  assign: 'object-assign',
  updateSeam: 'withAuditMutation',
  deleteSeam: 'collection-delete-after-get',
};

export const LEGACY_WRITE: ByTransport<WriteProfile> = {
  // rest.ts `applyWritablePolicy`: also drops `displayLabel` when
  // `display.label` is an object.
  'rest-runtime': {
    ...REGISTRY_WRITE,
    displayLabelKey: 'dropped-when-projected',
  },
  // sveltekit-generator.ts `generateWritablePolicyHelper`: `READONLY_FIELDS`
  // is baked from the manifest and includes generated fields; the
  // `dynamicTarget` branch re-reads the registry for another STI type and
  // does not know about generated fields.
  'sveltekit-emitted': {
    ...REGISTRY_WRITE,
    readonlyFields: 'manifest-or-registry-for-subtype',
    generatedFields: 'dropped-except-subtype-create',
    displayLabelKey: 'dropped-when-projected',
  },
  // mcp.ts `runAction`: the only transport that sets ownership keys.
  'mcp-inprocess': {
    ...REGISTRY_WRITE,
    serverSetKeys: {
      create: ['created_by', 'owner_id'],
      update: ['updated_by'],
    },
  },
  'mcp-emitted-single': REGISTRY_WRITE,
  'mcp-emitted-modular': REGISTRY_WRITE,
  // rest.ts `resolveSyncApplyTarget`: `prepare` is the REST filter, so the
  // `displayLabel` rule comes with it. The envelope refuses a non-record
  // payload before the filter runs.
  'sync-runtime': {
    ...REGISTRY_WRITE,
    displayLabelKey: 'dropped-when-projected',
    arrayBody: 'refused',
    deleteSeam: 'audited-guarded-instance-delete',
  },
  // sync-apply-route.ts: a local mirror of the readonly collector that knows
  // neither generated fields nor `displayLabel`.
  'sync-emitted': {
    ...REGISTRY_WRITE,
    readonlyFields: 'manifest',
    arrayBody: 'refused',
    deleteSeam: 'audited-guarded-instance-delete',
  },
  // cli-generator.ts `applyWritablePolicy`: the one copy that refuses arrays.
  cli: { ...REGISTRY_WRITE, arrayBody: 'empty-object' },
  // tool-loop.ts: `applySyncWritablePolicy` with a registry-read readonly
  // list; update and delete are instance calls.
  'chat-tool-loop': {
    ...REGISTRY_WRITE,
    arrayBody: 'refused',
    updateSeam: 'instance-save',
    deleteSeam: 'instance-delete',
  },
};

// ---------------------------------------------------------------------------
// 1b. Serialisation
// ---------------------------------------------------------------------------

const NO_ROW_BODY: SerializeProfile = {
  item: 'not-returned',
  fieldPermissions: 'none',
  customSerializers: { config: 'none' },
};

const EMITTED_MCP_SERIALIZE: SerializeProfile = {
  item: 'toPublicJSON',
  fieldPermissions: 'environment',
  customSerializers: {
    config: 'mcp.serializers.get',
    item: ['get'],
    resultProjection: 'public-walk',
  },
};

export const LEGACY_SERIALIZE: ByTransport<SerializeProfile> = {
  // rest.ts `toPublicData`: duck-typed; ignores `api.serializers`.
  'rest-runtime': {
    item: 'toPublicJSON-if-present',
    fieldPermissions: 'construction-context',
    customSerializers: { config: 'none' },
  },
  // `getPublicJsonOptions(locals)` takes the first of `permissions`,
  // `permissionSet`, `smrtPermissions`; `tenantContext.permissions` is not a
  // source for field reads.
  'sveltekit-emitted': {
    item: 'toPublicJSON',
    fieldPermissions: 'locals-first-present',
    customSerializers: {
      config: 'api.serializers',
      item: ['get', 'create', 'update'],
      listItem: ['list'],
      resultProjection: 'read-permission-redaction',
    },
  },
  'mcp-inprocess': {
    item: 'public-walk',
    fieldPermissions: 'construction-context',
    customSerializers: {
      config: 'mcp.serializers.get',
      item: ['get'],
      resultProjection: 'public-walk',
    },
  },
  // `SMRT_MCP_PERMISSIONS`, comma separated.
  'mcp-emitted-single': EMITTED_MCP_SERIALIZE,
  'mcp-emitted-modular': EMITTED_MCP_SERIALIZE,
  'sync-runtime': NO_ROW_BODY,
  'sync-emitted': NO_ROW_BODY,
  // `JSON.stringify(result)`.
  cli: {
    item: 'toJSON',
    fieldPermissions: 'none',
    customSerializers: { config: 'none' },
  },
  // `itemToObservation`: a serialiser's return value is not walked.
  'chat-tool-loop': {
    item: 'toPublicJSON-else-toJSON',
    fieldPermissions: 'principal-run',
    customSerializers: {
      config: 'mcp.serializers.get',
      item: ['get'],
      resultProjection: 'as-returned',
    },
  },
};

// ---------------------------------------------------------------------------
// 2. Create semantics
// ---------------------------------------------------------------------------

const ADOPTING_CREATE: CreateProfile = {
  conflict: 'adopt',
  frameworkOptions: [],
  id: 'generated',
  savesAfterCreate: false,
};

const SYNC_CREATE: CreateProfile = {
  conflict: 'insert-only',
  frameworkOptions: ['_insertOnly'],
  id: 'envelope',
  savesAfterCreate: false,
};

export const LEGACY_CREATE: ByTransport<CreateProfile> = {
  // `collection.create({ ...writable, _skipLoad: true })`. The option equals
  // the collection's own default, so it changes nothing observable.
  'rest-runtime': { ...ADOPTING_CREATE, frameworkOptions: ['_skipLoad'] },
  'sveltekit-emitted': ADOPTING_CREATE,
  'mcp-inprocess': ADOPTING_CREATE,
  'mcp-emitted-single': ADOPTING_CREATE,
  'mcp-emitted-modular': ADOPTING_CREATE,
  // sync/apply.ts: `create({ ...data, id: item.id, _insertOnly: true })`.
  'sync-runtime': SYNC_CREATE,
  'sync-emitted': SYNC_CREATE,
  cli: ADOPTING_CREATE,
  // `collection.create(...)` followed by `item.save()`.
  'chat-tool-loop': { ...ADOPTING_CREATE, savesAfterCreate: true },
};

// ---------------------------------------------------------------------------
// 3. Filter, sort, page, count
// ---------------------------------------------------------------------------

const NO_QUERY: QueryProfile = {
  where: 'none',
  dnf: false,
  filterFieldAccess: 'collection-rules',
  bounds: 'none',
  orderBy: 'none',
  count: 'none',
  displayLabel: 'never',
};

export const LEGACY_QUERY: ByTransport<QueryProfile> = {
  'rest-runtime': {
    where: 'rest-bracket-query',
    dnf: false,
    filterFieldAccess: 'collection-rules',
    bounds: 'shared-parser',
    orderBy: 'caller-or-default',
    count: 'route',
    displayLabel: 'when-projected',
  },
  // `listBounds` is emitted into the route; `collection.count({ where })`
  // runs on every list.
  'sveltekit-emitted': {
    where: 'rest-bracket-query',
    dnf: false,
    filterFieldAccess: 'collection-rules',
    bounds: 'inline-parser',
    orderBy: 'caller-or-default',
    count: 'with-list',
    displayLabel: 'when-projected',
  },
  // `args.where` goes to the collection as given, a DNF array included.
  'mcp-inprocess': {
    where: 'passed-through',
    dnf: true,
    filterFieldAccess: 'collection-rules',
    bounds: 'shared-parser',
    orderBy: 'caller-or-default',
    count: 'with-list',
    displayLabel: 'never',
  },
  // `resolveListBound` is emitted into the server file.
  'mcp-emitted-single': {
    where: 'passed-through',
    dnf: true,
    filterFieldAccess: 'collection-rules',
    bounds: 'inline-parser',
    orderBy: 'caller-or-default',
    count: 'with-list',
    displayLabel: 'never',
  },
  // `args.limit ?? 50`, and `collection.list({ where, limit, offset })` with
  // no ordering at all.
  'mcp-emitted-modular': {
    where: 'passed-through',
    dnf: true,
    filterFieldAccess: 'collection-rules',
    bounds: 'unvalidated-default-50',
    orderBy: 'never',
    count: 'with-list',
    displayLabel: 'never',
  },
  'sync-runtime': NO_QUERY,
  'sync-emitted': NO_QUERY,
  // `--where` is `JSON.parse`d and passed on; `--limit` is `parseInt`ed.
  cli: {
    where: 'json-option',
    dnf: true,
    filterFieldAccess: 'collection-rules',
    bounds: 'parse-int',
    orderBy: 'caller-only',
    count: 'none',
    displayLabel: 'never',
  },
  // `assertReadArguments` refuses an array `where`.
  'chat-tool-loop': {
    where: 'record-only',
    dnf: false,
    filterFieldAccess: 'collection-rules',
    bounds: 'validated-integer-default-50',
    orderBy: 'never',
    count: 'none',
    displayLabel: 'always',
  },
};

// ---------------------------------------------------------------------------
// 4. Tenant context
// ---------------------------------------------------------------------------

const NO_TENANT_HANDLING: TenantProfile = {
  mechanism: 'none',
  operations: 'none',
  scopedWhen: 'not-consulted',
  tenantSource: 'none',
  activeContextMismatch: 'n/a',
  callerTenantFilter: 'n/a',
  noTenant: 'interceptor-decides',
};

const EMITTED_MCP_TENANT: TenantProfile = {
  mechanism: 'gate',
  operations: 'all',
  // `TENANT_SCOPED` holds lower-cased tool object names.
  scopedWhen: 'baked-lowercase-simple-name',
  tenantSource: 'environment',
  activeContextMismatch: 'n/a',
  callerTenantFilter: 'n/a',
  noTenant: 'refused-by-runner',
};

export const LEGACY_TENANT: ByTransport<TenantProfile> = {
  // `resolveTenantReadScope` / `applyTenantReadScope` on list, get and count.
  'rest-runtime': {
    mechanism: 'read-predicate',
    operations: 'reads',
    scopedWhen: 'registry-config-or-tenancy-resolver',
    tenantSource: 'ambient-dispatch-scope',
    activeContextMismatch: 'n/a',
    callerTenantFilter: 'stripped',
    noTenant: 'global-rows-on-read',
  },
  // `establishTenantContext(locals)` in every handler of a tenant-scoped or
  // `api.principalContext` model, plus `tenantReadScope()` spread over the
  // caller's `where` on reads.
  'sveltekit-emitted': {
    mechanism: 'sticky-context',
    operations: 'all',
    scopedWhen: 'manifest-decorator-config',
    tenantSource: 'locals',
    activeContextMismatch: 'refused-403',
    principalContext: 'api.principalContext',
    callerTenantFilter: 'overridden-exact-key',
    noTenant: 'global-rows-on-read',
  },
  'mcp-inprocess': {
    mechanism: 'gate',
    operations: 'all',
    scopedWhen: 'tenancy-by-class-name',
    tenantSource: 'construction-context',
    activeContextMismatch: 'n/a',
    callerTenantFilter: 'n/a',
    noTenant: 'refused-by-runner',
  },
  'mcp-emitted-single': EMITTED_MCP_TENANT,
  'mcp-emitted-modular': EMITTED_MCP_TENANT,
  'sync-runtime': NO_TENANT_HANDLING,
  // One `establishTenantContext` for the whole batch when any target is
  // tenant-scoped; it returns early if a context is already active and never
  // reads `locals.tenantContext`.
  'sync-emitted': {
    mechanism: 'sticky-context',
    operations: 'all',
    scopedWhen: 'manifest-any-target-scoped',
    tenantSource: 'locals-without-tenant-context',
    activeContextMismatch: 'kept-silently',
    callerTenantFilter: 'n/a',
    noTenant: 'interceptor-decides',
  },
  // `context.tenantId` feeds runtime exposure only.
  cli: NO_TENANT_HANDLING,
  'chat-tool-loop': {
    mechanism: 'principal-context',
    operations: 'all',
    scopedWhen: 'not-consulted',
    tenantSource: 'principal-run',
    activeContextMismatch: 'n/a',
    callerTenantFilter: 'n/a',
    noTenant: 'interceptor-decides',
  },
};

// ---------------------------------------------------------------------------
// 5. Errors
// ---------------------------------------------------------------------------

const SYNC_ERRORS: ErrorProfile = {
  render: 'per-item-reason',
  guarded: 'all',
  shape: 'sync-item',
  refusalShape: 'sync-item',
  messageVisible: 'never',
  codeVisible: 'never',
};

const EMITTED_MCP_ERRORS: ErrorProfile = {
  render: 'message-shown',
  guarded: 'all',
  shape: 'mcp-is-error',
  refusalShape: 'thrown-message',
  textPrefix: 'Error executing tool <name>: ',
  messageVisible: 'always',
  codeVisible: 'code-with-publicMessage',
};

export const LEGACY_ERRORS: ByTransport<ErrorProfile> = {
  'rest-runtime': {
    render: 'typed-4xx-else-opaque-500',
    guarded: 'all',
    shape: 'error-object-with-ok-false',
    refusalShape: 'error-string',
    messageVisible: 'typed-4xx-only',
    codeVisible: 'typed-4xx-only',
  },
  // `smrtRouteErrorResponse` wraps the create, the update mutation and the
  // delete; reads, guards and `request.json()` throw to SvelteKit.
  'sveltekit-emitted': {
    render: 'typed-4xx-else-opaque-500',
    guarded: 'writes-only',
    shape: 'error-object-with-ok-false',
    refusalShape: 'kit-error',
    messageVisible: 'typed-4xx-only',
    codeVisible: 'typed-4xx-only',
  },
  'mcp-inprocess': {
    render: 'message-shown',
    guarded: 'all',
    shape: 'mcp-is-error',
    refusalShape: 'thrown-message',
    textPrefix: 'Error: ',
    messageVisible: 'always',
    codeVisible: 'code-with-publicMessage',
    alsoPublic: ['GeneratedFieldError'],
  },
  'mcp-emitted-single': EMITTED_MCP_ERRORS,
  'mcp-emitted-modular': EMITTED_MCP_ERRORS,
  'sync-runtime': SYNC_ERRORS,
  'sync-emitted': SYNC_ERRORS,
  cli: {
    render: 'message-shown',
    guarded: 'all',
    shape: 'stderr-exit-1',
    refusalShape: 'stderr-exit-1',
    messageVisible: 'always',
    codeVisible: 'never',
  },
  'chat-tool-loop': {
    render: 'classified-observation',
    guarded: 'all',
    shape: 'observation',
    refusalShape: 'observation',
    messageVisible: 'always',
    codeVisible: 'string-code',
  },
};

// ---------------------------------------------------------------------------
// 6. Authorisation
// ---------------------------------------------------------------------------

const EMITTED_MCP_AUTHORIZATION: AuthorizationProfile = {
  authentication: 'process',
  operationPermission: 'none',
  permissionBypass: [],
  publicAccess: 'ignored',
  order: ['exposure', 'tool-catalogue'],
  actionEnabledBy: 'mcp-tool-catalogue',
  customActionMutating: 'n/a',
};

export const LEGACY_AUTHORIZATION: ByTransport<AuthorizationProfile> = {
  // `authMiddleware(objectName, req.method.toLowerCase())`, then custom-action
  // dispatch, then the 405 gate. Without a middleware, `api.public` decides.
  'rest-runtime': {
    authentication: 'host-middleware',
    middlewareAction: 'lowercase-http-method',
    operationPermission: 'none',
    permissionBypass: [],
    publicAccess: 'api.public',
    order: [
      'exposure',
      'authenticate',
      'custom-action-dispatch',
      'action-enabled',
    ],
    actionEnabledBy: 'api.include-exclude',
    customActionMutating: 'non-get-method',
  },
  // `requireRouteAuth` then `requireRoutePermission` on mutating handlers. A
  // disabled action has no handler, so SvelteKit answers it.
  'sveltekit-emitted': {
    authentication: 'locals-principal',
    operationPermission: 'mutations',
    permissionBypass: ['api.public-true', 'tenantContext.superAdminBypass'],
    publicAccess: 'api.public',
    order: ['exposure', 'authenticate', 'permission'],
    actionEnabledBy: 'api.include-exclude',
    customActionMutating: 'non-get-method',
  },
  // `requireToolAuth`: `context.user` exists, unless `api.public` covers the
  // call. Exposure is applied when the catalogue is built.
  'mcp-inprocess': {
    authentication: 'context-user',
    operationPermission: 'none',
    permissionBypass: [],
    publicAccess: 'api.public',
    order: ['tool-catalogue', 'authenticate'],
    actionEnabledBy: 'mcp-tool-catalogue',
    customActionMutating: 'always',
    taskAdmission: 'separate-entry-point',
  },
  'mcp-emitted-single': {
    ...EMITTED_MCP_AUTHORIZATION,
    taskAdmission: 'separate-entry-point',
  },
  'mcp-emitted-modular': EMITTED_MCP_AUTHORIZATION,
  // `authorize(op)` maps create/update/delete to post/put/delete for the
  // middleware; without one only `api.public: true` applies.
  'sync-runtime': {
    authentication: 'host-middleware',
    middlewareAction: 'sync-op-as-verb',
    operationPermission: 'none',
    permissionBypass: [],
    publicAccess: 'api.public-true-only',
    order: ['exposure', 'authenticate', 'action-enabled'],
    actionEnabledBy: 'api.include-exclude',
    customActionMutating: 'n/a',
  },
  'sync-emitted': {
    authentication: 'locals-principal',
    operationPermission: 'mutations',
    permissionBypass: ['api.public-true', 'tenantContext.superAdminBypass'],
    publicAccess: 'api.public-true-only',
    order: ['exposure', 'authenticate', 'permission', 'action-enabled'],
    actionEnabledBy: 'api.include-exclude',
    customActionMutating: 'n/a',
  },
  cli: {
    authentication: 'process',
    operationPermission: 'none',
    permissionBypass: [],
    publicAccess: 'ignored',
    order: ['exposure'],
    actionEnabledBy: 'cli.include-exclude',
    customActionMutating: 'n/a',
  },
  // `assertToolAllowed`, exposure, then `assertOperation(collection, action)`.
  'chat-tool-loop': {
    authentication: 'principal-run',
    operationPermission: 'all',
    permissionBypass: [],
    publicAccess: 'ignored',
    order: ['allow-list', 'exposure', 'permission'],
    actionEnabledBy: 'permission-catalog',
    customActionMutating: 'n/a',
  },
};

// ---------------------------------------------------------------------------
// 7. Lookup
// ---------------------------------------------------------------------------

const BAKED_TOOL_LOOKUP: LookupProfile = {
  policyName: 'registry-key',
  segment: 'baked-tool-target',
  collection: 'registry',
};

const RUNTIME_REST_LOOKUP: LookupProfile = {
  // A registered collection reports its item's qualified name; auto-discovery
  // passes `classInfo.name`.
  policyName: 'registry-key-or-simple-name',
  segment: 'first-registry-match',
  collection: 'registered-instance-else-registry',
};

export const LEGACY_LOOKUP: ByTransport<LookupProfile> = {
  'rest-runtime': RUNTIME_REST_LOOKUP,
  'sveltekit-emitted': {
    policyName: 'registry-key',
    segment: 'baked-manifest-key',
    collection: 'registry',
  },
  // `MCPGenerator.getCollection` constructs a declared collection class
  // itself and keeps it for the generator's lifetime.
  'mcp-inprocess': {
    ...BAKED_TOOL_LOOKUP,
    collection: 'declared-constructor-else-registry',
  },
  'mcp-emitted-single': BAKED_TOOL_LOOKUP,
  'mcp-emitted-modular': BAKED_TOOL_LOOKUP,
  'sync-runtime': RUNTIME_REST_LOOKUP,
  'sync-emitted': {
    policyName: 'registry-key',
    segment: 'baked-manifest-key',
    collection: 'registry',
  },
  // The first registration whose lower-cased simple name matches the command.
  cli: {
    policyName: 'simple-name',
    segment: 'first-simple-name-match',
    collection: 'declared-constructor-by-simple-name',
  },
  'chat-tool-loop': {
    policyName: 'registry-key',
    segment: 'catalog-qualified-name',
    collection: 'registry',
  },
};

// ---------------------------------------------------------------------------
// 8. STI create target
// ---------------------------------------------------------------------------

const SYNC_STI: StiProfile = {
  createType: 'none',
  exposureSurface: 'rest',
  policySubject: {
    writablePolicy: 'base',
    authentication: 'base',
    tenant: 'n/a',
  },
};

const EMITTED_MCP_STI: StiProfile = {
  createType: 'resolveCreateTarget',
  exposureSurface: 'mcp',
  // The tenant set is keyed by the tool's own object name.
  policySubject: {
    writablePolicy: 'subtype',
    authentication: 'n/a',
    tenant: 'base',
  },
};

export const LEGACY_STI: ByTransport<StiProfile> = {
  // The middleware has already run against the base by the time the body
  // names a subtype.
  'rest-runtime': {
    createType: 'resolveCreateTarget',
    exposureSurface: 'rest',
    policySubject: {
      writablePolicy: 'subtype',
      authentication: 'base',
      tenant: 'n/a',
    },
  },
  'sveltekit-emitted': {
    createType: 'resolveCreateTarget',
    exposureSurface: 'rest',
    policySubject: {
      writablePolicy: 'subtype',
      authentication: 'base',
      tenant: 'base',
    },
  },
  // `requireToolAuth` and the gate both receive the resolved target.
  'mcp-inprocess': {
    createType: 'resolveCreateTarget',
    exposureSurface: 'mcp',
    policySubject: {
      writablePolicy: 'subtype',
      authentication: 'subtype',
      tenant: 'subtype',
    },
  },
  'mcp-emitted-single': EMITTED_MCP_STI,
  'mcp-emitted-modular': EMITTED_MCP_STI,
  'sync-runtime': SYNC_STI,
  'sync-emitted': {
    ...SYNC_STI,
    policySubject: { ...SYNC_STI.policySubject, tenant: 'base' },
  },
  cli: {
    createType: 'resolveCreateTarget',
    exposureSurface: 'cli',
    policySubject: {
      writablePolicy: 'subtype',
      authentication: 'n/a',
      tenant: 'n/a',
    },
  },
  'chat-tool-loop': {
    createType: 'resolveCreateTarget',
    exposureSurface: 'assistant',
    policySubject: {
      writablePolicy: 'subtype',
      authentication: 'base',
      tenant: 'n/a',
    },
  },
};

// ---------------------------------------------------------------------------
// 9. Argument validation
// ---------------------------------------------------------------------------

const HTTP_ARGUMENTS: ArgumentProfile = {
  id: 'url-segment',
  // `collection.get(string)` resolves a non-UUID string as a slug.
  getBySlug: 'same-argument',
  schemaValidation: 'n/a',
};

const MCP_ARGUMENTS: ArgumentProfile = {
  // `if (!args.id && !args.slug)`, then `collection.get(args.id || args.slug)`.
  id: 'truthiness',
  getBySlug: 'argument',
  schemaValidation: 'none',
};

const SYNC_ARGUMENTS: ArgumentProfile = {
  id: 'uuid-envelope',
  getBySlug: 'no',
  schemaValidation: 'envelope',
};

export const LEGACY_ARGUMENTS: ByTransport<ArgumentProfile> = {
  'rest-runtime': HTTP_ARGUMENTS,
  'sveltekit-emitted': HTTP_ARGUMENTS,
  'mcp-inprocess': MCP_ARGUMENTS,
  'mcp-emitted-single': MCP_ARGUMENTS,
  'mcp-emitted-modular': MCP_ARGUMENTS,
  'sync-runtime': SYNC_ARGUMENTS,
  'sync-emitted': SYNC_ARGUMENTS,
  cli: {
    id: 'cli-argument',
    getBySlug: 'same-argument',
    schemaValidation: 'n/a',
  },
  'chat-tool-loop': {
    id: 'string-typed',
    getBySlug: 'same-argument',
    schemaValidation: 'read-arguments-only',
  },
};

// ---------------------------------------------------------------------------
// 10. Result shapes
// ---------------------------------------------------------------------------

const SYNC_RESULTS: ResultProfile = {
  list: 'n/a',
  create: 'sync-item',
  notFound: 'n/a',
  delete: 'sync-item',
  deleteMissing: 'applied',
};

const EMITTED_MCP_RESULTS: ResultProfile = {
  // `structuredContent` is `{ data, meta }`; the text content is the bare
  // array of items.
  list: 'data-meta-with-array-text',
  create: 'item',
  notFound: 'thrown-message',
  delete: 'success-message',
  deleteMissing: 'thrown-message',
};

export const LEGACY_RESULTS: ByTransport<ResultProfile> = {
  'rest-runtime': {
    list: 'bare-array',
    create: 'item-201',
    notFound: '404',
    delete: '204-empty',
    deleteMissing: '404',
    updateMethods: ['PUT', 'PATCH'],
  },
  'sveltekit-emitted': {
    list: 'items-count-limit-offset',
    create: 'item-201',
    notFound: '404',
    delete: '200-success-true',
    deleteMissing: '404',
    updateMethods: ['PUT'],
  },
  'mcp-inprocess': {
    list: 'data-meta',
    create: 'item',
    notFound: 'thrown-message',
    delete: 'success-message',
    deleteMissing: 'thrown-message',
  },
  'mcp-emitted-single': EMITTED_MCP_RESULTS,
  'mcp-emitted-modular': EMITTED_MCP_RESULTS,
  'sync-runtime': SYNC_RESULTS,
  'sync-emitted': SYNC_RESULTS,
  cli: {
    list: 'printed',
    create: 'printed',
    notFound: 'exit-1',
    delete: 'printed',
    deleteMissing: 'exit-1',
  },
  'chat-tool-loop': {
    list: 'bare-array',
    create: 'item',
    notFound: 'found-false',
    delete: 'success-id',
    deleteMissing: 'found-false',
  },
};

// ---------------------------------------------------------------------------
// 11. Request body
// ---------------------------------------------------------------------------

const SDK_BODY: BodyProfile = {
  source: 'sdk',
  limit: 'n/a',
  readBeforeAuth: false,
  malformed: 'n/a',
};

export const LEGACY_BODY: ByTransport<BodyProfile> = {
  // `createServer()` buffers the whole body in `streamToString` before
  // `handleRequest`; `req.json()` then throws a `SyntaxError` with no status.
  'rest-runtime': {
    source: 'request-json',
    limit: 'unbounded',
    readBeforeAuth: true,
    malformed: 'opaque-500',
  },
  // `await request.json()` sits after the guards and outside the route's try.
  'sveltekit-emitted': {
    source: 'request-json',
    limit: 'unbounded',
    readBeforeAuth: false,
    malformed: 'framework-500',
  },
  'mcp-inprocess': SDK_BODY,
  'mcp-emitted-single': SDK_BODY,
  'mcp-emitted-modular': SDK_BODY,
  // `{ error: 'Invalid JSON body' }`.
  'sync-runtime': {
    source: 'buffered-text',
    limit: 'batch-size-only',
    readBeforeAuth: true,
    malformed: '400-error-string',
  },
  // `{ error: { code: 'invalid_batch', message: 'Invalid JSON body' } }`.
  'sync-emitted': {
    source: 'request-json',
    limit: 'batch-size-only',
    readBeforeAuth: true,
    malformed: '400-invalid-batch',
  },
  cli: {
    source: 'file-or-flags',
    limit: 'n/a',
    readBeforeAuth: false,
    malformed: 'thrown-message',
  },
  'chat-tool-loop': {
    source: 'sdk',
    limit: 'n/a',
    readBeforeAuth: false,
    malformed: 'invalid-request-observation',
  },
};

// ---------------------------------------------------------------------------
// Assembled profiles
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

for (const table of [
  LEGACY_OPERATIONS,
  LEGACY_WRITE,
  LEGACY_SERIALIZE,
  LEGACY_CREATE,
  LEGACY_QUERY,
  LEGACY_TENANT,
  LEGACY_ERRORS,
  LEGACY_AUTHORIZATION,
  LEGACY_LOOKUP,
  LEGACY_STI,
  LEGACY_ARGUMENTS,
  LEGACY_RESULTS,
  LEGACY_BODY,
]) {
  deepFreeze(table);
}

function assemble(transport: LegacyTransportId): TransportProfile {
  return deepFreeze({
    transport,
    surface: LEGACY_TRANSPORT_SOURCES[transport].surface,
    operations: LEGACY_OPERATIONS[transport],
    write: LEGACY_WRITE[transport],
    serialize: LEGACY_SERIALIZE[transport],
    create: LEGACY_CREATE[transport],
    query: LEGACY_QUERY[transport],
    tenant: LEGACY_TENANT[transport],
    errors: LEGACY_ERRORS[transport],
    authorization: LEGACY_AUTHORIZATION[transport],
    lookup: LEGACY_LOOKUP[transport],
    sti: LEGACY_STI[transport],
    arguments: LEGACY_ARGUMENTS[transport],
    results: LEGACY_RESULTS[transport],
    body: LEGACY_BODY[transport],
  });
}

/** Every legacy profile, by transport. */
export const LEGACY_PROFILES: ByTransport<TransportProfile> = Object.freeze({
  'rest-runtime': assemble('rest-runtime'),
  'sveltekit-emitted': assemble('sveltekit-emitted'),
  'mcp-inprocess': assemble('mcp-inprocess'),
  'mcp-emitted-single': assemble('mcp-emitted-single'),
  'mcp-emitted-modular': assemble('mcp-emitted-modular'),
  'sync-runtime': assemble('sync-runtime'),
  'sync-emitted': assemble('sync-emitted'),
  cli: assemble('cli'),
  'chat-tool-loop': assemble('chat-tool-loop'),
});

/** Runtime REST (`APIGenerator`). */
export const LEGACY_REST = LEGACY_PROFILES['rest-runtime'];
/** Generated SvelteKit CRUD routes. */
export const LEGACY_SVELTEKIT = LEGACY_PROFILES['sveltekit-emitted'];
/** In-process MCP (`MCPGenerator.handleToolCall`). */
export const LEGACY_MCP = LEGACY_PROFILES['mcp-inprocess'];
/** Emitted single-file stdio MCP server. */
export const LEGACY_MCP_EMITTED_SINGLE = LEGACY_PROFILES['mcp-emitted-single'];
/** Emitted modular stdio MCP server. */
export const LEGACY_MCP_EMITTED_MODULAR =
  LEGACY_PROFILES['mcp-emitted-modular'];
/** Runtime REST as the sync/apply host. */
export const LEGACY_SYNC_RUNTIME = LEGACY_PROFILES['sync-runtime'];
/** Generated SvelteKit sync/apply route. */
export const LEGACY_SYNC_EMITTED = LEGACY_PROFILES['sync-emitted'];
/** `smrt <object>:<action>` commands. */
export const LEGACY_CLI = LEGACY_PROFILES.cli;
/** The chat tool loop. */
export const LEGACY_CHAT = LEGACY_PROFILES['chat-tool-loop'];
