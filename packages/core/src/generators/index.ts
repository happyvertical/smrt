/**
 * @smrt/core generators - Create CLIs, REST APIs, and MCP servers from SMRT objects
 */

export type { CLICommand, CLIConfig, CLIContext, ParsedArgs } from './cli';
// CLI Generator (includes both library and executable)
export { CLIGenerator, main } from './cli';
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
