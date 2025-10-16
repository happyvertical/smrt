/**
 * Generate SmrtCollection subclass for a SMRT object
 */

import type { GenerateCollectionInput, ToolResponse } from '../types.js';

/**
 * Generate a SmrtCollection subclass
 */
export async function generateCollection(
  input: GenerateCollectionInput,
): Promise<ToolResponse> {
  try {
    const {
      collectionName,
      itemClassName,
      itemClassPath,
      includeCustomMethods = false,
    } = input;

    // Validate input
    if (!collectionName || !/^[A-Z][a-zA-Z0-9]*$/.test(collectionName)) {
      throw new Error(
        'collectionName must be in PascalCase (e.g., ProductCollection)',
      );
    }

    if (!itemClassName || !/^[A-Z][a-zA-Z0-9]*$/.test(itemClassName)) {
      throw new Error(
        'itemClassName must be in PascalCase (e.g., Product)',
      );
    }

    // Generate imports
    const imports = [
      `import { SmrtCollection } from '@smrt/core';`,
      `import { ${itemClassName} } from '${itemClassPath}';`,
    ];

    // Generate custom methods if requested
    const customMethods = includeCustomMethods
      ? `

  /**
   * Find items by custom criteria
   */
  async findByCriteria(criteria: any): Promise<${itemClassName}[]> {
    // TODO: Implement custom query logic
    return this.list({ where: criteria });
  }

  /**
   * Get or create item
   */
  async getOrCreate(data: any, defaults: any = {}): Promise<${itemClassName}> {
    return this.getOrUpsert(data, defaults);
  }`
      : '';

    // Generate collection class
    const classCode = `
/**
 * Collection for managing ${itemClassName} objects
 */
export class ${collectionName} extends SmrtCollection<${itemClassName}> {
  /**
   * REQUIRED: Define the item class for this collection
   */
  static readonly _itemClass = ${itemClassName};${customMethods}
}`;

    // Combine all parts
    const code = `${imports.join('\n')}
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
        error instanceof Error
          ? error.message
          : 'Unknown error generating collection',
    };
  }
}
