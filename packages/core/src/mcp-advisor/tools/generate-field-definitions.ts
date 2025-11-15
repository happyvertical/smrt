/**
 * Generate field definitions with decorators (modern SMRT pattern)
 */

import type { GenerateFieldDefinitionsInput, ToolResponse } from '../types.js';

/**
 * Generate field definitions code using decorators
 */
export async function generateFieldDefinitions(
  input: GenerateFieldDefinitionsInput,
): Promise<ToolResponse> {
  try {
    const { fields } = input;

    if (!fields || fields.length === 0) {
      throw new Error('At least one field is required');
    }

    // Generate import statement for decorators
    const importCode = `import { field } from '@happyvertical/smrt-core';`;

    // Generate field definitions with decorators
    const fieldDefinitions = fields
      .map((field) => {
        const hasDecorator = field._meta && Object.keys(field._meta).length > 0;
        const decorator = hasDecorator
          ? `  @field(${JSON.stringify(field._meta)})\n`
          : '';
        const tsType = getTypeScriptType(field.type);
        const defaultValue = getDefaultValue(field.type);
        return `${decorator}  ${field.name}: ${tsType} = ${defaultValue};`;
      })
      .join('\n\n');

    const code = `${importCode}

// Field definitions with decorators:
${fieldDefinitions}`;

    return {
      success: true,
      data: code,
      warnings: [],
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Unknown error generating field definitions',
    };
  }
}

/**
 * Map field type to TypeScript type
 */
function getTypeScriptType(fieldType: string): string {
  switch (fieldType) {
    case 'text':
      return 'string';
    case 'integer':
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
 * Get default value for field type (uses 0 vs 0.0 heuristic)
 */
function getDefaultValue(fieldType: string): string {
  switch (fieldType) {
    case 'text':
      return "''";
    case 'integer':
      return '0'; // No decimal point → INTEGER
    case 'decimal':
      return '0.0'; // With decimal point → DECIMAL
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
