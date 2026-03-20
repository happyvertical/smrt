/**
 * Type definitions for the SMRT ObjectRegistry.
 *
 * Extracted from registry.ts as part of issue #1006
 * (Split ObjectRegistry into focused modules).
 *
 * @see https://github.com/happyvertical/smrt/issues/1006
 */

import type { SmrtCollection } from '../collection';
import type { SmrtObject } from '../object';
import type {
  QualifiedClassName,
  SmartObjectManifest,
  SmrtVisibility,
  ValidationRule,
} from '../scanner/types.js';
import type { SchemaDefinition } from '../schema/types.js';

/**
 * Type for any constructor function that extends SmrtObject.
 * Used for WeakMap keys where we need to accept any subclass constructor.
 */
export type SmrtObjectConstructor = new (...args: any[]) => SmrtObject;

export type ApiHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiCustomRouteConfig {
  /**
   * Route scope for custom methods.
   * - `item`: Generates `/<collection>/[id]/<path>`
   * - `collection`: Generates `/<collection>/<path>`
   *
   * Defaults to `collection` for static methods and `item` for instance methods.
   */
  scope?: 'item' | 'collection';

  /**
   * HTTP verb for the generated route.
   * Defaults to `POST` for custom actions.
   */
  method?: ApiHttpMethod;

  /**
   * Optional custom path segment for the route.
   * Defaults to the method name.
   *
   * @example
   * ```typescript
   * routes: {
   *   browseFacts: { scope: 'collection', method: 'GET', path: 'facts' }
   * }
   * ```
   */
  path?: string;
}

export interface ApiConfig {
  /**
   * Exclude specific endpoints (supports both standard CRUD actions and custom methods)
   */
  exclude?: string[];

  /**
   * Include only specific endpoints (supports both standard CRUD actions and custom methods)
   */
  include?: string[];

  /**
   * Custom middleware for this object's endpoints
   */
  middleware?: any[];

  /**
   * Custom endpoint handlers (supports both standard CRUD actions and custom methods)
   */
  customize?: Record<string, (req: any, collection: any) => Promise<any>>;

  /**
   * Route metadata for custom API methods.
   * Lets generated routes declare collection-vs-item scope, HTTP verb, and path.
   */
  routes?: Record<string, ApiCustomRouteConfig>;
}

/**
 * Configuration options for SMRT objects registered in the system
 *
 * Controls how objects are exposed through generated APIs, CLIs, and MCP servers.
 * Each section configures a different aspect of code generation and runtime behavior.
 *
 * @interface SmartObjectConfig
 */
export interface SmartObjectConfig {
  /**
   * Custom name for the object (defaults to class name)
   */
  name?: string;

  /**
   * Explicit package name for deterministic qualified registration.
   *
   * Build tools should prefer setting this instead of relying on runtime
   * stack/package.json discovery, which can fail in bundled deployments.
   */
  packageName?: string;

  /**
   * Custom table name for database storage (defaults to pluralized snake_case class name)
   * Explicitly setting this ensures the table name survives code minification
   */
  tableName?: string;

  /**
   * Table inheritance strategy (defaults to 'cti')
   * - 'cti': Class Table Inheritance - one table per class (current default)
   * - 'sti': Single Table Inheritance - shared table with discriminator column
   *
   * Set once on base class, children inherit automatically.
   *
   * @example
   * ```typescript
   * @smrt({ tableStrategy: 'sti' })
   * class Event extends SmrtObject {
   *   title: string = '';
   * }
   *
   * // Meeting inherits 'sti' strategy
   * @smrt()
   * class Meeting extends Event {
   *   roomId = foreignKey(Room);
   * }
   * ```
   */
  tableStrategy?: 'cti' | 'sti';

  /**
   * Custom conflict columns for UPSERT operations
   *
   * By default, SMRT uses ['slug', 'context'] for CTI tables and
   * ['slug', 'context', '_meta_type'] for STI tables. Override this
   * for junction tables or models with different natural keys.
   *
   * @example
   * ```typescript
   * // Junction table using foreign keys as natural key
   * @smrt({ conflictColumns: ['event_id', 'profile_id'] })
   * class EventParticipant extends SmrtObject {
   *   eventId = '';
   *   profileId = '';
   * }
   * ```
   */
  conflictColumns?: string[];

  /**
   * Visibility control for manifest inclusion and cross-package access
   * - 'public': Included in published manifest, available to all consumers (default)
   * - 'internal': Package-only, excluded from published manifest
   * - 'test': Test-only, never in any published manifest
   *
   * @example
   * ```typescript
   * // Public class (default) - exported to consumers
   * @smrt({ visibility: 'public' })
   * class Product extends SmrtObject {}
   *
   * // Internal helper class - not exported
   * @smrt({ visibility: 'internal' })
   * class InternalHelper extends SmrtObject {}
   *
   * // Test fixture - never exported
   * @smrt({ visibility: 'test' })
   * class TestProduct extends SmrtObject {}
   * ```
   */
  visibility?: SmrtVisibility;

  /**
   * API configuration
   */
  api?: boolean | ApiConfig;

  /**
   * MCP server configuration
   */
  mcp?:
    | boolean
    | {
        /**
         * Include specific tools (supports both standard CRUD actions and custom methods)
         */
        include?: string[];

        /**
         * Exclude specific tools (supports both standard CRUD actions and custom methods)
         */
        exclude?: string[];
      };

  /**
   * CLI configuration
   */
  cli?:
    | boolean
    | {
        /**
         * Include specific commands (supports both standard CRUD actions and custom methods)
         */
        include?: string[];

        /**
         * Exclude specific commands (supports both standard CRUD actions and custom methods)
         */
        exclude?: string[];
      };

  /**
   * AI callable configuration
   */
  ai?: {
    /**
     * Methods that AI can call
     * - Array of method names, e.g., ['analyze', 'validate']
     * - 'public-async' to auto-include all public async methods
     * - 'all' to include all methods (not recommended)
     */
    callable?: string[] | 'public-async' | 'all';

    /**
     * Methods to exclude from AI calling (higher priority than callable)
     */
    exclude?: string[];

    /**
     * Additional tool descriptions to override method JSDoc
     */
    descriptions?: Record<string, string>;
  };

  /**
   * Lifecycle hooks
   */
  hooks?: {
    beforeSave?: string | ((instance: any) => Promise<void>);
    afterSave?: string | ((instance: any) => Promise<void>);
    beforeCreate?: string | ((instance: any) => Promise<void>);
    afterCreate?: string | ((instance: any) => Promise<void>);
    beforeUpdate?: string | ((instance: any) => Promise<void>);
    afterUpdate?: string | ((instance: any) => Promise<void>);
    beforeDelete?: string | ((instance: any) => Promise<void>);
    afterDelete?: string | ((instance: any) => Promise<void>);
  };

  /**
   * Embedding configuration for semantic search
   *
   * Enable vector embeddings on this class for similarity search.
   * Project-level defaults come from smrt.config embeddings section.
   *
   * @example
   * ```typescript
   * @smrt({
   *   embeddings: {
   *     fields: ['title', 'body'],
   *     autoGenerate: true
   *   }
   * })
   * class Article extends SmrtObject {
   *   title: string = '';
   *   body: string = '';
   * }
   * ```
   */
  embeddings?: {
    /**
     * Fields to generate embeddings for
     * Each field gets its own embedding vector stored in _smrt_embeddings
     */
    fields: string[];

    /**
     * Override project-level embedding provider
     * - 'local': Use local Node.js model (@xenova/transformers)
     * - 'ai': Use AI library (OpenAI, etc.)
     * - 'auto': Try local first, fallback to AI
     */
    provider?: 'local' | 'ai' | 'auto';

    /**
     * Automatically generate embeddings on save
     * Only regenerates when content changes (via content hash)
     * @default true
     */
    autoGenerate?: boolean;

    /**
     * Regenerate embeddings when field content changes
     * Uses content hash comparison to detect changes
     * @default true
     */
    regenerateOnChange?: boolean;

    /**
     * Create a combined embedding from multiple fields
     * Useful for holistic similarity search across an object
     *
     * @example
     * ```typescript
     * combinedField: {
     *   name: 'content',
     *   template: '{title}\n\n{body}'
     * }
     * ```
     */
    combinedField?: {
      /** Field name for the combined embedding */
      name: string;
      /** Template with {fieldName} placeholders */
      template: string;
    };
  };

  /**
   * Multi-tenancy configuration
   *
   * Enable automatic tenant isolation for this class.
   * When enabled, a `tenantId` field is auto-injected and queries are
   * automatically filtered by tenant context.
   *
   * Requires `@happyvertical/smrt-tenancy` package to be installed
   * and `enableTenancy()` to be called at app startup.
   *
   * @example Simple boolean flag (uses defaults)
   * ```typescript
   * @smrt({ tenantScoped: true })
   * class Account extends SmrtObject {
   *   // tenantId field auto-injected
   *   name: string = '';
   * }
   * ```
   *
   * @example With custom options
   * ```typescript
   * @smrt({
   *   tenantScoped: {
   *     mode: 'optional',  // Works with or without tenant context
   *     allowSuperAdminBypass: true
   *   }
   * })
   * class AuditLog extends SmrtObject { }
   * ```
   *
   * @see https://github.com/happyvertical/smrt/issues/688
   */
  tenantScoped?:
    | boolean
    | {
        /**
         * Tenancy mode for this class
         * - 'required': Must have tenant context for all operations (default)
         * - 'optional': Works with or without tenant context
         * @default 'required'
         */
        mode?: 'required' | 'optional';

        /**
         * Field name for the tenant ID
         * @default 'tenantId'
         */
        field?: string;

        /**
         * Auto-filter all queries by tenant
         * @default true
         */
        autoFilter?: boolean;

        /**
         * Auto-populate tenant ID from context on create
         * @default true
         */
        autoPopulate?: boolean;

        /**
         * Allow super admin bypass for this class
         * @default false
         */
        allowSuperAdminBypass?: boolean;
      };

  /**
   * Agent metadata configuration
   *
   * Only relevant for classes extending Agent. Provides metadata
   * that the manifest build uses to auto-generate permissions, features,
   * menu items, and component declarations.
   *
   * @example
   * ```typescript
   * @smrt({
   *   tableName: 'praecos',
   *   agent: {
   *     icon: 'newspaper',
   *     tier: 'standard',
   *     description: 'Council meeting coverage and article generation',
   *   },
   *   cli: { include: ['discover', 'fetch', 'analyze'] },
   * })
   * export class Praeco extends Agent { }
   * ```
   */
  agent?: {
    /** Icon identifier (e.g., 'newspaper', 'cloud', 'git-branch') */
    icon?: string;
    /** Billing tier: 'free' | 'standard' | 'premium' */
    tier?: 'free' | 'standard' | 'premium';
    /** Human-readable description of the agent */
    description?: string;
  };

  /**
   * Synchronous manifest for build-time imports (Issue #270 Phase 1)
   * Allows passing manifest directly instead of async loading
   * @internal Advanced usage - typically set by build tools
   */
  _manifest?: SmartObjectManifest;
}

/**
 * Validation function that takes an object instance and returns
 * a ValidationError if validation fails, or null if validation passes
 */
export type ValidatorFunction = (
  instance: any,
) => Promise<import('../errors').ValidationError | null>;

/**
 * Relationship type for the relationship map
 */
export type RelationshipType = 'foreignKey' | 'oneToMany' | 'manyToMany';

/**
 * Metadata about a relationship between classes
 */
export interface RelationshipMetadata {
  /** Source class name */
  sourceClass: string;
  /** Field name on the source class */
  fieldName: string;
  /** Target/related class name */
  targetClass: string;
  /** Type of relationship */
  type: RelationshipType;
  /** Options for the relationship (onDelete, etc.) */
  options: any;
}

/**
 * Internal representation of a registered SMRT class
 *
 * @interface RegisteredClass
 */
export interface RegisteredClass {
  /**
   * Simple class name (e.g., "Product")
   */
  name: string;

  /**
   * Qualified class name in format "@package/name:ClassName"
   * This is the PRIMARY KEY for registry lookups.
   * Example: "@happyvertical/smrt-core:Product"
   */
  qualifiedName?: QualifiedClassName;

  constructor: typeof SmrtObject;
  collectionConstructor?: new (options: any) => SmrtCollection<any>;
  config: SmartObjectConfig;
  fields: Map<string, any>;
  /** Method definitions from manifest (for custom CLI/API/MCP generation) */
  methods: Map<string, any>;
  /** Cached schema definition generated during registration */
  schema?: SchemaDefinition;
  /** Compiled validation functions for efficient runtime validation */
  validators?: ValidatorFunction[];
  /**
   * Pre-computed validation rules from manifest (Issue #782)
   * When available, these are used instead of compiling validator closures,
   * significantly reducing CLI startup time.
   */
  validationRules?: ValidationRule[];
  /** AI-callable tools generated from methods at build time */
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: Record<string, any>;
    };
  }>;
  /** Package name from manifest (for external package classes) */
  packageName?: string;
  /** Source file path where the class was defined (for collision detection) */
  sourceFilePath?: string;
  /** Parent class name (for inheritance chain tracking) */
  extends?: string;
  /** Full inheritance chain from base to this class (cached for performance) */
  inheritanceChain?: string[];
  /** Merged fields from entire inheritance chain (cached, includes parent fields) */
  inheritedFields?: Map<string, any>;
  /** Merged methods from entire inheritance chain (cached, includes parent methods) */
  inheritedMethods?: Map<string, any>;
  /** Normalized tenant scoping configuration (Issue #688) */
  tenantScopedConfig?: {
    mode: 'required' | 'optional';
    field: string;
    autoFilter: boolean;
    autoPopulate: boolean;
    allowSuperAdminBypass: boolean;
  };
  /**
   * Visibility control for manifest inclusion
   * - 'public': Included in published manifest (default)
   * - 'internal': Package-only, excluded from published manifest
   * - 'test': Test-only, never in any published manifest
   */
  visibility?: SmrtVisibility;
}
