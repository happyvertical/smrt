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
 * Converts OXC scanner output to smrt-core manifest format
 */
export class ManifestAdapter {
  /**
   * Convert resolved classes to manifest format
   *
   * @param resolved - Array of resolved class definitions
   * @param options - Configuration options
   * @param options.packageName - Package name for qualified name generation (Issue #713)
   * @param options.packageVersion - Package version for manifest metadata
   */
  toManifest(
    resolved: ResolvedClassDefinition[],
    options: {
      packageName?: string;
      packageVersion?: string;
    } = {},
  ): SmartObjectManifest {
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
   * Convert a single resolved class to SmartObjectDefinition
   *
   * @param classDef - Resolved class definition from OXC scanner
   * @param options - Configuration options (packageName for qualified names)
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
    const knownStaticProps = ['uiSlots', 'adminRoutes'];
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
   * Convert raw field to FieldDefinition
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

    return definition;
  }

  /**
   * Infer SMRT field type from raw field definition
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
      const arg = decorator.arguments[0];

      // Try to parse type from argument
      if (arg.includes("type: 'text'") || arg.includes('type: "text"')) {
        return { type: 'text', required: true, source: 'decorator' };
      }
      if (arg.includes("type: 'integer'") || arg.includes('type: "integer"')) {
        return { type: 'integer', required: true, source: 'decorator' };
      }
      if (arg.includes("type: 'decimal'") || arg.includes('type: "decimal"')) {
        return { type: 'decimal', required: true, source: 'decorator' };
      }
    }

    // @foreignKey(RelatedClass) decorator
    if (decorator.name === 'foreignKey') {
      // First argument is the related class name
      const relatedClass = decorator.arguments[0]?.trim();
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
      const relatedClass = decorator.arguments[0]?.trim();
      return {
        type: 'oneToMany',
        related: relatedClass || undefined,
        required: false,
        source: 'decorator',
      };
    }

    // @manyToMany(RelatedClass) decorator
    if (decorator.name === 'manyToMany') {
      const relatedClass = decorator.arguments[0]?.trim();
      return {
        type: 'manyToMany',
        related: relatedClass || undefined,
        required: false,
        source: 'decorator',
      };
    }

    return null;
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

    // Union types with null → nullable
    if (type?.includes(' | null') || type?.includes('null | ')) {
      const baseType = type.replace(/\s*\|\s*null/g, '').trim();
      const inference = this.inferFromAnnotation({
        ...field,
        typeAnnotation: baseType,
        optional: true,
      });
      return inference;
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
        // Match quoted strings
        const stringMatch = initializer.match(/^['"`](.*)['"`]$/);
        if (stringMatch) {
          return stringMatch[1];
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
   * Convert raw method to MethodDefinition
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
