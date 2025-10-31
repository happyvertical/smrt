/**
 * Code Generation CLI Commands
 *
 * Commands for generating code, types, and other artifacts
 */

import type { CLICommand } from '../cli-generator.js';
import { MCPGenerator } from '@happyvertical/smrt-core/generators';
import { generateDeclarationsFromCLI } from '@happyvertical/smrt-core/prebuild';
import { ObjectRegistry } from '@happyvertical/smrt-core';

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

  'generate-mcp': {
    name: 'generate-mcp',
    description: 'Generate MCP server from registered SMRT objects',
    aliases: ['generate-mcp-server', 'mcp'],
    args: [],
    options: {
      'output-path': {
        type: 'string',
        description: 'Output path for MCP server file',
        default: '.smrt/mcp-server/index.js',
      },
      name: {
        type: 'string',
        description: 'Server name',
      },
      version: {
        type: 'string',
        description: 'Server version',
        default: '1.0.0',
      },
      modular: {
        type: 'boolean',
        description:
          'Generate modular directory structure (tools/, handlers/, config.ts)',
        default: false,
      },
      debug: {
        type: 'boolean',
        description: 'Enable debug logging in generated server',
        default: false,
      },
      'no-config': {
        type: 'boolean',
        description: 'Skip Claude Desktop configuration example',
        default: false,
      },
      'no-readme': {
        type: 'boolean',
        description: 'Skip README documentation',
        default: false,
      },
    },
    handler: async (_args: string[], options: any) => {
      try {
        // Get registered SMRT objects
        const registeredClasses = ObjectRegistry.getAllClasses();

        if (registeredClasses.size === 0) {
          console.warn(
            '⚠️ No SMRT objects found. Make sure your objects are registered with @smrt() decorator.',
          );
          console.warn(
            '   The MCP server will be generated but will have no tools.',
          );
        }

        // Determine server name from package.json or use default
        let serverName = options.name;
        if (!serverName) {
          try {
            const { readFile } = await import('node:fs/promises');
            const { resolve } = await import('node:path');
            const packageJson = JSON.parse(
              await readFile(resolve(process.cwd(), 'package.json'), 'utf-8'),
            );
            serverName = packageJson.name || 'smrt-mcp-server';
          } catch {
            serverName = 'smrt-mcp-server';
          }
        }

        // Create MCP generator
        const generator = new MCPGenerator({
          name: serverName,
          version: options.version,
          description: 'Auto-generated MCP server from SMRT objects',
        });

        console.log(`\n🔨 Generating MCP server...`);
        console.log(`   Server name: ${serverName}`);
        console.log(`   Output path: ${options.outputPath}`);
        console.log(`   Modular structure: ${options.modular ? 'yes' : 'no'}`);
        console.log(`   Registered objects: ${registeredClasses.size}`);

        // Generate server
        await generator.generateServer({
          outputPath: options.outputPath,
          serverName,
          serverVersion: options.version,
          debug: options.debug,
          generateClaudeConfigFile: !options.noConfig,
          generateReadme: !options.noReadme,
          modular: options.modular,
        });

        console.log(`\n✅ MCP server generated successfully!`);
        console.log(`\n📝 Next steps:`);
        console.log(
          `   1. Add MCP server to your Claude Desktop configuration`,
        );
        console.log(`   2. Restart Claude Desktop`);
        console.log(`   3. Start using the auto-generated tools\n`);
      } catch (error) {
        throw new Error(
          `Failed to generate MCP server: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    },
  },
};
