/**
 * config:export Command
 *
 * Exports agent configuration from the database for static site generation.
 * Useful for SSG sites that need to bundle configuration at build time.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CLICommand } from '../cli-generator.js';

export const configExportCommand: CLICommand = {
  name: 'config:export',
  description: 'Export agent configuration to file',
  aliases: ['export-config'],
  args: [],
  options: {
    agent: {
      type: 'string',
      description: 'Agent ID to export config for (required)',
      short: 'a',
    },
    output: {
      type: 'string',
      description: 'Output file path (default: smrt.exported.json)',
      default: 'smrt.exported.json',
      short: 'o',
    },
    format: {
      type: 'string',
      description: 'Output format: json or js',
      default: 'json',
      short: 'f',
    },
    'include-secrets': {
      type: 'boolean',
      description: 'Include sensitive values (use with caution)',
      default: false,
    },
    slot: {
      type: 'string',
      description: 'Export only a specific slot (e.g., sources, settings)',
      short: 's',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON to stdout instead of file',
      default: false,
      short: 'j',
    },
  },
  handler: async (_args: string[], options: any) => {
    try {
      // 0. Validate required agent option
      if (!options.agent) {
        console.error('\n❌ Agent ID is required');
        console.error('\nUsage: smrt config:export --agent <agent-id>');
        console.error('       smrt config:export -a <agent-id>\n');
        process.exit(1);
      }

      // 1. Load CLI config for database
      const { getPackageConfig } = await import('@happyvertical/smrt-config');
      const { DEFAULT_CLI_CONFIG } = await import('../config.js');
      const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

      // 2. Validate database configuration
      if (!config.database?.url || config.database.url === ':memory:') {
        if (options.json) {
          console.log(JSON.stringify({ error: 'Database not configured' }));
        } else {
          console.error('\n❌ Database configuration required');
          console.error('\nPlease configure database in smrt.config.js\n');
        }
        process.exit(1);
      }

      const dbUrl = config.database.url;
      const dbType = config.database.type || 'sqlite';

      if (!options.json) {
        console.log('\n📦 Exporting Agent Configuration\n');
      }

      // 3. Connect to database
      const { getDatabase } = await import('@happyvertical/sql');
      const db = await getDatabase({ type: dbType, url: dbUrl });

      // 4. Import AgentConfig
      const { AgentConfigCollection } = await import(
        '@happyvertical/smrt-agents'
      );

      const collection = await AgentConfigCollection.create({ db });

      // 5. Query configs for the specified agent
      const agentId = options.agent;
      const whereClause: Record<string, any> = { agentId };

      if (options.slot) {
        whereClause.slotId = options.slot;
      }

      const configs = await collection.list({ where: whereClause });

      if (configs.length === 0) {
        if (options.json) {
          console.log(JSON.stringify({ agentId, configs: {} }));
        } else {
          console.log(`⚠️  No configurations found for agent: ${agentId}`);
          if (options.slot) {
            console.log(`   Slot filter: ${options.slot}`);
          }
        }
        process.exit(0);
      }

      // 6. Build export object
      const exportData: Record<string, any> = {};

      for (const cfg of configs) {
        exportData[cfg.slotId] = cfg.configData;
      }

      // 7. Sanitize if needed
      const { exportConfig } = await import('@happyvertical/smrt-config');

      const outputFormat = options.format === 'js' ? 'js' : 'json';
      const includeSecrets = options['include-secrets'] === true;

      const exported = exportConfig(exportData, {
        format: outputFormat,
        includeSecrets,
      });

      // 8. Output
      if (options.json) {
        // Output raw JSON to stdout
        console.log(JSON.stringify({ agentId, configs: exportData }, null, 2));
        return;
      }

      // Write to file
      const outputPath = path.resolve(process.cwd(), options.output);
      const outputDir = path.dirname(outputPath);

      // Ensure output directory exists
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      fs.writeFileSync(outputPath, exported, 'utf-8');

      console.log(`✓ Exported configuration for agent: ${agentId}`);
      console.log(
        `  Slots: ${configs.map((c: { slotId: string }) => c.slotId).join(', ')}`,
      );
      console.log(`  Output: ${outputPath}`);
      console.log(`  Format: ${outputFormat}`);

      if (!includeSecrets) {
        console.log(`  Secrets: filtered (use --include-secrets to include)`);
      } else {
        console.log(`  ⚠️  Secrets: INCLUDED (handle with care)`);
      }

      console.log('\n💡 Usage in smrt.config.js:');
      console.log('');
      if (outputFormat === 'json') {
        console.log(
          `  import exported from './${path.basename(outputPath)}' with { type: 'json' };`,
        );
      } else {
        console.log(`  import exported from './${path.basename(outputPath)}';`);
      }
      console.log('');
      console.log('  export default {');
      console.log('    modules: {');
      console.log('      myAgent: {');
      console.log('        ...exported,');
      console.log('        // environment-specific overrides');
      console.log('      }');
      console.log('    }');
      console.log('  };');
      console.log('');
    } catch (error) {
      if (options.json) {
        console.log(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } else {
        console.error('\n❌ Failed to export configuration:');
        if (error instanceof Error) {
          console.error(`   ${error.message}`);
        }
      }
      process.exit(1);
    }
  },
};
