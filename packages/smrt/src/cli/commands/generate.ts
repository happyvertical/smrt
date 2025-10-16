/**
 * Code Generation CLI Commands
 *
 * Commands for generating code, types, and other artifacts
 */

import type { CLICommand } from '../../generators/cli.js';
import { generateDeclarationsFromCLI } from '../../prebuild/index.js';

/**
 * Code generation commands for CLI
 */
export const generateCommands: Record<string, CLICommand> = {
  'generate-types': {
    name: 'generate-types',
    description: 'Generate TypeScript declarations from SMRT manifest',
    aliases: ['generate-declarations'],
    args: ['manifest-path'],
    options: {
      'output-dir': {
        type: 'string',
        description: 'Output directory for generated types',
      },
    },
    handler: async (args: string[], options: any) => {
      const manifestPath = args[0];
      if (!manifestPath) {
        throw new Error(
          'Manifest path is required: smrt generate-types <manifest-path> [output-dir]',
        );
      }

      const outputDir = options.outputDir || args[1];

      try {
        const cliArgs = outputDir ? [manifestPath, outputDir] : [manifestPath];
        await generateDeclarationsFromCLI(cliArgs);
      } catch (error) {
        throw new Error(
          `Failed to generate types: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    },
  },
};
