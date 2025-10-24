import { getAllPackages } from '../registry.js';

/**
 * List packages tool - Shows all available SMRT packages
 *
 * @returns List of packages with descriptions and keywords
 */
export async function listPackages() {
  try {
    const packages = await getAllPackages();

    if (packages.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No packages found in the SMRT framework.',
          },
        ],
      };
    }

    // Build package list with descriptions
    const packageList = packages
      .map((pkg) => {
        const keywords = pkg.keywords.join(', ');
        return `### @happyvertical/smrt-${pkg.name}\n${pkg.description}\n\n**Keywords**: ${keywords}`;
      })
      .join('\n\n---\n\n');

    const header = `# SMRT Framework Packages (${packages.length} total)\n\n`;
    const text = header + packageList;

    return {
      content: [
        {
          type: 'text',
          text,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error listing packages: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
