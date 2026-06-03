/**
 * Generate SMRT Class Tool
 * Creates a complete SMRT class with decorator configuration
 */

interface PropertyDefinition {
  name: string;
  type: 'text' | 'integer' | 'decimal' | 'boolean' | 'datetime' | 'json';
  required?: boolean;
  description?: string;
}

interface GenerateSmrtClassArgs {
  className: string;
  properties: PropertyDefinition[];
  baseClass?: 'SmrtObject' | 'SmrtCollection';
  includeApiConfig?: boolean;
  includeMcpConfig?: boolean;
  includeCliConfig?: boolean;
}

// Map field types to TypeScript types and default values
const TYPE_MAPPING: Record<
  PropertyDefinition['type'],
  { tsType: string; defaultValue: string }
> = {
  text: { tsType: 'string', defaultValue: "''" },
  integer: { tsType: 'number', defaultValue: '0' },
  decimal: { tsType: 'number', defaultValue: '0.0' },
  boolean: { tsType: 'boolean', defaultValue: 'false' },
  datetime: { tsType: 'Date', defaultValue: 'new Date()' },
  json: { tsType: 'any', defaultValue: '{}' },
};

export async function generateSmrtClass(
  args: GenerateSmrtClassArgs,
): Promise<string> {
  const {
    className,
    properties,
    baseClass = 'SmrtObject',
    includeApiConfig = true,
    includeMcpConfig = true,
    includeCliConfig = true,
  } = args;

  // Generate imports
  const coreImports = [baseClass, 'smrt'];

  const needsFieldDecorator = properties.some(
    (p) => p.required || p.description,
  );
  if (needsFieldDecorator) {
    coreImports.push('field');
  }

  const imports = [
    `import { ${coreImports.join(', ')} } from '@happyvertical/smrt-core';`,
  ];

  // Generate decorator configuration
  const decoratorConfig: any = {};

  if (includeApiConfig) {
    decoratorConfig.api = {
      include: ['list', 'get', 'create', 'update'],
      exclude: ['delete'], // Safe default
    };
  }

  if (includeMcpConfig) {
    decoratorConfig.mcp = {
      include: ['list', 'get'], // Read-only by default for AI
    };
  }

  if (includeCliConfig) {
    decoratorConfig.cli = true;
  }

  const decoratorString =
    Object.keys(decoratorConfig).length > 0
      ? `@smrt(${JSON.stringify(decoratorConfig, null, 2)})`
      : '@smrt()';

  // Generate property definitions using TypeScript types and @field decorator
  const propertyDefinitions = properties
    .map((prop) => {
      const { tsType, defaultValue } = TYPE_MAPPING[prop.type];
      const options: any = {};

      if (prop.required) options.required = true;
      if (prop.description) options.description = prop.description;

      // Add JSDoc comment if description provided
      const jsdoc = prop.description ? `  /** ${prop.description} */\n` : '';

      // Use @field decorator if constraints are needed
      const decorator =
        Object.keys(options).length > 0
          ? `  @field(${JSON.stringify(options)})\n`
          : '';

      return `${jsdoc}${decorator}  ${prop.name}: ${tsType} = ${defaultValue};`;
    })
    .join('\n\n');

  // Generate complete class
  const classCode = `${imports.join('\n')}

${decoratorString}
export class ${className} extends ${baseClass} {
${propertyDefinitions}

  constructor(options: any = {}) {
    super(options);
    Object.assign(this, options);
  }
}
`;

  return classCode;
}
