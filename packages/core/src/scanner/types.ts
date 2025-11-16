/**
 * Type definitions for AST scanning and manifest generation
 */

import type { SmartObjectConfig } from '../registry.js';

export interface FieldDefinition {
  type:
    | 'text'
    | 'decimal'
    | 'boolean'
    | 'integer'
    | 'datetime'
    | 'json'
    | 'foreignKey'
    | 'oneToMany'
    | 'manyToMany'
    | 'meta'; // STI meta fields (_meta_type, _meta_data)
  required?: boolean;
  default?: any;
  min?: number;
  max?: number;
  maxLength?: number;
  minLength?: number;
  related?: string; // For foreignKey, oneToMany, manyToMany
  description?: string;
  _meta?: Record<string, any>;
  transient?: boolean; // Field not persisted to database
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

export interface SmartObjectDefinition {
  name: string;
  className: string;
  collection: string; // Pluralized name for endpoints
  filePath: string;
  packageName?: string; // Package name for external manifest loading
  packageVersion?: string; // Package version for external manifest loading
  importPath?: string; // Import path for dynamic loading (e.g., "@pkg/objects")
  modulePath?: string; // Relative module path within package
  exportName?: string; // Named export to use (defaults to className)
  collectionExportName?: string; // Collection class export name
  fields: Record<string, FieldDefinition>;
  methods: Record<string, MethodDefinition>;
  decoratorConfig: SmartObjectConfig;
  extends?: string; // Base class name
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, any>;
    };
  }>;
}

export interface SmartObjectManifest {
  version: string;
  timestamp: number;
  packageName?: string; // Root package name
  packageVersion?: string; // Root package version
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
