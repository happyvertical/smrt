/**
 * Runtime utilities for SMRT auto-generated services
 * Provides helper functions and base classes for generated code
 */

export { createSmrtClient } from './client';
// Note: MCPTool is exported from generators/index.ts to avoid duplicate exports
export type { MCPServerOptions } from './mcp';
export { createMCPServer, SmrtMCPServer } from './mcp';
export { createSmrtServer } from './server';
export type { SmrtClientOptions, SmrtServerOptions } from './types';
