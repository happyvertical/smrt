/**
 * SMRT Init Command
 *
 * Initialize SMRT in an existing SvelteKit project
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CLICommand } from '../cli-generator.js';

/**
 * Template for smrt.config.ts
 */
const SMRT_CONFIG_TEMPLATE = `/**
 * SMRT Configuration
 *
 * This file configures the SMRT framework for your project.
 * See: https://github.com/happyvertical/smrt
 */

export default {
  // Global SMRT settings
  smrt: {
    logLevel: 'info',
    schemaMigration: {
      strategy: 'auto-add',
    },
  },

  // Package-specific configuration
  packages: {
    // CLI configuration
    cli: {
      database: {
        type: '{{DATABASE_TYPE}}',
        url: process.env.DATABASE_URL || '{{DATABASE_URL}}',
      },
      verbose: false,
    },

    // AI configuration (optional)
    ai: process.env.OPENAI_API_KEY
      ? {
          provider: 'openai',
          apiKey: process.env.OPENAI_API_KEY,
        }
      : undefined,
  },
};
`;

/**
 * Template for src/lib/server/smrt.ts
 */
const SERVER_SMRT_TEMPLATE = `/**
 * Centralized SMRT Configuration
 *
 * This file provides configuration for all SMRT objects in your project.
 * Import this file in your routes to get properly configured collections.
 */

import { ObjectRegistry, type SmrtClassOptions } from '@happyvertical/smrt-core';

// Import all SMRT objects to register them
import '../objects/index.js';

/**
 * Per-object configuration overrides
 *
 * Use this to configure specific objects differently from defaults.
 * Example:
 *   AuditLog: { db: { url: process.env.AUDIT_DB_URL!, type: 'postgres' } }
 */
const objectOverrides: Record<string, Partial<SmrtClassOptions>> = {
  // Add object-specific overrides here
};

/**
 * Get default configuration for SMRT objects
 */
function getDefaultConfig(): SmrtClassOptions {
  return {
    db: {
      url: process.env.DATABASE_URL || './data/app.db',
      type: (process.env.DATABASE_TYPE as 'sqlite' | 'postgres') || 'sqlite',
    },
    ai: process.env.OPENAI_API_KEY
      ? {
          type: 'openai',
          apiKey: process.env.OPENAI_API_KEY,
        }
      : undefined,
  };
}

/**
 * Get configuration for a specific SMRT class
 */
export function getSmrtConfig(className: string): SmrtClassOptions {
  const defaults = getDefaultConfig();
  const override = objectOverrides[className];
  return override ? { ...defaults, ...override } : defaults;
}

/**
 * Get a collection instance for a SMRT class
 *
 * Usage in routes:
 *   const products = await getCollection<Product>('Product');
 *   const items = await products.list();
 */
export async function getCollection<T>(className: string) {
  return await ObjectRegistry.getCollection<T>(className, getSmrtConfig(className));
}
`;

/**
 * Template for src/lib/objects/index.ts
 */
const OBJECTS_INDEX_TEMPLATE = `/**
 * SMRT Objects Index
 *
 * Export all SMRT objects from this file.
 * They will be automatically registered and available for CLI/API/MCP.
 */

// Export your SMRT objects here
// Example: export { Product } from './Product.js';
`;

/**
 * Template for src/lib/objects/Example.ts
 */
const EXAMPLE_OBJECT_TEMPLATE = `/**
 * Example SMRT Object
 *
 * This is a sample SMRT object to demonstrate the pattern.
 * You can delete this file and create your own objects.
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  api: {
    include: ['list', 'get', 'create', 'update', 'delete', 'summarize'],
  },
  cli: { include: ['list', 'get', 'summarize'] },
})
export class Example extends SmrtObject {
  title: string = '';
  content: string = '';
  createdAt: Date = new Date();

  /**
   * AI-powered summarization
   */
  async summarize(): Promise<string> {
    return await this.do('Create a brief summary of this content');
  }
}
`;

/**
 * Template for .env.example
 */
const ENV_EXAMPLE_TEMPLATE = `# Database
DATABASE_URL=./data/app.db
DATABASE_TYPE=sqlite

# AI Provider (optional)
OPENAI_API_KEY=
# ANTHROPIC_API_KEY=

# Site
PUBLIC_SITE_NAME=My SMRT App
PUBLIC_SITE_URL=http://localhost:5173
`;

/**
 * Gitignore additions for SMRT
 */
const GITIGNORE_ADDITIONS = `
# SMRT auto-generated
src/routes/api/**/+server.ts
src/lib/server/smrt-register.ts
src/lib/types/smrt-generated/

# Database
*.db
*.db-journal
data/
`;

/**
 * Init commands
 */
export const initCommands: Record<string, CLICommand> = {
  init: {
    name: 'init',
    description: 'Initialize SMRT in an existing SvelteKit project',
    aliases: ['setup'],
    args: [],
    options: {
      database: {
        type: 'string',
        description: 'Database type (sqlite|postgres)',
        default: 'sqlite',
        short: 'd',
      },
      force: {
        type: 'boolean',
        description: 'Overwrite existing files',
        default: false,
        short: 'f',
      },
      'skip-example': {
        type: 'boolean',
        description: 'Skip creating example object',
        default: false,
      },
    },
    handler: async (_args: string[], options: any) => {
      console.log('\n🚀 Initializing SMRT in your project...\n');

      const cwd = process.cwd();
      const dbType = options.database || 'sqlite';
      const dbUrl =
        dbType === 'sqlite' ? './data/app.db' : 'postgres://localhost/app';

      // Check if this looks like a SvelteKit project
      const packageJsonPath = resolve(cwd, 'package.json');
      if (!existsSync(packageJsonPath)) {
        console.error(
          '❌ No package.json found. Are you in a project directory?',
        );
        process.exit(1);
      }

      let packageJson: any;
      try {
        packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      } catch {
        console.error('❌ Failed to parse package.json');
        process.exit(1);
      }

      const isSvelteKit =
        packageJson.devDependencies?.['@sveltejs/kit'] ||
        packageJson.dependencies?.['@sveltejs/kit'];

      if (!isSvelteKit) {
        console.warn('⚠️  This does not appear to be a SvelteKit project.');
        console.warn(
          '   SMRT init is designed for SvelteKit. Continuing anyway...\n',
        );
      }

      // Track what we create
      const created: string[] = [];
      const skipped: string[] = [];

      // Helper to write file
      const writeFile = (
        path: string,
        content: string,
        description: string,
      ) => {
        const fullPath = resolve(cwd, path);
        if (existsSync(fullPath) && !options.force) {
          skipped.push(`${path} (already exists)`);
          return false;
        }

        // Ensure directory exists
        const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
        if (dir && !existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }

        writeFileSync(fullPath, content);
        created.push(`${path} - ${description}`);
        return true;
      };

      // 1. Create smrt.config.ts
      const smrtConfig = SMRT_CONFIG_TEMPLATE.replace(
        '{{DATABASE_TYPE}}',
        dbType,
      ).replace('{{DATABASE_URL}}', dbUrl);
      writeFile('smrt.config.ts', smrtConfig, 'SMRT configuration');

      // 2. Create src/lib/server/smrt.ts
      writeFile(
        'src/lib/server/smrt.ts',
        SERVER_SMRT_TEMPLATE,
        'Centralized SMRT config',
      );

      // 3. Create src/lib/objects/index.ts
      writeFile(
        'src/lib/objects/index.ts',
        OBJECTS_INDEX_TEMPLATE,
        'Objects index',
      );

      // 4. Create example object (unless skipped)
      if (!options.skipExample) {
        writeFile(
          'src/lib/objects/Example.ts',
          EXAMPLE_OBJECT_TEMPLATE,
          'Example SMRT object',
        );
      }

      // 5. Create .env.example (if doesn't exist)
      writeFile('.env.example', ENV_EXAMPLE_TEMPLATE, 'Environment example');

      // 6. Update .gitignore
      const gitignorePath = resolve(cwd, '.gitignore');
      if (existsSync(gitignorePath)) {
        const currentGitignore = readFileSync(gitignorePath, 'utf-8');
        if (!currentGitignore.includes('SMRT auto-generated')) {
          writeFileSync(gitignorePath, currentGitignore + GITIGNORE_ADDITIONS);
          created.push('.gitignore - Added SMRT patterns');
        } else {
          skipped.push('.gitignore (already has SMRT patterns)');
        }
      } else {
        writeFile('.gitignore', GITIGNORE_ADDITIONS.trim(), 'Git ignore file');
      }

      // 7. Create data directory for SQLite
      if (dbType === 'sqlite') {
        const dataDir = resolve(cwd, 'data');
        if (!existsSync(dataDir)) {
          mkdirSync(dataDir, { recursive: true });
          created.push('data/ - Database directory');
        }
      }

      // 8. Check if @happyvertical/smrt-core is installed
      const hasSmrt =
        packageJson.dependencies?.['@happyvertical/smrt-core'] ||
        packageJson.devDependencies?.['@happyvertical/smrt-core'];

      // Report results
      console.log('✅ Created files:');
      for (const file of created) {
        console.log(`   • ${file}`);
      }

      if (skipped.length > 0) {
        console.log('\n⏭️  Skipped (use --force to overwrite):');
        for (const file of skipped) {
          console.log(`   • ${file}`);
        }
      }

      // Next steps
      console.log('\n📋 Next steps:\n');

      if (!hasSmrt) {
        console.log('1. Install SMRT:');
        console.log('   npm install @happyvertical/smrt-core\n');
      }

      console.log('2. Update your vite.config.ts to add smrtPlugin:');
      console.log(`
   import { sveltekit } from '@sveltejs/kit/vite';
   import { smrtPlugin } from '@happyvertical/smrt-core/vite-plugin';
   import { defineConfig } from 'vite';

   export default defineConfig({
     plugins: [
       sveltekit(),
       smrtPlugin({
         include: ['src/lib/objects/**/*.ts'],
         exclude: ['**/*.test.ts'],
         generateTypes: true,
         svelteKit: {
           enabled: true,
           routesDir: 'src/routes/api',
           objectsDir: 'src/lib/objects',
           configPath: 'src/lib/server',
         },
       }),
     ],
   });
`);

      console.log('3. Create your SMRT objects in src/lib/objects/');
      console.log('   (See Example.ts for the pattern)');
      console.log('\n4. Export objects from src/lib/objects/index.ts');
      console.log('\n5. Run: npm run dev');
      console.log('   API routes will auto-generate in src/routes/api/\n');

      console.log('💡 Useful commands:');
      console.log('   smrt objects         - List discovered objects');
      console.log('   smrt introspect      - Analyze project');
      console.log('   smrt db:setup        - Initialize database\n');
    },
  },
};
