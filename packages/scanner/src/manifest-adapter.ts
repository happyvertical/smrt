/**
 * Manifest Adapter
 *
 * Converts OXC scanner output to smrt-core manifest format.
 * Ensures compatibility with existing manifest consumers.
 */

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
    | 'oneToMany'
    | 'manyToMany'
    | 'meta';
  required?: boolean;
  default?: any;
  min?: number;
  max?: number;
  maxLength?: number;
  minLength?: number;
  related?: string;
  description?: string;
  _meta?: Record<string, any>;
  transient?: boolean;
}

type FieldDecoratorOptions = {
  type?: FieldDefinition['type'];
  required?: boolean;
  nullable?: boolean;
  default?: any;
  min?: number;
  max?: number;
  maxLength?: number;
  minLength?: number;
  related?: string;
  description?: string;
  transient?: boolean;
  unique?: boolean;
  [key: string]: unknown;
};

interface MethodDefinition {
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

interface SmartObjectConfig {
  tableStrategy?: 'sti' | 'cti';
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
  staticProperties?: Record<string, any>;
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
 * Parse a JavaScript literal (object or array) from source text.
 *
 * Uses the Function constructor to evaluate literal syntax at build time.
 * This is intentional — AST-based extraction can't handle computed keys,
 * template literals, or spread syntax that may appear in static initializers.
 *
 * WARNING: This executes the source text. It is only safe when scanning
 * your own trusted codebase at build time. Never run the scanner against
 * untrusted third-party code.
 */
function parseLiteralInitializer(
  source: string,
): Record<string, any> | any[] | null {
  const trimmed = source?.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('[')))
    return null;
  try {
    // Use indirect eval via Function to parse the object/array literal
    // This runs at build time only, on trusted source code from our own codebase
    // The existing pattern (unchanged) uses Function constructor for object literal parsing
    // eslint-disable-next-line no-new-func
    return new Function(`return (${source})`)() as Record<string, any>;
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
    let staticProperties: Record<string, any> | undefined;
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

    // @foreignKey(RelatedClass) decorator
    if (decorator.name === 'foreignKey') {
      // First argument is the related class name
      // Strip surrounding quotes — sliceSource() returns raw source text
      // which includes quotes for string literals (e.g., "'TestProfile'")
      const relatedClass = stripQuotes(decorator.arguments[0]?.trim());
      // Respect TypeScript optional marker (?) - fixes #846
      const hasDefaultValue = field.initializer !== null;
      return {
        type: 'foreignKey',
        related: relatedClass || undefined,
        required: !field.optional && !hasDefaultValue,
        source: 'decorator',
      };
    }

    // @oneToMany(RelatedClass) decorator
    if (decorator.name === 'oneToMany') {
      const relatedClass = stripQuotes(decorator.arguments[0]?.trim());
      return {
        type: 'oneToMany',
        related: relatedClass || undefined,
        required: false,
        source: 'decorator',
      };
    }

    // @manyToMany(RelatedClass) decorator
    if (decorator.name === 'manyToMany') {
      const relatedClass = stripQuotes(decorator.arguments[0]?.trim());
      return {
        type: 'manyToMany',
        related: relatedClass || undefined,
        required: false,
        source: 'decorator',
      };
    }

    return null;
  }

  private extractFieldDecoratorOptions(
    field: RawFieldDefinition,
  ): FieldDecoratorOptions {
    for (const decorator of field.decorators) {
      if (decorator.name !== 'field') continue;

      const parsed = this.parseFieldDecoratorOptions(decorator.arguments[0]);
      if (parsed) {
        return parsed;
      }
    }

    return {};
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
  ): any {
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
   * Simple pluralization for collection names
   */
  private pluralize(name: string): string {
    // Lowercase the name first for consistent collection/table names
    const lower = name.toLowerCase();
    if (lower.endsWith('y')) {
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
