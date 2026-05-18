/**
 * Type definitions for AST scanning and manifest generation
 */

import type { SmartObjectConfig } from '../registry.js';

/**
 * Qualified class name in format "@package/name:ClassName"
 * Example: "@happyvertical/smrt-core:Product"
 */
export type QualifiedClassName = `${string}:${string}`;

/**
 * Controls how a class is exposed in manifests and across packages
 */
export type SmrtVisibility =
  | 'public' // Included in published manifest, available to all consumers
  | 'internal' // Package-only, excluded from published manifest
  | 'test'; // Test-only, never in any published manifest

export interface FieldDefinition {
  type:
    | 'text'
    | 'decimal'
    | 'boolean'
    | 'integer'
    | 'datetime'
    | 'json'
    | 'foreignKey'
    | 'crossPackageRef' // Cross-package reference — plain TEXT, no DDL FK
    | 'oneToMany'
    | 'manyToMany'
    | 'meta'; // STI meta fields (_meta_type, _meta_data)
  required?: boolean;
  default?: any;
  min?: number;
  max?: number;
  maxLength?: number;
  minLength?: number;
  related?: string; // For foreignKey, crossPackageRef, oneToMany, manyToMany
  description?: string;
  _meta?: Record<string, any>;
  transient?: boolean; // Field not persisted to database
  /**
   * Controls whether the field is included in JSON exports.
   * - `true`: Always exported (unless site explicitly excludes it)
   * - `false`: Never exported (cannot be overridden by site config)
   * - `undefined`: Uses site's fieldExportDefault setting
   */
  exported?: boolean;
}

export interface MethodDefinition {
  name: string;
  async: boolean;
  parameters: Array<{
    name: string;
    type: string;
    optional: boolean;
    default?: any;
  }>;
  returnType: string;
  description?: string;
  isStatic: boolean;
  isPublic: boolean;
}

/**
 * Pre-generated schema column definition for manifest
 */
export interface ManifestColumnDefinition {
  type: string; // SQL type: TEXT, INTEGER, DECIMAL, BOOLEAN, DATETIME, JSON
  primaryKey?: boolean;
  notNull?: boolean;
  unique?: boolean;
  default?: any;
}

/**
 * Pre-generated schema index definition for manifest
 */
export interface ManifestIndexDefinition {
  name: string;
  columns: string[];
  unique?: boolean;
}

/**
 * Pre-generated schema for efficient external package consumption
 * Generated at build time by ManifestGenerator, stored in manifest.json
 */
export interface ManifestSchema {
  tableName: string;
  ddl: string;
  columns: Record<string, ManifestColumnDefinition>;
  indexes: ManifestIndexDefinition[];
  version: string; // Hash of schema definition for migration tracking
}

/**
 * Validation rule type for pre-computed validators
 * These are serializable rules extracted from field definitions at build time,
 * eliminating the need to compile validator closures at runtime.
 */
export type ValidationRuleType =
  | 'required'
  | 'min'
  | 'max'
  | 'minLength'
  | 'maxLength'
  | 'pattern';

/**
 * Pre-computed validation rule for a field
 * Generated at build time by ManifestGenerator, stored in manifest.json
 *
 * These rules are evaluated at runtime without creating closure functions,
 * significantly reducing CLI startup time for projects with many SMRT objects.
 */
export interface ValidationRule {
  /** Field name to validate */
  field: string;
  /** Type of validation rule */
  rule: ValidationRuleType;
  /** Value for the rule (number for min/max/minLength/maxLength, string for pattern) */
  value?: number | string;
  /** Field type for context (text, integer, decimal, etc.) */
  fieldType?: string;
}

// ── Agent manifest types ────────────────────────────────────────────────

/**
 * Permission declared by an agent
 * Generated from uiSlots (manage:*) and CLI/MCP methods (execute:*)
 */
export interface AgentPermission {
  id: string;
  label: string;
  category: 'slot' | 'method';
  defaultGranted?: boolean;
}

/**
 * Feature declared by an agent
 */
export interface AgentFeature {
  id: string;
  label: string;
  description?: string;
  type: 'slot' | 'method';
}

/**
 * Menu item derived from agent uiSlots
 */
export interface AgentMenuItem {
  id: string;
  label: string;
  icon?: string;
  order: number;
  path: string;
  requiredPermission?: string;
}

/**
 * Component export declaration derived from package.json exports
 */
export interface AgentComponentDeclaration {
  exportPath: string;
  type: string;
}

/**
 * UI slot definition captured from static uiSlots on Agent subclasses
 */
export interface AgentUISlotManifest {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  order?: number;
}

/**
 * Admin route declared by an agent via static adminRoutes
 * Consumed by vitePluginAgentRoutes to register admin routes with SvelteKit
 */
export interface AgentAdminRouteManifest {
  /** Route path relative to agent root (e.g., 'sources/[sourceId]') */
  path: string;
  /** Component export name from the agent's admin entry point */
  component: string;
  /** Optional: export name for server load function */
  load?: string;
}

/**
 * Auto-generated agent manifest section
 * Produced by the manifest build pipeline for any class with `agent` decorator config
 */
export interface AgentManifest {
  name: string;
  slug: string;
  icon?: string;
  tier: 'free' | 'standard' | 'premium';
  description?: string;
  uiSlots: Record<string, AgentUISlotManifest>;
  adminRoutes?: AgentAdminRouteManifest[];
  /** Default signal subscriptions declared by this agent */
  signalSubscriptions?: string[];
  permissions: AgentPermission[];
  features: AgentFeature[];
  menuItems: AgentMenuItem[];
  components: AgentComponentDeclaration[];
}

// ── Core manifest types ─────────────────────────────────────────────────

export interface SmartObjectDefinition {
  /**
   * Qualified name in format "@package/name:ClassName"
   * This is the PRIMARY KEY for manifest lookups.
   * Example: "@happyvertical/smrt-core:Product"
   *
   * Optional during transition - will be required in future versions.
   */
  qualifiedName?: QualifiedClassName;

  /**
   * Simple class name (PascalCase)
   * Example: "Product"
   */
  className: string;

  /**
   * Package name where this class is defined.
   * Example: "@happyvertical/smrt-core"
   *
   * Optional during transition - will be required in future versions.
   */
  packageName?: string;

  /**
   * Visibility control for manifest inclusion
   * - 'public': Included in published manifest (default)
   * - 'internal': Package-only, excluded from published manifest
   * - 'test': Test-only, never in any published manifest
   *
   * Defaults to 'public' if not specified.
   */
  visibility?: SmrtVisibility;

  /**
   * @deprecated Use qualifiedName instead. Kept for transition period.
   * Lowercase class name, formerly used as manifest key.
   */
  name: string;

  collection: string; // Pluralized name for endpoints
  filePath: string;
  packageVersion?: string; // Package version for external manifest loading
  importPath?: string; // Import path for dynamic loading (e.g., "@pkg/objects")
  modulePath?: string; // Relative module path within package
  exportName?: string; // Named export to use (defaults to className)
  collectionExportName?: string; // Collection class export name
  fields: Record<string, FieldDefinition>;
  methods: Record<string, MethodDefinition>;
  decoratorConfig: SmartObjectConfig;
  extends?: string; // Base class name (simple name, not qualified)
  extendsQualified?: string; // Base class qualified name
  extendsTypeArg?: string; // Generic type argument (e.g., "Meeting" from "SmrtCollection<Meeting>")
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, any>;
    };
  }>;
  /**
   * Pre-generated schema for efficient external package consumption
   * Generated at build time by ManifestGenerator (smrt scan)
   *
   * When present, consumers can use this pre-computed schema directly
   * without calling generateSchema() at runtime, eliminating latency.
   */
  schema?: ManifestSchema;

  /**
   * Pre-computed validation rules for efficient runtime validation
   * Generated at build time by ManifestGenerator (smrt scan)
   *
   * When present, the registry uses these rules instead of compiling
   * validator closures at runtime, significantly reducing startup time.
   *
   * @see ValidationRule
   */
  validationRules?: ValidationRule[];

  /**
   * Static properties captured from the class definition
   * Currently used for `static uiSlots` on Agent subclasses
   */
  staticProperties?: Record<string, any>;

  /**
   * Auto-generated agent manifest
   * Only present for classes with `agent` in their decorator config
   * Generated at build time by ManifestGenerator fifth pass
   */
  agent?: AgentManifest;
}

export interface SmartObjectManifest {
  version: string;
  timestamp: number;
  packageName?: string; // Root package name (should be set for all new manifests)
  packageVersion?: string; // Root package version
  /**
   * Objects keyed by qualified name (e.g., "@happyvertical/smrt-core:Product")
   * Key is string for backward compatibility, but should be QualifiedClassName format.
   */
  objects: Record<string, SmartObjectDefinition>;
  moduleType?: string; // Module type identifier (e.g., "smrt") for package discovery
  smrtDependencies?: string[]; // Discovered SMRT packages from dependency tree
}

export interface ScanResult {
  filePath: string;
  objects: SmartObjectDefinition[];
  errors: Array<{
    message: string;
    line?: number;
    column?: number;
  }>;
}

export interface ScanOptions {
  includePrivateMethods?: boolean;
  includeStaticMethods?: boolean;
  followImports?: boolean;
  baseClasses?: string[]; // Classes to consider as SMRT base classes
}
