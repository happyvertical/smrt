/**
 * @smrt/core generators - Create REST APIs and MCP servers from SMRT objects
 */

// Conditional GET for generated read routes (#1757 v1 body-hash, #1765 v2
// per-table change-feed version source)
export {
  canonicalReadRepresentation,
  computeBodyEtag,
  computeTableVersionEtag,
  conditionalJsonResponse,
  ifNoneMatchHasConcreteMatch,
  ifNoneMatchSatisfied,
  PRIVATE_READ_CACHE_CONTROL,
  type ReadCacheControlOptions,
  resolveReadCacheControl,
  resolveTenantEtagDiscriminator,
  versionConditionalResponse,
  warnIfSharedCacheNeutralized,
} from './conditional-get';
// The one CORS policy shared by REST and generated SvelteKit routes
export {
  applyCorsHeaders,
  CORS_ALLOWED_HEADERS,
  CORS_ALLOWED_METHODS,
  CORS_MAX_AGE,
  type CorsConfig,
  corsPreflightHeaders,
  corsPreflightResponse,
  corsResponseHeaders,
  isCorsEnabled,
  normalizeCorsOrigins,
  resolveCorsOrigin,
} from './cors';
export {
  type ApiMethodExposure,
  type ApiMethodRejectionCode,
  buildCustomActionInputSchema,
  buildCustomActionInvocationArgs,
  CRUD_OPERATIONS,
  type CustomActionFailure,
  type CustomActionMetadata,
  type CustomActionScope,
  classifyMethodWireability,
  classifyParameterWireability,
  coerceCustomActionArgument,
  createClassNamePredicate,
  createManifestClassNamePredicate,
  customActionParameterInputName,
  declaredTypeAcceptsDate,
  declaresRuntimeRestRoute,
  declaresRuntimeRestRouteShape,
  type EffectiveActionMetadata,
  type ExposableMethod,
  isCrudOperation,
  isCrudToolAction,
  type MethodDecoratorConfig,
  normalizeCustomActionFailure,
  queryStringDecoderFor,
  type ResolveApiMethodExposureOptions,
  type ResolveCustomActionMetadataOptions,
  type ResolvedCustomActionMetadata,
  readMethodDecoratorConfig,
  resolveApiMethodExposure,
  resolveCustomActionMetadata,
  resolveDeclaredScopeMismatch,
  resolveEffectiveActionMetadata,
  SMRT_CUSTOM_ACTION_ERROR_METADATA_KEY,
  type ToolEffect,
  toCustomActionBoolean,
  toCustomActionDate,
  toCustomActionNumber,
  type WireabilityOptions,
  type WireabilityVerdict,
  type WireableParameter,
} from './custom-action';
// Live `_events` SSE route (#1763). The generated SvelteKit route imports
// `buildChangeEventStream` from the package root, so the stream lifecycle is
// written and tested once in core. `handleEventsRoute` stays internal (rest.ts
// only).
export {
  buildChangeEventStream,
  type ChangeEventStreamOptions,
  changeEventSubscribersAtCapacity,
  DEFAULT_EVENTS_HEARTBEAT_MS,
  DEFAULT_EVENTS_MAX_SUBSCRIBERS,
  DEFAULT_EVENTS_RETRY_AFTER_SECONDS,
  eventStreamCapacityExceededResponse,
  normalizeEventsMaxSubscribers,
  signalVisibleToTenant,
  tryReserveChangeEventSubscriberSlot,
} from './events-route';
export type {
  MCPConfig,
  MCPContext,
  MCPRequest,
  MCPResponse,
  MCPTool,
  MCPToolListCacheHint,
  MCPToolListCacheOptions,
} from './mcp';
// MCP Server Generator
export {
  MCP_STABLE_CATALOG_TTL_MS,
  MCPGenerator,
  resolveMCPToolListCacheHint,
  sortMCPTools,
} from './mcp';
// Browser-plane playbook preflight route + the static REST layers it predicts
// against (#2590). `authMiddleware` is never exposed to, or invoked by, any of
// these — see `preflight-route.ts`.
export {
  handlePlaybookPreflightRoute,
  isApiActionEnabledForObject,
  isRestActionRoutable,
  isRestRoutePublic,
  PLAYBOOK_PREFLIGHT_CAPABILITY,
  PLAYBOOK_PREFLIGHT_ROUTE_SEGMENT,
  type PlaybookPreflightProvider,
  type PlaybookPreflightRouteOptions,
  type PlaybookPreflightRouteRequest,
  resolveRegisteredObjectName,
  restFieldReadPermissions,
  restMethodForApiAction,
} from './preflight-route';
// The typed 403/401 a write refusal is thrown as (answered as a typed error).
export {
  modelRoutePolicy,
  RequestPrincipalRefusal,
} from './request-principal';
export type {
  APIConfig,
  APIContext,
  APIRequestInfo,
  APIRequestPrincipal,
  APIRequestRoute,
  RequestPrincipal,
  RestServerConfig,
} from './rest';
// REST API Generator and server utilities
export {
  APIGenerator,
  computeRuntimeWebManifestHash,
  createRestServer,
  startRestServer,
} from './rest';
// The one authorization decision shared by REST and generated SvelteKit routes
export {
  type AuthorizeDecision,
  type AuthorizeDenial,
  type AuthorizeInput,
  apiPrincipalFromLocals,
  authorize,
  isMutatingOperation,
  isOperationPublic,
  stripTenantFilters,
} from './route-authz';
export { reportUnexpectedHttpError } from './route-error';
// Route-level 429 limits shared by REST and generated SvelteKit routes (#5198)
export {
  configureRouteLimits,
  createRouteLimiter,
  DEFAULT_CALLER_KIND_SCALE,
  enforceRouteLimits,
  getRouteLimiter,
  type RouteLimit,
  type RouteLimitDecision,
  type RouteLimiter,
  type RouteLimitSubject,
  type RouteLimitsConfig,
  rateLimitedResponse,
} from './route-limits';
export type { OpenAPIConfig } from './swagger';
// Swagger/OpenAPI documentation utilities
export {
  generateOpenAPISpec,
  setupSwaggerUI,
} from './swagger';
// Tenant entry-point gate (dependency-inversion hook filled by smrt-tenancy)
export {
  runWithTenantGate,
  setTenantEntryPointRunner,
  type TenantEntryPointRunner,
  type TenantGateOptions,
} from './tenant-gate';
// Shared field-to-JSON-Schema projection for tool surfaces. Consumers with a
// runtime registry (such as chat's manifest dispatcher) normalize their fields
// into ToolFieldMeta before calling this pure helper.
export {
  fieldTypeToJsonSchema,
  type ToolFieldMeta,
  type ToolJsonSchema,
} from './tool-schema';
// Shared 4xx normalization for generated REST and SvelteKit transports.
export {
  normalizeTypedHttpError,
  type TypedHttpFailure,
} from './typed-http-error';
