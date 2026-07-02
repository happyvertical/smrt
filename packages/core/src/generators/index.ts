/**
 * @smrt/core generators - Create REST APIs and MCP servers from SMRT objects
 */

export type { CLIConfig, CLIContext } from './cli';
// CLI Generator
export { CLIGenerator, getCLIHandler, setupCLI } from './cli';
// Conditional GET for generated read routes (#1757)
export {
  computeBodyEtag,
  conditionalJsonResponse,
  ifNoneMatchSatisfied,
  PRIVATE_READ_CACHE_CONTROL,
  resolveReadCacheControl,
} from './conditional-get';
export type {
  MCPConfig,
  MCPContext,
  MCPRequest,
  MCPResponse,
  MCPTool,
} from './mcp';
// MCP Server Generator
export { MCPGenerator } from './mcp';
export type { APIConfig, APIContext, RestServerConfig } from './rest';
// REST API Generator and server utilities
export { APIGenerator, createRestServer, startRestServer } from './rest';
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
