/**
 * @smrt/core - Core AI agent framework with standardized collections and code generators
 *
 * This package provides the foundational framework for building vertical AI agents.
 * It provides core abstractions and integrates with other HAVE SDK packages
 * (ai, files, sql) to provide a unified interface.
 *
 * Key components:
 * - SmrtClass: Foundation class providing access to database, filesystem, and AI
 * - SmrtObject: Persistent object with unique identifiers and database storage
 * - SmrtCollection: Collection interface for managing sets of SmrtObjects
 *
 * Generators:
 * - CLIGenerator: Create admin CLI tools from SMRT objects
 * - APIGenerator: Generate REST APIs for SMRT objects
 * - MCPGenerator: Create MCP servers for AI model integration
 */

// Built-in signal adapters
export * from './adapters/index';
// Core SMRT framework
export * from './class';
export * from './collection';
export type {
  GlobalSignalConfig,
  MetricsConfig,
  PubSubConfig,
} from './config';
// Global configuration (callable function)
export { config } from './config';
export * from './errors';
export * from './fields/index';
// Code generators (tree-shakeable)
export * from './generators/index';
// Static manifest (generated at build time)
export * from './manifest/index';
export * from './object';
export * from './pleb';
export * from './registry';
export { smrt as smrtRegistry } from './registry';
// Runtime utilities
export * from './runtime/index';
// Universal signaling system
export * from './signals/index';
// System tables and types (note-taking, migrations, registry, signals)
export * from './system/index';
export type {
  DiscoveryStrategy,
  ForgetOptions,
  ForgetScopeOptions,
  NoteMetadata,
  NoteOptions,
  RecallAllOptions,
  RecallOptions,
  SystemTableConfig,
} from './system/types';
// AI function calling tools
export * from './tools/index';
// Vite plugin for auto-service generation
export { smrtPlugin } from './vite-plugin/index';
