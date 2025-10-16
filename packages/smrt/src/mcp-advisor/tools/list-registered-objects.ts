/**
 * List all registered SMRT objects in the ObjectRegistry
 */

import { ObjectRegistry } from '../../registry.js';
import type {
  ListRegisteredObjectsInput,
  RegisteredObjectInfo,
} from '../types.js';

/**
 * List registered objects with metadata
 */
export async function listRegisteredObjects(
  input: ListRegisteredObjectsInput = {},
): Promise<{ objects: RegisteredObjectInfo[]; total: number }> {
  try {
    const { filter = 'all' } = input;

    // Get all registered classes
    const registeredClasses = ObjectRegistry.getAllClasses();
    const objects: RegisteredObjectInfo[] = [];

    for (const [name, classInfo] of registeredClasses) {
      const config = ObjectRegistry.getConfig(name);
      const fields = ObjectRegistry.getFields(name);

      // Determine type (object vs collection)
      const isCollection =
        classInfo.constructor.name.includes('Collection') ||
        name.includes('Collection');
      const type = isCollection ? 'collection' : 'object';

      // Apply filter
      if (filter !== 'all') {
        if (filter === 'objects' && type !== 'object') continue;
        if (filter === 'collections' && type !== 'collection') continue;
      }

      // Extract configuration
      const apiEnabled = !!(
        config.api &&
        (config.api.include || config.api.exclude !== undefined)
      );
      const mcpEnabled = !!(
        config.mcp &&
        (config.mcp.include || config.mcp.exclude !== undefined)
      );
      const cliEnabled = config.cli === true;

      objects.push({
        name,
        type,
        hasDecorator: config !== undefined,
        fieldCount: fields.size,
        apiEnabled,
        mcpEnabled,
        cliEnabled,
      });
    }

    // Format as markdown table
    const markdown = formatObjectsAsMarkdown(objects);

    return {
      objects,
      total: objects.length,
    };
  } catch (error) {
    throw new Error(
      `Failed to list registered objects: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Format objects as markdown table
 */
function formatObjectsAsMarkdown(objects: RegisteredObjectInfo[]): string {
  let markdown = `# Registered SMRT Objects\n\n`;
  markdown += `Total: ${objects.length}\n\n`;
  markdown += `| Name | Type | Fields | API | MCP | CLI |\n`;
  markdown += `|------|------|--------|-----|-----|-----|\n`;

  for (const obj of objects) {
    const api = obj.apiEnabled ? '✓' : '✗';
    const mcp = obj.mcpEnabled ? '✓' : '✗';
    const cli = obj.cliEnabled ? '✓' : '✗';

    markdown += `| ${obj.name} | ${obj.type} | ${obj.fieldCount} | ${api} | ${mcp} | ${cli} |\n`;
  }

  return markdown;
}
