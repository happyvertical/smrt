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
// Manifest Adapter
// ============================================================================

/**
 * Converts OXC scanner output to smrt-core manifest format
 */
export class ManifestAdapter {
  /**
   * Convert resolved classes to manifest format
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
      const definition = this.toSmartObjectDefinition(classDef);
      objects[definition.name.toLowerCase()] = definition;
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
   */
  toSmartObjectDefinition(
    classDef: ResolvedClassDefinition,
  ): SmartObjectDefinition {
    // Convert fields
    const fields: Record<string, FieldDefinition> = {};
    for (const field of classDef.allFields) {
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

    return {
      name: classDef.className,
      className: classDef.className,
      collection,
      filePath: classDef.filePath,
      packageName: classDef.packageName || undefined,
      fields,
      methods,
      decoratorConfig: (classDef.decoratorConfig || {}) as SmartObjectConfig,
      extends: classDef.extendsClause || undefined,
      extendsTypeArg: classDef.extendsTypeArg || undefined,
    };
  }

  /**
   * Convert raw field to FieldDefinition
   */
  convertField(field: RawFieldDefinition): FieldDefinition | null {
    // Skip private/protected fields
    if (field.accessibility !== 'public') {
      return null;
    }

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
      const decoratorResult = this.inferFromDecorator(decorator);
      if (decoratorResult) {
        return decoratorResult;
      }
    }

    // 3. Use type annotation with 0 vs 0.0 heuristic
    if (field.typeAnnotation) {
      return this.inferFromAnnotation(field);
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
   * Infer type from field helper call
   */
  private inferFromHelper(initializer: string): FieldTypeInference | null {
    // text(), text({ required: true })
    if (initializer.startsWith('text(')) {
      return { type: 'text', required: true, source: 'helper' };
    }

    // integer(), integer({ min: 0 })
    if (initializer.startsWith('integer(')) {
      return { type: 'integer', required: true, source: 'helper' };
    }

    // decimal(), decimal({ nullable: true })
    if (initializer.startsWith('decimal(')) {
      const nullable = initializer.includes('nullable: true');
      return { type: 'decimal', required: !nullable, source: 'helper' };
    }

    // boolean()
    if (initializer.startsWith('boolean(')) {
      return { type: 'boolean', required: true, source: 'helper' };
    }

    // datetime()
    if (initializer.startsWith('datetime(')) {
      return { type: 'datetime', required: true, source: 'helper' };
    }

    // json()
    if (initializer.startsWith('json(')) {
      return { type: 'json', required: true, source: 'helper' };
    }

    // foreignKey(Customer)
    const fkMatch = initializer.match(/^foreignKey\(\s*(\w+)/);
    if (fkMatch) {
      return {
        type: 'foreignKey',
        related: fkMatch[1],
        required: true,
        source: 'helper',
      };
    }

    // oneToMany(OrderItem)
    const otmMatch = initializer.match(/^oneToMany\(\s*(\w+)/);
    if (otmMatch) {
      return {
        type: 'oneToMany',
        related: otmMatch[1],
        required: false,
        source: 'helper',
      };
    }

    // manyToMany(Tag)
    const mtmMatch = initializer.match(/^manyToMany\(\s*(\w+)/);
    if (mtmMatch) {
      return {
        type: 'manyToMany',
        related: mtmMatch[1],
        required: false,
        source: 'helper',
      };
    }

    return null;
  }

  /**
   * Infer type from field decorator
   */
  private inferFromDecorator(decorator: {
    name: string;
    arguments: string[];
  }): FieldTypeInference | null {
    // @field decorator with type config
    if (decorator.name === 'field' && decorator.arguments.length > 0) {
      const arg = decorator.arguments[0];

      // Try to parse type from argument
      if (arg.includes("type: 'text'") || arg.includes('type: "text"')) {
        return { type: 'text', required: true, source: 'helper' };
      }
      if (arg.includes("type: 'integer'") || arg.includes('type: "integer"')) {
        return { type: 'integer', required: true, source: 'helper' };
      }
      if (arg.includes("type: 'decimal'") || arg.includes('type: "decimal"')) {
        return { type: 'decimal', required: true, source: 'helper' };
      }
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

    // Default to text for unknown types
    return {
      type: 'text',
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
    if (name.endsWith('y')) {
      return `${name.slice(0, -1)}ies`;
    }
    if (name.endsWith('s') || name.endsWith('x') || name.endsWith('z')) {
      return `${name}es`;
    }
    if (name.endsWith('ch') || name.endsWith('sh')) {
      return `${name}es`;
    }
    return `${name}s`;
  }
}
