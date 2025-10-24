import { getPackageDocs } from '../registry.js';

/**
 * Get docs tool - Returns full CLAUDE.md for a specific package
 *
 * @param packageName - Name of the package (e.g., "core", "agents")
 * @returns Full CLAUDE.md documentation
 */
export async function getDocs(packageName: string) {
  try {
    const docs = await getPackageDocs(packageName);

    if (!docs) {
      return {
        content: [
          {
            type: 'text',
            text: `Package "${packageName}" not found. Use list-packages to see available packages.`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `# @happyvertical/smrt-${packageName}\n\n${docs}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error retrieving documentation: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
