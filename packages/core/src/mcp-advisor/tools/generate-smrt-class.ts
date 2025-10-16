/**
 * Generate complete SMRT class with decorator, properties, and constructor
 */

import type { GenerateSmrtClassInput, ToolResponse } from '../types.js';

/**
 * Generate a complete SMRT class definition
 */
export async function generateSmrtClass(
  input: GenerateSmrtClassInput,
): Promise<ToolResponse> {
  try {
    const {
      className,
      properties,
      baseClass = 'SmrtObject',
      includeApiConfig = true,
      includeMcpConfig = true,
      includeCliConfig = true,
    } = input;

    // Validate input
    if (!className || !/^[A-Z][a-zA-Z0-9]*$/.test(className)) {
      throw new Error(
        'className must be in PascalCase (e.g., ProductCategory)',
      );
    }

    if (!properties || properties.length === 0) {
      throw new Error('At least one property is required');
    }

    // Generate imports
    const imports = [
      `import { ${baseClass}, type SmrtObjectOptions, smrt } from '@smrt/core';`,
    ];

    // Determine which field types are used
    const fieldTypes = new Set(properties.map((p) => p.type));
    const fieldImports: string[] = [];

    for (const type of fieldTypes) {
      fieldImports.push(type);
    }

    if (fieldImports.length > 0) {
      imports.push(
        `import { ${fieldImports.join(', ')} } from '@smrt/core/fields';`,
      );
    }

    // Generate interface
    const interfaceName = `${className}Options`;
    const interfaceProperties = properties
      .map((p) => `  ${p.name}?: ${getTypeScriptType(p.type)};`)
      .join('\n');

    const interfaceCode = `
export interface ${interfaceName} extends SmrtObjectOptions {
${interfaceProperties}
}`;

    // Generate decorator configuration
    const decoratorParts: string[] = [];

    if (includeApiConfig) {
      decoratorParts.push(`  api: {
    include: ['list', 'get', 'create', 'update'],
  }`);
    }

    if (includeMcpConfig) {
      decoratorParts.push(`  mcp: {
    include: ['list', 'get'],
  }`);
    }

    if (includeCliConfig) {
      decoratorParts.push(`  cli: true`);
    }

    const decoratorConfig =
      decoratorParts.length > 0
        ? `@smrt({\n${decoratorParts.join(',\n')}\n})`
        : '@smrt()';

    // Generate class properties with field definitions
    const classProperties = properties
      .map((p) => {
        const fieldCall = generateFieldCall(p);
        return `  ${p.name} = ${fieldCall};`;
      })
      .join('\n');

    // Generate constructor assignments
    const constructorAssignments = properties
      .map((p) => `    this.${p.name} = options.${p.name} || ${getDefaultValue(p.type)};`)
      .join('\n');

    // Generate complete class
    const classCode = `
${decoratorConfig}
export class ${className} extends ${baseClass} {
${classProperties}

  constructor(options: ${interfaceName} = {}) {
    super(options);
${constructorAssignments}
  }
}`;

    // Combine all parts
    const code = `${imports.join('\n')}
${interfaceCode}
${classCode}
`;

    return {
      success: true,
      data: code,
      warnings: [],
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error ? error.message : 'Unknown error generating class',
    };
  }
}

/**
 * Get TypeScript type for field type
 */
function getTypeScriptType(fieldType: string): string {
  switch (fieldType) {
    case 'text':
      return 'string';
    case 'integer':
      return 'number';
    case 'decimal':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'datetime':
      return 'Date';
    case 'json':
      return 'Record<string, any>';
    default:
      return 'any';
  }
}

/**
 * Get default value for field type
 */
function getDefaultValue(fieldType: string): string {
  switch (fieldType) {
    case 'text':
      return "''";
    case 'integer':
    case 'decimal':
      return '0';
    case 'boolean':
      return 'false';
    case 'datetime':
      return 'new Date()';
    case 'json':
      return '{}';
    default:
      return 'undefined';
  }
}

/**
 * Generate field function call with options
 */
function generateFieldCall(property: {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
}): string {
  const options: string[] = [];

  if (property.required) {
    options.push('required: true');
  }

  if (property.description) {
    options.push(`description: ${JSON.stringify(property.description)}`);
  }

  const optionsStr = options.length > 0 ? `{ ${options.join(', ')} }` : '';

  return `${property.type}(${optionsStr})`;
}
