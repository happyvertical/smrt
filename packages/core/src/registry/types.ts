/**
 * Type definitions for the SMRT ObjectRegistry.
 *
 * Extracted from registry.ts as part of issue #1006
 * (Split ObjectRegistry into focused modules).
 *
 * @see https://github.com/happyvertical/smrt/issues/1006
 */

import type { DomainKnowledgeConfig } from '@happyvertical/smrt-types';
import type { SmrtCollection } from '../collection';
import type { CollectionCacheConfig } from '../collection-cache';
import type { SmrtObject } from '../object';
import type {
  FieldDefinition,
  FieldMeta,
  MethodDefinition,
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

export interface ApiSerializerReference {
  /**
   * Module specifier to import the serializer from.
   *
   * Supports package imports and project aliases such as `$lib/...`.
   */
  importPath: string;

  /**
   * Named export to use as the serializer function.
   */
  exportName: string;
}

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

export interface ApiSerializersConfig {
  /**
   * Custom serializers REPLACE the framework's default `toPublicJSON()`
   * serialization on generated routes. Security (#1540): when you supply a
   * serializer you are responsible for excluding `@field({ sensitive: true })`
   * fields — a serializer that returns `item.toJSON()` (or spreads all fields)
   * will leak secrets that the default path would have stripped.
   */

  /**
   * Serializer used for standard item responses (`get`, `create`, `update`).
   */
  item?: ApiSerializerReference;

  /**
   * Serializer used for standard list responses.
   *
   * When omitted, SMRT falls back to `item` for each list entry.
   */
  listItem?: ApiSerializerReference;
}

export interface ApiConfig {
  /**
   * Optional collection path override for generated CRUD routes.
   *
   * When omitted, SMRT derives the path from `tableName` by replacing `_` with `-`.
   * This remains the supported way to keep legacy/public route shapes stable when
   * the storage table name differs from the desired URL segment.
   */
  path?: string;

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
  middleware?: unknown[];

  /**
   * Custom endpoint handlers (supports both standard CRUD actions and custom methods)
   */
  customize?: Record<
    string,
    (req: unknown, collection: SmrtCollection<SmrtObject>) => Promise<unknown>
  >;

  /**
   * Route metadata for custom API methods.
   * Lets generated routes declare collection-vs-item scope, HTTP verb, and path.
   */
  routes?: Record<string, ApiCustomRouteConfig>;

  /**
   * Optional serializers for standard generated CRUD responses.
   * Useful when item JSON needs async enrichment beyond `transformJSON()`.
   */
  serializers?: ApiSerializersConfig;

  /**
   * Authorization posture for generated CRUD routes (fail-closed by default).
   *
   * Generated REST / MCP / SvelteKit routes require an authenticated principal
   * on `locals` (e.g. `locals.user` / `locals.session`) unless this opts out:
   * - `false` (default): every route requires authentication — reads and writes.
   * - `true`: all routes are public (no auth required). Use only for genuinely
   *   public data.
   * - `'read'`: read routes (`list`/`get`) are public, but mutating routes
   *   (`create`/`update`/`delete`) still require authentication.
   *
   * This is a security default: omitting it means the routes are protected.
   */
  public?: boolean | 'read';

  /**
   * Allowlist of field names that may be set from the request body on generated
   * `create`/`update` routes.
   *
   * When set, only these fields are accepted; everything else in the body is
   * dropped. Regardless of this list, framework/server-managed fields (`id`,
   * `tenantId`, timestamps, `_`-prefixed) and `@field({ readonly: true })`
   * fields are always stripped to prevent mass-assignment.
   */
  writable?: string[];
}

export interface ReportConfig {
  source: string | Function;
  where?: Record<string, unknown> | Record<string, unknown>[][];
  having?: Record<string, unknown> | Record<string, unknown>[][];
  refresh?: {
    mode?: 'rebuild' | 'incremental';
    schedule?: string;
    onChange?: Array<string | Function>;
    ttl?: number;
    manual?: boolean;
    watermarkColumn?: string;
    softDeleteColumn?: string;
    fullRebuildSchedule?: string;
    tenantFanout?: boolean;
  };
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
   * Storage type for the synthetic `id` primary key (defaults to 'uuid').
   *
   * Use 'text' only for models that intentionally generate non-UUID ids.
   * On SQLite, UUID maps to TEXT at DDL render time because SQLite has no
   * native UUID type.
   */
  idType?: 'uuid' | 'text';

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
   * Opt-in read-through cache for collection reads (issue #1498).
   *
   * When set, `collection.list()` and `collection.get()` memoize result
   * rows for `ttl` milliseconds. Mutations through SMRT (`save()`,
   * `delete()`, `collection.create()`, `getOrUpsert()`, junction
   * attach/detach) automatically invalidate the table's cached entries
   * in-process. With `crossProcess: true`, invalidations also broadcast to
   * peer replicas via the database adapter's notification capability
   * (e.g. Postgres LISTEN/NOTIFY) when the adapter provides one.
   *
   * Defaults to off — caching is opinionated and silently serving stale
   * rows would be a footgun. Children inherit the nearest ancestor's
   * setting; set `cache: false` on a child to opt back out. Per-call
   * options override this: `list({ cache: false })` forces a fresh read,
   * `list({ cache: { ttl } })` enables caching for that call only.
   *
   * @example
   * ```typescript
   * @smrt({ cache: { ttl: 60_000 } })
   * class Product extends SmrtObject {
   *   name: string = '';
   * }
   * ```
   */
  cache?: CollectionCacheConfig | false;

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
   * Agent/developer knowledge metadata.
   *
   * Set to false to exclude this object from generated smrt-knowledge.json
   * without changing runtime manifest registration. Object-level metadata
   * augments package-level knowledge defaults from smrt.config.
   */
  knowledge?: false | Pick<DomainKnowledgeConfig, 'tags' | 'summary' | 'risks'>;

  /**
   * Report/materialized aggregate metadata. Usually produced by the
   * `@report()` decorator from `@happyvertical/smrt-reports`.
   */
  report?: ReportConfig;

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

        /**
         * Skip the build-time check that every `cli.include` method is also
         * exposed via the API. Set this for classes whose CLI is invoked
         * in-process (e.g. admin/security tools intentionally without HTTP
         * routes) rather than over HTTP.
         */
        skipApiCheck?: boolean;

        /**
         * Whether this CLI surface should be advertised through HTTP discovery
         * (`GET /api/_resources`) for `@happyvertical/smrt-app-cli`.
         *
         * Set to `false` for package-internal or in-process CLI resources that
         * may still be useful to local generators but do not have app HTTP
         * routes in downstream deployments.
         */
        http?: boolean;
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
    beforeSave?: string | ((instance: SmrtObject) => Promise<void>);
    afterSave?: string | ((instance: SmrtObject) => Promise<void>);
    beforeCreate?: string | ((instance: SmrtObject) => Promise<void>);
    afterCreate?: string | ((instance: SmrtObject) => Promise<void>);
    beforeUpdate?: string | ((instance: SmrtObject) => Promise<void>);
    afterUpdate?: string | ((instance: SmrtObject) => Promise<void>);
    beforeDelete?: string | ((instance: SmrtObject) => Promise<void>);
    afterDelete?: string | ((instance: SmrtObject) => Promise<void>);
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
   * Code-owned feature toggle declarations for this class.
   *
   * Feature definitions live in code and can be synced into runtime metadata
   * stores by downstream packages (for example `@happyvertical/smrt-features`).
   * Each feature is identified by a class-local key that becomes part of the
   * canonical feature key `<qualifiedClassName>#<localId>`.
   *
   * V1 supports boolean flags only.
   */
  features?: Record<
    string,
    {
      /**
       * Default enabled state before runtime overrides are applied.
       */
      defaultEnabled: boolean;

      /**
       * Human-friendly label for admin UIs and generated docs.
       */
      label?: string;

      /**
       * Optional description explaining what the feature does.
       */
      description?: string;

      /**
       * Additional code-owned metadata for applications.
       */
      metadata?: Record<string, unknown>;
    }
  >;

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
   * Optional UI hints consumed by `@happyvertical/smrt-svelte`'s
   * `navTreeFromManifest()` helper (and any other manifest → admin-UI
   * adapters). The framework itself never reads these — they round-trip
   * through the generated manifest as plain data, letting consumers
   * declare icon glyphs / labels next to the model rather than in a
   * separate hand-written nav config.
   *
   * Kept deliberately minimal. Adding apparel-specific terminology or
   * design-system-specific shapes here would couple the framework to a
   * vertical; consumers that need richer hints should layer their own
   * adapter on top.
   *
   * @example
   * ```typescript
   * @smrt({
   *   ui: { icon: 'newspaper', label: 'News articles' },
   * })
   * class Article extends SmrtObject { ... }
   * ```
   */
  ui?: {
    /**
     * Icon identifier / glyph / emoji passed straight through to
     * generated nav entries. Interpretation is consumer-defined — the
     * framework only persists the string.
     */
    icon?: string;
    /**
     * Override the auto-pluralized label used for generated nav entries
     * (e.g. `Article` → "Articles"). Leave undefined to use the default.
     */
    label?: string;
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
  instance: SmrtObject,
) => Promise<import('../errors').ValidationError | null>;

/**
 * Relationship type for the relationship map
 */
export type RelationshipType =
  | 'foreignKey'
  | 'crossPackageRef'
  | 'oneToMany'
  | 'manyToMany';

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
  /** Options for the relationship (onDelete, etc.) — sourced from `field._meta`. */
  options: FieldMeta | undefined;
}

/**
 * Runtime shape of a field stored in a {@link RegisteredClass} `fields` /
 * `inheritedFields` map.
 *
 * This is a {@link FieldDefinition} superset: registration
 * (`class-registration.ts`) and the manifest-field merge helpers build these
 * objects by folding decorator options into the AST-scanned field, which
 * attaches a few extra runtime-only members beyond the scanner contract:
 *
 * - `options`: legacy mirror of the decorator option bag, persisted into the
 *   `_smrt_registry` snapshot row (see `registry.ts` `saveRegistry`).
 * - `validate`: optional cross-package-ref validation hint read off either the
 *   field or its `_meta` bag (`object.ts` `validateCrossPackageRefs`).
 * - `__report`: report-aggregate marker mirrored at the top level for the
 *   report conflict-column derivation (`registry.ts`).
 * - `idType`: synthetic-id storage override mirrored at the top level
 *   (decorator bags; also read off `_meta.idType` in `schema-builder.ts`).
 * - `value`: runtime field value carried through the inheritance-chain merge
 *   (`inheritance-resolver.ts` `mergeFieldConfigs`).
 *
 * This is the single canonical runtime-field shape: the manifest-merge helpers
 * (`manifest-field-merge.ts`) and the inheritance-chain merge
 * (`inheritance-resolver.ts`) both alias this type, so registered fields flow
 * through one definition instead of drifting per-module supersets.
 *
 * The index signature keeps the bag open for forward-compatible runtime keys
 * without forcing consumers back through `any`.
 */
export interface RegisteredField extends FieldDefinition {
  /** Legacy decorator option bag mirrored at the top level. */
  options?: Record<string, unknown>;
  /** Cross-package-ref validation hint (also looked up under `_meta`). */
  validate?: unknown;
  /** Report-aggregate marker mirrored from `_meta.__report`. */
  __report?: FieldMeta['__report'];
  /** Tenancy marker mirrored at the top level on decorator option bags. */
  __tenancy?: FieldMeta['__tenancy'];
  /** Explicit SQL type override mirrored at the top level (decorator bags). */
  sqlType?: string;
  /** Synthetic-id storage override mirrored at the top level (decorator bags). */
  idType?: 'uuid' | 'text';
  /** Runtime field value carried through the inheritance-chain merge. */
  value?: unknown;
  [key: string]: unknown;
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
  /**
   * Collection constructor for this class.
   *
   * The `options` param and `SmrtCollection<any>` element type are left as
   * `any` deliberately (S4 #1579): this slot is assigned from `typeof
   * SmrtCollection` (a generic constructor whose `options?` is contravariant)
   * AND instantiated by generators that pass a loosely-typed context bag
   * (`{ ai, db }` where `context.ai` is `unknown`). A precise `options` type
   * breaks the call sites; a precise element type breaks the assignment from
   * `typeof SmrtCollection`. This mirrors the `SmrtObjectConstructor` escape
   * hatch above.
   */
  collectionConstructor?: new (
    options: any,
  ) => SmrtCollection<any>;
  config: SmartObjectConfig;
  fields: Map<string, RegisteredField>;
  /** Method definitions from manifest (for custom CLI/API/MCP generation) */
  methods: Map<string, MethodDefinition>;
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
      parameters?: Record<string, unknown>;
    };
  }>;
  /** Package name from manifest (for external package classes) */
  packageName?: string;
  /** Source file path where the class was defined (for collision detection) */
  sourceFilePath?: string;
  /**
   * Pluralized endpoint/collection name from the manifest (e.g. `sourcecrawls`
   * for `SourceCrawl`). This is the segment the SvelteKit route generator
   * uses for `/api/<collection>/...`, and it is NOT the same as `tableName`
   * (which is snake_case and can be overridden/uncountable). Stored here so
   * runtime consumers (e.g. `createResourceListHandler`) can build URLs that
   * match the generated routes instead of re-deriving from `tableName`.
   * See smrt#1311 consumer-migration finding.
   */
  collection?: string;
  /** Parent class name (for inheritance chain tracking) */
  extends?: string;
  /** Generic type arg from `SmrtCollection<X>` — marks collection classes. */
  extendsTypeArg?: string;
  /** Full inheritance chain from base to this class (cached for performance) */
  inheritanceChain?: string[];
  /** Merged fields from entire inheritance chain (cached, includes parent fields) */
  inheritedFields?: Map<string, RegisteredField>;
  /** Merged methods from entire inheritance chain (cached, includes parent methods) */
  inheritedMethods?: Map<string, MethodDefinition>;
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
