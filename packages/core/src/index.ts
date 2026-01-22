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
// Database utilities
export {
  type DatabaseConfig,
  isDatabaseInterface,
  type ResolveDatabaseOptions,
  resolveDatabase,
} from './database';
// Property decorators for field definition
// Re-export decorator versions with priority over field helpers
export {
  type FieldOptions,
  field,
  foreignKey,
  type Meta,
  manyToMany,
  meta,
  type NumericFieldOptions,
  oneToMany,
  type RelationshipFieldOptions,
  type TextFieldOptions,
} from './decorators/index';
// Dispatch system (inter-agent communication)
export * from './dispatch/index';
// Embeddings support (semantic search)
export * from './embeddings/index';
export * from './errors';
// Code generators (tree-shakeable)
export * from './generators/index';
// Global interceptors system (for tenancy, soft-delete, audit logging, etc.)
export * from './interceptors';
// Static manifest (generated at build time)
export * from './manifest/index';
export type { DiffOptions } from './migrations/differ';
// Schema comparison and migration utilities
export {
  generateSchemaDiff,
  getSQLFromDiff,
  hasActionableChanges,
  SchemaComparer,
} from './migrations/differ';
export * from './object';
export * from './registry';
export { smrt as smrtRegistry } from './registry';
// Runtime utilities
export * from './runtime/index';
// Schema types (for generated code from SchemaCodeGenerator)
export type { SchemaDefinition } from './schema/types';
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
// Testing utilities (for test setup only)
export {
  getTestDatabase,
  type TestDatabaseOptions,
} from './testing/database';
// AI function calling tools
export * from './tools/index';
// JSON utilities with optional SIMD acceleration
export {
  clone,
  getAdapterInfo,
  isValid,
  type JSONAdapter,
  type ParseError,
  parse,
  type Result,
  type StringifyError,
  safeParse,
  safeStringify,
  stringify,
} from './utils/json';
// Qualified name utilities
export {
  createQualifiedName,
  getClassName,
  getPackageFromQualifiedName,
  isFromPackage,
  isQualifiedName,
  isType,
  type ParsedQualifiedName,
  parseQualifiedName,
  qualifiedNamesEqual,
} from './utils/qualified-names';
// Vite plugin for auto-service generation
export { smrtPlugin } from './vite-plugin/index';
