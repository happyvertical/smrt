/**
 * Gnode CLI Commands
 *
 * Commands for creating and managing gnodes (federated local knowledge bases)
 */

import type { CLICommand } from '../../generators/cli.js';
import {
  cleanupGitTemplate,
  discoverInstalledTemplates,
  loadTemplate,
  resolveTemplate,
} from '../loaders/index.js';
import { generate } from '../utils/generator.js';

/**
 * Gnode commands for CLI
 */
export const gnodeCommands: Record<string, CLICommand> = {
  'gnode create': {
    name: 'gnode create',
    description: 'Create a new gnode from template',
    args: ['name'],
    options: {
      template: {
        type: 'string',
        description: 'Template to use (npm package, git repo, or local path)',
        default: 'sveltekit',
      },
      'output-dir': {
        type: 'string',
        description: 'Output directory (defaults to ./<name>)',
      },
    },
    handler: async (args: string[], options: any) => {
      const name = args[0];
      if (!name) {
        throw new Error('Project name is required: smrt gnode create <name>');
      }

      const outputDir = options.outputDir || `./${name}`;
      const templateName = options.template || 'sveltekit';

      try {
        // Resolve template source
        console.log(`🔍 Resolving template: ${templateName}...`);
        const source = await resolveTemplate(templateName);
        console.log(`✓ Found template: ${source.type}:${source.location}\n`);

        // Load template configuration
        const config = await loadTemplate(source);

        // Generate project
        await generate(source, config, {
          name,
          template: templateName,
          outputDir,
        });

        // Cleanup git template if needed
        if (source.type === 'git') {
          await cleanupGitTemplate(config);
        }
      } catch (error) {
        throw new Error(
          `Failed to create gnode: ${error instanceof Error ? error.message : 'Unknown error'}`,
          { cause: error },
        );
      }
    },
  },

  'gnode list-templates': {
    name: 'gnode list-templates',
    description: 'List available gnode templates',
    aliases: ['gnode ls'],
    handler: async (_args: string[], _options: any) => {
      console.log('📦 Discovering installed templates...\n');

      const templates = await discoverInstalledTemplates();

      if (templates.length === 0) {
        console.log('No templates found in node_modules.');
        console.log(
          '\nTo use a template, install a package that provides one:',
        );
        console.log('  npm install @happyvertical/praeco');
        console.log('\nOr use a git repository:');
        console.log('  smrt gnode create my-town --template=github:user/repo');
        return;
      }

      console.log('Available templates:\n');

      for (const t of templates) {
        console.log(`  ${t.name}`);
        console.log(`    ${t.config.description}`);
        console.log(`    Source: ${t.source}`);
        console.log(`    Framework: ${t.config.framework || 'unknown'}`);
        console.log();
      }

      console.log(`Found ${templates.length} template(s)\n`);
      console.log('Usage:');
      console.log('  smrt gnode create <name> --template=<template-name>');
      console.log('  smrt gnode create my-town --template=sveltekit');
    },
  },
};
