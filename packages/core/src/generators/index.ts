/**
 * @smrt/core generators - Create REST APIs and MCP servers from SMRT objects
 */

export type { CLIConfig, CLIContext } from './cli';
// CLI Generator
export { CLIGenerator, getCLIHandler, setupCLI } from './cli';
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
export {
  buildCustomActionInputSchema,
  buildCustomActionInvocationArgs,
  CRUD_OPERATIONS,
  type CustomActionFailure,
  type CustomActionMetadata,
  type CustomActionScope,
  customActionParameterInputName,
  isCrudOperation,
  isCrudToolAction,
  normalizeCustomActionFailure,
  type ResolveCustomActionMetadataOptions,
  type ResolvedCustomActionMetadata,
  resolveCustomActionMetadata,
  SMRT_CUSTOM_ACTION_ERROR_METADATA_KEY,
  type ToolEffect,
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
export type { APIConfig, APIContext, RestServerConfig } from './rest';
// REST API Generator and server utilities
export {
  APIGenerator,
  computeRuntimeWebManifestHash,
  createRestServer,
  startRestServer,
} from './rest';
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
// Shared 4xx normalization for generated REST and SvelteKit transports.
export {
  normalizeTypedHttpError,
  type TypedHttpFailure,
} from './typed-http-error';
