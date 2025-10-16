/**
 * Generate field definitions with proper imports from @smrt/core/fields
 */

import type { GenerateFieldDefinitionsInput, ToolResponse } from '../types.js';

/**
 * Generate field definitions code
 */
export async function generateFieldDefinitions(
  input: GenerateFieldDefinitionsInput,
): Promise<ToolResponse> {
  try {
    const { fields } = input;

    if (!fields || fields.length === 0) {
      throw new Error('At least one field is required');
    }

    // Collect unique field types for import
    const fieldTypes = new Set(fields.map((f) => f.type));
    const imports = Array.from(fieldTypes);

    // Generate import statement
    const importCode = `import { ${imports.join(', ')} } from '@smrt/core/fields';`;

    // Generate field definitions
    const fieldDefinitions = fields
      .map((field) => {
        const optionsStr = field.options
          ? ` ${JSON.stringify(field.options)}`
          : '';
        return `  ${field.name} = ${field.type}(${optionsStr});`;
      })
      .join('\n');

    const code = `${importCode}

// Field definitions:
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
