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
  const imports = [
    `import { ${baseClass}, smrt } from '@happyvertical/smrt-core';`,
  ];

  if (
    properties.some((p) =>
      ['text', 'integer', 'decimal', 'boolean', 'datetime', 'json'].includes(
        p.type,
      ),
    )
  ) {
    const fieldTypes = [...new Set(properties.map((p) => p.type))];
    imports.push(
      `import { ${fieldTypes.join(', ')} } from '@happyvertical/smrt-core/fields';`,
    );
  }

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

  // Generate property definitions
  const propertyDefinitions = properties
    .map((prop) => {
      const options: any = {};
      if (prop.required) options.required = true;
      if (prop.description) options.description = prop.description;

      const optionsString =
        Object.keys(options).length > 0 ? `(${JSON.stringify(options)})` : '()';

      return `  ${prop.name} = ${prop.type}${optionsString};`;
    })
    .join('\n');

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
