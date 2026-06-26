/**
 * Manifest Adapter
 *
 * Converts OXC scanner output to smrt-core manifest format.
 * Ensures compatibility with existing manifest consumers.
 */

import { isSafeObjectKey } from './oxc-parser.js';
import type {
  FieldTypeInference,
  InferredFieldType,
  RawFieldDefinition,
  RawMethodDefinition,
  ResolvedClassDefinition,
} from './types.js';

// ============================================================================
// smrt-core compatible types (copied to avoid circular dependency)
// ============================================================================

/**
 * Qualified class name format: "@package/name:ClassName"
 * Uniquely identifies classes across packages.
 */
type QualifiedClassName = `${string}:${string}`;

interface FieldDefinition {
  type:
    | 'text'
    | 'decimal'
    | 'boolean'
    | 'integer'
    | 'datetime'
    | 'json'
    | 'foreignKey'
    | 'crossPackageRef'
    | 'oneToMany'
    | 'manyToMany'
    | 'meta';
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  maxLength?: number;
  minLength?: number;
  related?: string;
  description?: string;
  _meta?: Record<string, unknown>;
  transient?: boolean;
  /** Sensitive value — excluded from public serialization + where filtering. */
  sensitive?: boolean;
  /** Read-only over generated write surfaces — stripped from create/update bodies. */
  readonly?: boolean;
}

type FieldDecoratorOptions = {
  type?: FieldDefinition['type'];
  required?: boolean;
  nullable?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  maxLength?: number;
  minLength?: number;
  related?: string;
  /** oneToMany explicit inverse foreign-key field on the target class */
  foreignKey?: string;
  description?: string;
  transient?: boolean;
  unique?: boolean;
  /** crossPackageRef opt-in save-time validation */
  validate?: boolean;
  /** manyToMany junction table name */
  through?: string;
  /** manyToMany override of the source-side join column */
  sourceKey?: string;
  /** manyToMany override of the target-side join column */
  targetKey?: string;
  /** meta opt-in JSON-path index */
  indexed?: boolean;
  /** sensitive value — excluded from public serialization + where filtering */
  sensitive?: boolean;
  /** read-only over generated write surfaces */
  readonly?: boolean;
  /** report grouping/bucket/aggregate metadata */
  __report?: Record<string, unknown>;
  [key: string]: unknown;
};

interface MethodDefinition {
  name: string;
  async: boolean;
  parameters: Array<{
    name: string;
    type: string;
    optional: boolean;
    default?: unknown;
  }>;
  returnType: string;
  description?: string;
  isStatic: boolean;
  isPublic: boolean;
}

interface SmartObjectConfig {
  tableStrategy?: 'sti' | 'cti';
  idType?: 'uuid' | 'text';
  features?: Record<
    string,
    {
      defaultEnabled: boolean;
      label?: string;
      description?: string;
      metadata?: Record<string, unknown>;
    }
  >;
  api?: {
    include?: string[];
    exclude?: string[];
  };
  cli?:
    | boolean
    | {
        include?: string[];
        exclude?: string[];
        skipApiCheck?: boolean;
        http?: boolean;
      };
  mcp?: {
    include?: string[];
    exclude?: string[];
  };
  [key: string]: unknown;
}

interface SmartObjectDefinition {
  name: string;
  className: string;
  qualifiedName?: QualifiedClassName; // NEW: @package/name:ClassName for namespace isolation (Issue #713)
  collection: string;
  filePath: string;
  packageName?: string;
  packageVersion?: string;
  importPath?: string;
  modulePath?: string;
  exportName?: string;
  collectionExportName?: string;
  fields: Record<string, FieldDefinition>;
  methods: Record<string, MethodDefinition>;
  decoratorConfig: SmartObjectConfig;
  extends?: string;
  extendsTypeArg?: string;
  staticProperties?: Record<string, unknown>;
}

interface SmartObjectManifest {
  version: string;
  timestamp: number;
  packageName?: string;
  packageVersion?: string;
  objects: Record<string, SmartObjectDefinition>;
  moduleType?: string;
  smrtDependencies?: string[];
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Property keys that must never appear as own properties on a manifest object.
 * Object literals authored as `{ constructor: ... }` or `{ prototype: ... }`
 * produce real own keys; spreading such a parsed object into a manifest
 * `_meta` / `staticProperties` entry (or assigning it under a class field name)
 * would carry a prototype-pollution gadget into the emitted JSON.
 */
/**
 * Recursively strip prototype-pollution keys (via the shared
 * {@link isSafeObjectKey} guard — single source of truth with oxc-parser) from a
 * value parsed out of source. Returns a new plain object/array; primitives and
 * built-in objects pass through unchanged.
 */
function sanitizeParsed(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;

  const isArray = Array.isArray(value);
  // Preserve built-ins (Date, RegExp, Map, …) intact. They carry no
  // attacker-controlled own keys, and iterating their enumerable keys would
  // silently turn e.g. `@field({ default: new Date() })` into `{}` (review #1559).
  const proto = Object.getPrototypeOf(value);
  if (!isArray && proto !== Object.prototype && proto !== null) return value;

  // Cycle guard: a cyclic literal (e.g. an IIFE returning a self-referential
  // object) would otherwise recurse forever and hang the build (review #1559).
  if (seen.has(value as object)) return undefined;
  seen.add(value as object);

  if (isArray) {
    return (value as unknown[]).map((item) => sanitizeParsed(item, seen));
  }
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!isSafeObjectKey(key)) continue;
    clean[key] = sanitizeParsed((value as Record<string, unknown>)[key], seen);
  }
  return clean;
}

/**
 * Parse a JavaScript literal (object or array) from source text.
 *
 * Uses the Function constructor to evaluate literal syntax at build time.
 * This is intentional — AST-based extraction can't handle computed keys,
 * template literals, or spread syntax that may appear in static initializers.
 *
 * The parsed result is run through {@link sanitizeParsed} to strip
 * prototype-pollution keys (`__proto__` / `constructor` / `prototype`) before
 * it is merged into a manifest object.
 *
 * WARNING: This executes the source text. It is only safe when scanning
 * your own trusted codebase at build time. Never run the scanner against
 * untrusted third-party code.
 */
function parseLiteralInitializer(
  source: string,
): Record<string, unknown> | unknown[] | null {
  const trimmed = source?.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('[')))
    return null;
  try {
    // Use indirect eval via Function to parse the object/array literal
    // This runs at build time only, on trusted source code from our own codebase
    // The existing pattern (unchanged) uses Function constructor for object literal parsing
    // eslint-disable-next-line no-new-func
    const parsed = new Function(`return (${source})`)() as
      | Record<string, unknown>
      | unknown[];
    return sanitizeParsed(parsed) as Record<string, unknown> | unknown[];
  } catch {
    return null;
  }
}

/**
 * Strip surrounding quotes from a raw source string.
 * sliceSource() returns raw source text which includes quotes for string
 * literals (e.g., "'TestProfile'" or '"TestProfile"').
 */
function stripQuotes(value: string | undefined): string | undefined {
  if (!value) return value;
  const match = value.match(/^(['"`])(.+)\1$/);
  return match ? match[2] : value;
}

// ============================================================================
// Manifest Adapter
// ============================================================================

/**
 * Create a qualified name for a class (namespace isolation - Issue #713)
 * Format: @package/name:ClassName
 */
function createQualifiedName(
  packageName: string,
  className: string,
): QualifiedClassName {
  return `${packageName}:${className}` as QualifiedClassName;
}

/**
 * Converts OXC scanner output into the smrt-core `SmartObjectManifest` format
 * consumed by code generators, the Vitest plugin, and the SMRT CLI.
 *
 * The adapter handles field type inference (applying the `0` vs `0.0` integer /
 * decimal heuristic), decorator interpretation (`@foreignKey`, `@oneToMany`,
 * `@manyToMany`, `@field`), type alias resolution, STI `Meta<T>` unwrapping,
 * static property capture (`uiSlots`, `adminRoutes`), and qualified name
 * generation for namespace isolation across packages.
 *
 * @example
 * ```typescript
 * import { OxcScanner, ManifestAdapter } from '@happyvertical/smrt-scanner';
 *
 * const scanner = new OxcScanner({ cwd: process.cwd() });
 * const { results, resolved } = await scanner.scanAndResolve();
 *
 * const adapter = new ManifestAdapter();
 * const manifest = adapter.toManifest(resolved, {
 *   packageName: '@my-org/my-package',
 *   packageVersion: '1.0.0',
 *   typeAliases: results.typeAliases,
 * });
 * ```
 *
 * @see {@link OxcScanner} for producing the `ResolvedClassDefinition[]` input.
 * @see {@link ResolvedClassDefinition} for the shape of each input element.
 */
export class ManifestAdapter {
  private typeAliases: Record<string, string> = {};
  private _aliasDepth?: number;

  /**
   * Convert an array of resolved class definitions into a `SmartObjectManifest`.
   *
   * Each class is converted to a `SmartObjectDefinition` via
   * {@link toSmartObjectDefinition} and stored under its qualified name key
   * (e.g. `@my-org/my-package:MyClass`) when `packageName` is provided, or
   * under its lowercased class name otherwise.
   *
   * @param resolved - Resolved class definitions from {@link OxcScanner.resolve}
   *   or {@link OxcScanner.scanAndResolve}.
   * @param options.packageName - npm package name used to generate qualified
   *   class names for namespace isolation across multi-package projects.
   * @param options.packageVersion - Package version recorded in the manifest
   *   metadata.
   * @param options.typeAliases - Map of type alias names to their resolved type
   *   strings (from {@link ScanResults.typeAliases}).  Used to resolve custom
   *   types like `type Status = 'active' | 'inactive'` during field inference.
   * @returns A complete `SmartObjectManifest` ready for serialisation.
   *
   * @example
   * ```typescript
   * const manifest = adapter.toManifest(resolved, {
   *   packageName: '@my-org/my-package',
   *   packageVersion: '1.0.0',
   *   typeAliases: results.typeAliases,
   * });
   * fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, 2));
   * ```
   */
  toManifest(
    resolved: ResolvedClassDefinition[],
    options: {
      packageName?: string;
      packageVersion?: string;
      typeAliases?: Record<string, string>;
    } = {},
  ): SmartObjectManifest {
    this.typeAliases = options.typeAliases || {};
    const objects: Record<string, SmartObjectDefinition> = {};

    for (const classDef of resolved) {
      const definition = this.toSmartObjectDefinition(classDef, options);

      // Use qualified name as key if packageName is available (Issue #713)
      // This enables namespace isolation for multi-package scenarios
      const manifestKey =
        definition.qualifiedName || definition.name.toLowerCase();
      objects[manifestKey] = definition;
    }

    return {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName: options.packageName,
      packageVersion: options.packageVersion,
      objects,
      moduleType: 'smrt',
    };
  }

  /**
   * Convert a single resolved class definition to a `SmartObjectDefinition`.
   *
   * Handles:
   * - Static property capture (`uiSlots`, `adminRoutes`) with child-wins
   *   semantics for overridden statics.
   * - Field conversion (non-static public fields only) via {@link convertField}.
   * - Method conversion (public instance/static methods) via {@link convertMethod}.
   * - Collection name pluralisation.
   * - Qualified name generation when `packageName` is supplied.
   *
   * @param classDef - A fully-resolved class definition.
   * @param options.packageName - Package name used to build the qualified class
   *   name (`@pkg:ClassName`).
   * @param options.packageVersion - Package version (informational, stored in
   *   the definition).
   * @returns A `SmartObjectDefinition` ready to be stored in a manifest.
   *
   * @see {@link toManifest} for the bulk conversion entry point.
   */
  toSmartObjectDefinition(
    classDef: ResolvedClassDefinition,
    options: { packageName?: string; packageVersion?: string } = {},
  ): SmartObjectDefinition {
    // Extract static properties (e.g., uiSlots, adminRoutes on Agent subclasses)
    // Use own fields (classDef.fields) not allFields — static properties use
    // child-wins semantics (static override), not parent-wins like STI columns.
    // Fall back to allFields for inherited static props not redeclared by child.
    let staticProperties: Record<string, unknown> | undefined;
    const knownStaticProps = ['uiSlots', 'adminRoutes', 'signalSubscriptions'];
    const ownStaticNames = new Set<string>();
    // First pass: own fields (child overrides win)
    for (const field of classDef.fields) {
      if (
        field.isStatic &&
        knownStaticProps.includes(field.name) &&
        field.initializer
      ) {
        try {
          const parsed = parseLiteralInitializer(field.initializer);
          if (parsed) {
            if (!staticProperties) staticProperties = {};
            staticProperties[field.name] = parsed;
            ownStaticNames.add(field.name);
          }
        } catch {
          // Failed to parse static property initializer — skip
        }
      }
    }
    // Second pass: inherited fields for any static props not overridden
    for (const field of classDef.allFields) {
      if (
        field.isStatic &&
        knownStaticProps.includes(field.name) &&
        field.initializer
      ) {
        if (ownStaticNames.has(field.name)) continue;
        try {
          const parsed = parseLiteralInitializer(field.initializer);
          if (parsed) {
            if (!staticProperties) staticProperties = {};
            staticProperties[field.name] = parsed;
          }
        } catch {
          // Failed to parse static property initializer — skip
        }
      }
    }

    // Convert fields (skip static fields — they're not database columns)
    const fields: Record<string, FieldDefinition> = {};
    for (const field of classDef.allFields) {
      if (field.isStatic) continue;
      const converted = this.convertField(field);
      if (converted) {
        fields[field.name] = converted;
      }
    }

    // Convert methods
    const methods: Record<string, MethodDefinition> = {};
    for (const method of classDef.methods) {
      const converted = this.convertMethod(method);
      if (converted) {
        methods[method.name] = converted;
      }
    }

    // Generate collection name (pluralize)
    const collection = this.pluralize(classDef.className);

    // Determine package name (prefer option, then classDef value)
    const packageName = options.packageName || classDef.packageName;

    // Generate qualified name if packageName is available (Issue #713)
    // Format: @package/name:ClassName for namespace isolation
    const qualifiedName = packageName
      ? createQualifiedName(packageName, classDef.className)
      : undefined;

    return {
      name: classDef.className.toLowerCase(),
      className: classDef.className,
      qualifiedName,
      collection,
      filePath: classDef.filePath,
      packageName: packageName || undefined,
      fields,
      methods,
      decoratorConfig: (classDef.decoratorConfig || {}) as SmartObjectConfig,
      extends: classDef.extendsClause || undefined,
      extendsTypeArg: classDef.extendsTypeArg || undefined,
      exportName: classDef.className,
      collectionExportName: `${classDef.className}Collection`,
      staticProperties,
    };
  }

  /**
   * Framework internal fields that should NOT be included in manifests
   * These are SmrtObject internals used by the framework, not user-defined fields
   */
  private static readonly FRAMEWORK_INTERNAL_FIELDS = new Set([
    '_tableName',
    'options',
    '_loadedRelationships',
    '_db',
    '_ai',
    '_fs',
    '_isInitialized',
    '_errors',
    '_warnings',
  ]);

  /**
   * Convert a single raw field definition to a manifest `FieldDefinition`.
   *
   * Returns `null` for fields that should be omitted from the manifest:
   * - `private` or `protected` fields.
   * - Framework-internal fields (`_tableName`, `_db`, `_ai`, etc.).
   *
   * Delegates type inference to {@link inferFieldType} and applies additional
   * post-processing:
   * - Marks fields with `Function` type annotation as `transient`.
   * - Marks fields with `@field({ transient: true })` decorator as `transient`.
   * - Populates `_meta.underlyingType` for STI `Meta<T>` fields.
   *
   * @param field - Raw field definition from a scanned class.
   * @returns A `FieldDefinition` for the manifest, or `null` if the field
   *   should be excluded.
   *
   * @see {@link inferFieldType} for the type inference logic.
   */
  convertField(field: RawFieldDefinition): FieldDefinition | null {
    // Skip private/protected fields
    if (field.accessibility !== 'public') {
      return null;
    }

    // Skip framework internal fields (SmrtObject internals)
    if (ManifestAdapter.FRAMEWORK_INTERNAL_FIELDS.has(field.name)) {
      return null;
    }

    // Check if field is a function type (automatically transient)
    const isFunctionType = field.typeAnnotation === 'Function';
    const fieldDecoratorOptions = this.extractFieldDecoratorOptions(field);

    const inference = this.inferFieldType(field);

    const definition: FieldDefinition = {
      type: inference.type as FieldDefinition['type'],
      required: inference.required,
    };

    if (inference.related) {
      definition.related = inference.related;
    }

    if (inference.defaultValue !== undefined) {
      definition.default = inference.defaultValue;
    }

    // Apply generic @field({...}) options to preserve manifest metadata used by
    // schema generation and runtime decorator merging.
    if (fieldDecoratorOptions.type) {
      definition.type = fieldDecoratorOptions.type;
    }

    if (fieldDecoratorOptions.nullable === true) {
      definition.required = false;
    } else if (fieldDecoratorOptions.required !== undefined) {
      definition.required = fieldDecoratorOptions.required;
    }

    if (fieldDecoratorOptions.default !== undefined) {
      definition.default = fieldDecoratorOptions.default;
    }

    if (fieldDecoratorOptions.related !== undefined) {
      definition.related = fieldDecoratorOptions.related;
    }

    if (fieldDecoratorOptions.description !== undefined) {
      definition.description = fieldDecoratorOptions.description;
    }

    if (fieldDecoratorOptions.min !== undefined) {
      definition.min = fieldDecoratorOptions.min;
    }

    if (fieldDecoratorOptions.max !== undefined) {
      definition.max = fieldDecoratorOptions.max;
    }

    if (fieldDecoratorOptions.minLength !== undefined) {
      definition.minLength = fieldDecoratorOptions.minLength;
    }

    if (fieldDecoratorOptions.maxLength !== undefined) {
      definition.maxLength = fieldDecoratorOptions.maxLength;
    }

    if (Object.keys(fieldDecoratorOptions).length > 0) {
      definition._meta = {
        ...definition._meta,
        ...fieldDecoratorOptions,
      };

      if (definition._meta?.type) {
        delete definition._meta.type;
      }

      if (definition.related !== undefined && definition._meta?.related) {
        delete definition._meta.related;
      }
    }

    // Carry through decorator-derived _meta (validate, through, indexed, etc.)
    if (inference._meta && Object.keys(inference._meta).length > 0) {
      definition._meta = {
        ...definition._meta,
        ...inference._meta,
      };
    }

    // For meta fields, store the underlying type for hydration coercion
    if (inference.underlyingType) {
      definition._meta = {
        ...definition._meta,
        underlyingType: inference.underlyingType,
      };
    }

    // Mark function type fields as transient (not persisted to database)
    if (isFunctionType) {
      definition.transient = true;
    }

    if (fieldDecoratorOptions.transient === true) {
      definition.transient = true;
    }

    // Promote security markers to first-class manifest metadata (also retained
    // in `_meta` via the spread above). Honored by `toPublicJSON()` and the
    // collection `where` builder at runtime.
    if (fieldDecoratorOptions.sensitive === true) {
      definition.sensitive = true;
    }

    if (fieldDecoratorOptions.readonly === true) {
      definition.readonly = true;
    }

    return definition;
  }

  /**
   * Infer the SMRT field type and required flag from a raw field definition.
   *
   * Inference is attempted in the following priority order:
   * 1. **Field helper call in initializer** — currently always returns `null`
   *    (field helpers removed); reserved for future use.
   * 2. **Decorator** — `@foreignKey`, `@oneToMany`, `@manyToMany`, `@field({ type })`.
   * 3. **Type annotation** — `string` → `text`, `number` with `0` vs `0.0`
   *    heuristic → `integer` / `decimal`, `boolean`, `Date` → `datetime`,
   *    arrays → `json`, `Record<>` / `object` → `json`, union types with
   *    `null`, inline string/number literal unions, `Meta<T>` wrapper,
   *    and type alias resolution (up to depth 5).
   * 4. **Numeric literal without annotation** — `version = 1` → `integer`.
   * 5. **Boolean literal without annotation** — `isRead = false` → `boolean`.
   * 6. **Default** — falls back to `text`.
   *
   * @param field - The raw field definition to analyse.
   * @returns A {@link FieldTypeInference} describing the inferred type,
   *   required flag, default value, related class name (for relationships),
   *   and the inference source for debugging.
   *
   * @see {@link FieldTypeInference} for the result shape.
   * @see {@link InferredFieldType} for valid type values.
   */
  inferFieldType(field: RawFieldDefinition): FieldTypeInference {
    // 1. Check for field helper calls in initializer
    if (field.initializer) {
      const helperResult = this.inferFromHelper(field.initializer);
      if (helperResult) {
        return helperResult;
      }
    }

    // 2. Check decorators
    for (const decorator of field.decorators) {
      const decoratorResult = this.inferFromDecorator(decorator, field);
      if (decoratorResult) {
        return decoratorResult;
      }
    }

    // 3. Use type annotation with 0 vs 0.0 heuristic
    if (field.typeAnnotation) {
      return this.inferFromAnnotation(field);
    }

    // 3.5. Infer from numeric literal without type annotation
    // Handles cases like `version = 1` where there's no `: number` annotation
    if (field.numericValue !== null) {
      const fieldType: InferredFieldType = field.hasDecimalPoint
        ? 'decimal'
        : 'integer';
      return {
        type: fieldType,
        required: !field.optional,
        defaultValue: field.numericValue,
        source: 'heuristic',
      };
    }

    // 3.6. Infer from boolean literal without type annotation
    // Handles cases like `isRead = false` where there's no `: boolean` annotation
    if (field.initializer === 'true' || field.initializer === 'false') {
      return {
        type: 'boolean',
        required: !field.optional,
        defaultValue: field.initializer === 'true',
        source: 'heuristic',
      };
    }

    // 4. Default to text
    // A field is only required if it has no default value AND is not optional (?)
    // Fields with initializers (default values) should NOT be required
    const hasDefaultValue = field.initializer !== null;
    return {
      type: 'text',
      required: !field.optional && !hasDefaultValue,
      source: 'default',
    };
  }

  /**
   * Infer type from field helper call (removed)
   *
   * Field helpers have been removed in favor of decorators and TypeScript types:
   * - Use TypeScript types: name: string = '', price: number = 0.0
   * - Use @field() decorator for constraints: @field({ required: true })
   * - Use @foreignKey(), @oneToMany(), @manyToMany() decorators for relationships
   */
  private inferFromHelper(_initializer: string): FieldTypeInference | null {
    return null;
  }

  /**
   * Infer type from field decorator
   */
  private inferFromDecorator(
    decorator: {
      name: string;
      arguments: string[];
    },
    field: RawFieldDefinition,
  ): FieldTypeInference | null {
    // @field decorator with type config
    if (decorator.name === 'field' && decorator.arguments.length > 0) {
      const fieldOptions = this.parseFieldDecoratorOptions(
        decorator.arguments[0],
      );
      const type = this.normalizeFieldType(fieldOptions?.type);

      if (type) {
        const hasDefaultValue =
          field.initializer !== null || fieldOptions?.default !== undefined;
        let required = !field.optional && !hasDefaultValue;

        if (fieldOptions?.nullable === true) {
          required = false;
        } else if (fieldOptions?.required !== undefined) {
          required = fieldOptions.required;
        }

        return {
          type,
          required,
          defaultValue: fieldOptions?.default,
          related:
            typeof fieldOptions?.related === 'string'
              ? fieldOptions.related
              : undefined,
          source: 'decorator',
        };
      }
    }

    // @meta({ indexed?, required?, nullable?, ... }) decorator — flags the
    // field as STI meta storage AND preserves opt-in options like `indexed`
    // so the manifest-only schema path can emit the JSON-path index.
    if (decorator.name === 'meta') {
      const parsedOptions = this.parseFieldDecoratorOptions(
        decorator.arguments[0],
      );
      const hasDefaultValue = field.initializer !== null;
      const meta: Record<string, unknown> = {};
      if (parsedOptions?.indexed !== undefined)
        meta.indexed = parsedOptions.indexed;
      if (parsedOptions?.nullable !== undefined)
        meta.nullable = parsedOptions.nullable;
      return {
        type: 'meta',
        required:
          parsedOptions?.required !== undefined
            ? Boolean(parsedOptions.required)
            : !field.optional && !hasDefaultValue,
        defaultValue:
          parsedOptions?.default !== undefined
            ? parsedOptions.default
            : undefined,
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
        source: 'decorator',
      };
    }

    // @foreignKey(RelatedClass) decorator
    if (decorator.name === 'foreignKey') {
      // First argument is the related class name
      // Strip surrounding quotes — sliceSource() returns raw source text
      // which includes quotes for string literals (e.g., "'TestProfile'")
      const relatedClass = stripQuotes(decorator.arguments[0]?.trim());
      const parsedOptions = this.parseFieldDecoratorOptions(
        decorator.arguments[1],
      );
      const meta: Record<string, unknown> = {};
      const META_KEYS = [
        'required',
        'nullable',
        'unique',
        'description',
        'default',
      ] as const;
      if (parsedOptions) {
        for (const key of META_KEYS) {
          if (parsedOptions[key] !== undefined) {
            meta[key] = parsedOptions[key];
          }
        }
      }
      // Respect TypeScript optional marker (?) - fixes #846
      const hasDefaultValue = field.initializer !== null;
      return {
        type: 'foreignKey',
        related: relatedClass || undefined,
        required:
          parsedOptions?.required !== undefined
            ? Boolean(parsedOptions.required)
            : !field.optional && !hasDefaultValue,
        defaultValue:
          parsedOptions?.default !== undefined
            ? parsedOptions.default
            : undefined,
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
        source: 'decorator',
      };
    }

    // @tenantId({ nullable?, required?, autoFilter?, autoPopulate? }) decorator
    if (decorator.name === 'tenantId') {
      const parsedOptions = this.parseFieldDecoratorOptions(
        decorator.arguments[0],
      );
      const nullable = parsedOptions?.nullable === true;
      const required =
        parsedOptions?.required !== undefined
          ? Boolean(parsedOptions.required)
          : !nullable;

      return {
        type: 'text',
        required,
        _meta: {
          sqlType: 'UUID',
          ...(parsedOptions ?? {}),
          __tenancy: {
            isTenantIdField: true,
            autoFilter: parsedOptions?.autoFilter ?? true,
            required,
            autoPopulate: parsedOptions?.autoPopulate ?? true,
            nullable,
          },
        },
        source: 'decorator',
      };
    }

    // @crossPackageRef('@pkg:Class', { validate?, unique?, nullable?, default?, description? }) decorator
    if (decorator.name === 'crossPackageRef') {
      const qualifiedName = stripQuotes(decorator.arguments[0]?.trim());
      const hasDefaultValue = field.initializer !== null;
      // Preserve every standard field option from the second argument so
      // manifest-only consumers generate the same schema/constraints that
      // the runtime decorator would produce.
      const parsedOptions = this.parseFieldDecoratorOptions(
        decorator.arguments[1],
      );
      const meta: Record<string, unknown> = {};
      const META_KEYS = [
        'validate',
        'nullable',
        'unique',
        'description',
        'default',
        'indexed',
        'idType',
      ] as const;
      if (parsedOptions) {
        for (const key of META_KEYS) {
          if (parsedOptions[key] !== undefined) {
            meta[key] = parsedOptions[key];
          }
        }
      }
      return {
        type: 'crossPackageRef',
        related: qualifiedName || undefined,
        required:
          parsedOptions?.required !== undefined
            ? Boolean(parsedOptions.required)
            : !field.optional && !hasDefaultValue,
        defaultValue:
          parsedOptions?.default !== undefined
            ? parsedOptions.default
            : undefined,
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
        source: 'decorator',
      };
    }

    // @oneToMany(RelatedClass, { foreignKey? }) decorator
    if (decorator.name === 'oneToMany') {
      const relatedClass = stripQuotes(decorator.arguments[0]?.trim());
      // Preserve an explicit inverse `foreignKey` so manifest-only consumers
      // disambiguate the inverse side the same way the runtime decorator does
      // (needed when the target declares multiple FKs back to this class).
      const parsedOptions = this.parseFieldDecoratorOptions(
        decorator.arguments[1],
      );
      const meta: Record<string, unknown> = {};
      if (parsedOptions?.foreignKey !== undefined) {
        meta.foreignKey = parsedOptions.foreignKey;
      }
      return {
        type: 'oneToMany',
        related: relatedClass || undefined,
        required: false,
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
        source: 'decorator',
      };
    }

    // @manyToMany(RelatedClass, { through?, sourceKey?, targetKey? }) decorator
    if (decorator.name === 'manyToMany') {
      const relatedClass = stripQuotes(decorator.arguments[0]?.trim());
      // Preserve junction-table coordinates so manifest-only consumers can
      // execute manyToMany loads without the decorator firing in-process.
      const parsedOptions = this.parseFieldDecoratorOptions(
        decorator.arguments[1],
      );
      const meta: Record<string, unknown> = {};
      if (parsedOptions?.through !== undefined)
        meta.through = parsedOptions.through;
      if (parsedOptions?.sourceKey !== undefined)
        meta.sourceKey = parsedOptions.sourceKey;
      if (parsedOptions?.targetKey !== undefined)
        meta.targetKey = parsedOptions.targetKey;
      return {
        type: 'manyToMany',
        related: relatedClass || undefined,
        required: false,
        ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
        source: 'decorator',
      };
    }

    return null;
  }

  private extractFieldDecoratorOptions(
    field: RawFieldDefinition,
  ): FieldDecoratorOptions {
    const options: FieldDecoratorOptions = {};

    for (const decorator of field.decorators) {
      const reportMetadata = this.parseReportFieldDecorator(decorator, field);
      if (reportMetadata) {
        options.__report = reportMetadata;
        continue;
      }

      if (decorator.name !== 'field') continue;

      const parsed = this.parseFieldDecoratorOptions(decorator.arguments[0]);
      if (parsed) {
        Object.assign(options, parsed);
      }
    }

    return options;
  }

  private parseReportFieldDecorator(
    decorator: { name: string; arguments: string[] },
    field: RawFieldDefinition,
  ): Record<string, unknown> | null {
    if (decorator.name === 'groupBy') {
      return {
        kind: 'group',
        sourceColumn: stripQuotes(decorator.arguments[0]?.trim()) ?? field.name,
      };
    }

    const bucketUnits = new Set([
      'minute',
      'hour',
      'day',
      'week',
      'month',
      'quarter',
      'year',
    ]);
    if (bucketUnits.has(decorator.name)) {
      const sourceColumn = stripQuotes(decorator.arguments[0]?.trim());
      if (!sourceColumn) return null;
      return {
        kind: 'bucket',
        unit: decorator.name,
        sourceColumn,
      };
    }

    if (decorator.name === 'aggregate') {
      const parsed = this.parseFieldDecoratorOptions(decorator.arguments[0]);
      if (!parsed?.fn || typeof parsed.fn !== 'string') return null;
      return {
        kind: 'aggregate',
        fn: parsed.fn,
        ...(typeof parsed.column === 'string' ? { column: parsed.column } : {}),
        ...(typeof parsed.distinct === 'boolean'
          ? { distinct: parsed.distinct }
          : {}),
      };
    }

    const aggregateNames = new Set(['sum', 'avg', 'min', 'max']);
    if (aggregateNames.has(decorator.name)) {
      const column = stripQuotes(decorator.arguments[0]?.trim());
      const parsedOptions = this.parseFieldDecoratorOptions(
        decorator.arguments[1],
      );
      return {
        kind: 'aggregate',
        fn: decorator.name,
        ...(column ? { column } : {}),
        ...(typeof parsedOptions?.distinct === 'boolean'
          ? { distinct: parsedOptions.distinct }
          : {}),
      };
    }

    if (decorator.name === 'count') {
      const firstArg = decorator.arguments[0]?.trim();
      const firstOptions = this.parseFieldDecoratorOptions(firstArg);
      const secondOptions = this.parseFieldDecoratorOptions(
        decorator.arguments[1],
      );
      const column = firstOptions ? undefined : stripQuotes(firstArg);
      const options = firstOptions ?? secondOptions;
      return {
        kind: 'aggregate',
        fn: 'count',
        ...(column ? { column } : {}),
        ...(typeof options?.distinct === 'boolean'
          ? { distinct: options.distinct }
          : {}),
      };
    }

    return null;
  }

  private parseFieldDecoratorOptions(
    rawArgument: string | undefined,
  ): FieldDecoratorOptions | null {
    if (!rawArgument) return null;

    const parsed = parseLiteralInitializer(rawArgument);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
      return null;
    }

    return parsed as FieldDecoratorOptions;
  }

  private normalizeFieldType(
    value: unknown,
  ): FieldDefinition['type'] | undefined {
    switch (value) {
      case 'text':
      case 'decimal':
      case 'boolean':
      case 'integer':
      case 'datetime':
      case 'json':
      case 'foreignKey':
      case 'crossPackageRef':
      case 'oneToMany':
      case 'manyToMany':
      case 'meta':
        return value;
      default:
        return undefined;
    }
  }

  /**
   * Infer type from TypeScript type annotation
   */
  private inferFromAnnotation(field: RawFieldDefinition): FieldTypeInference {
    const type = field.typeAnnotation;

    // A field is only required if it has no default value AND is not optional (?)
    // Fields with initializers (default values) should NOT be required
    // This matches the behavior of the legacy TypeScript scanner
    const hasDefaultValue = field.initializer !== null;
    const isRequired = !field.optional && !hasDefaultValue;

    // Meta<T> wrapper for STI child fields
    // Extract the inner type T and mark as meta field
    if (type?.startsWith('Meta<') && type.endsWith('>')) {
      const innerType = type.slice(5, -1); // Extract type inside Meta<...>

      // Recursively infer the underlying type
      const underlyingInference = this.inferFromAnnotation({
        ...field,
        typeAnnotation: innerType,
      });

      return {
        type: 'meta',
        required: isRequired,
        defaultValue: underlyingInference.defaultValue,
        source: 'annotation',
        // Store underlying type for hydration coercion
        underlyingType: underlyingInference.type,
      };
    }

    // String types
    if (type === 'string') {
      return {
        type: 'text',
        required: isRequired,
        defaultValue: this.parseDefaultValue(field.initializer, 'string'),
        source: 'annotation',
      };
    }

    // Number with 0 vs 0.0 heuristic
    if (type === 'number') {
      const fieldType: InferredFieldType = field.hasDecimalPoint
        ? 'decimal'
        : 'integer';

      return {
        type: fieldType,
        required: isRequired,
        defaultValue: field.numericValue ?? undefined,
        source: 'heuristic',
      };
    }

    // Boolean
    if (type === 'boolean') {
      return {
        type: 'boolean',
        required: isRequired,
        defaultValue: this.parseDefaultValue(field.initializer, 'boolean'),
        source: 'annotation',
      };
    }

    // Date
    if (type === 'Date') {
      return {
        type: 'datetime',
        required: isRequired,
        source: 'annotation',
      };
    }

    // Arrays → JSON
    if (type?.endsWith('[]')) {
      return {
        type: 'json',
        required: isRequired,
        defaultValue: [],
        source: 'annotation',
      };
    }

    // Record/object → JSON
    if (type?.startsWith('Record<') || type === 'object') {
      return {
        type: 'json',
        required: isRequired,
        defaultValue: {},
        source: 'annotation',
      };
    }

    // Union types with null/undefined → nullable or optional
    if (
      type?.includes(' | null') ||
      type?.includes('null | ') ||
      type?.includes(' | undefined') ||
      type?.includes('undefined | ')
    ) {
      const baseType = type
        .replace(/\s*\|\s*null/g, '')
        .replace(/\s*\|\s*undefined/g, '')
        .replace(/\bnull\s*\|\s*/g, '')
        .replace(/\bundefined\s*\|\s*/g, '')
        .trim();
      const inference = this.inferFromAnnotation({
        ...field,
        typeAnnotation: baseType,
        optional: true,
      });
      return inference;
    }

    // Inline string literal union: 'pending' | 'ready' | 'archived'
    if (type && /^'[^']*'(\s*\|\s*'[^']*')+$/.test(type)) {
      return {
        type: 'text',
        required: isRequired,
        defaultValue: this.parseDefaultValue(field.initializer, 'string'),
        source: 'annotation',
      };
    }

    // Inline number literal union: 1 | 2 | 3 (supports negatives: -1 | 0 | 1)
    if (type && /^-?\d+(\s*\|\s*-?\d+)+$/.test(type)) {
      return {
        type: 'integer',
        required: isRequired,
        defaultValue: field.numericValue ?? undefined,
        source: 'annotation',
      };
    }

    // Type alias resolution: look up single-identifier types in typeAliases
    // Guard against circular aliases (e.g., type A = B; type B = A) with depth limit
    if (
      type &&
      !type.includes(' ') &&
      !type.includes('<') &&
      this.typeAliases[type] &&
      (this._aliasDepth ?? 0) < 5
    ) {
      const resolved = this.typeAliases[type];
      this._aliasDepth = (this._aliasDepth ?? 0) + 1;
      try {
        return this.inferFromAnnotation({ ...field, typeAnnotation: resolved });
      } finally {
        this._aliasDepth = (this._aliasDepth ?? 0) - 1;
      }
    }

    // String initializer heuristic: if initializer is a quoted string, infer text
    if (field.initializer?.match(/^(['"]).*\1$/)) {
      return {
        type: 'text',
        required: isRequired,
        defaultValue: this.parseDefaultValue(field.initializer, 'string'),
        source: 'heuristic',
      };
    }

    // Default to json for unknown/complex types
    // Matches the TS scanner behavior: custom interfaces, type aliases,
    // and other non-primitive types are stored as JSON
    return {
      type: 'json',
      required: isRequired,
      source: 'default',
    };
  }

  /**
   * Parse default value from initializer string
   */
  private parseDefaultValue(
    initializer: string | null,
    expectedType: 'string' | 'boolean' | 'number',
  ): string | number | boolean | undefined {
    if (!initializer) return undefined;

    switch (expectedType) {
      case 'string': {
        // Match quoted strings (backreference ensures same quote type)
        const stringMatch = initializer.match(/^(['"`])(.*)\1$/s);
        if (stringMatch) {
          return stringMatch[2];
        }
        break;
      }

      case 'boolean':
        if (initializer === 'true') return true;
        if (initializer === 'false') return false;
        break;

      case 'number': {
        const num = parseFloat(initializer);
        if (!Number.isNaN(num)) return num;
        break;
      }
    }

    return undefined;
  }

  /**
   * Convert a raw method definition to a manifest `MethodDefinition`.
   *
   * Returns `null` for `private` or `protected` methods, which are excluded
   * from the manifest.  Parameters are mapped to the manifest parameter shape
   * and default values are parsed via `parseDefaultValue`.
   *
   * @param method - Raw method definition from a scanned class.
   * @returns A manifest-compatible `MethodDefinition`, or `null` if the method
   *   should be excluded.
   */
  convertMethod(method: RawMethodDefinition): MethodDefinition | null {
    // Skip private/protected methods
    if (method.accessibility !== 'public') {
      return null;
    }

    return {
      name: method.name,
      async: method.async,
      parameters: method.parameters.map((p) => ({
        name: p.name,
        type: p.type || 'any',
        optional: p.optional,
        default: p.defaultValue
          ? this.parseDefaultValue(p.defaultValue, 'string')
          : undefined,
      })),
      returnType: method.returnType || 'any',
      description: method.description || undefined,
      isStatic: method.isStatic,
      isPublic: true,
    };
  }

  /**
   * Simple pluralization for collection names.
   *
   * This produces the manifest's `collection` label only; the authoritative DDL
   * table name is derived independently by core (`classnameToTablename` →
   * the `pluralize` library), so this needs to stay self-consistent rather than
   * cover every irregular plural. Note the `y → ies` rule fires only after a
   * consonant, so vowel+y words pluralise correctly (`Day` → `days`, not
   * `daies`).
   */
  private pluralize(name: string): string {
    // Lowercase the name first for consistent collection/table names
    const lower = name.toLowerCase();
    // Consonant + y → ies (City → cities); vowel + y → +s (Day → days).
    if (/[^aeiou]y$/.test(lower)) {
      return `${lower.slice(0, -1)}ies`;
    }
    if (lower.endsWith('s') || lower.endsWith('x') || lower.endsWith('z')) {
      return `${lower}es`;
    }
    if (lower.endsWith('ch') || lower.endsWith('sh')) {
      return `${lower}es`;
    }
    return `${lower}s`;
  }
}
