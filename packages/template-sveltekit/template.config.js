/**
 * SvelteKit Template Configuration
 *
 * This file configures the template for use with `smrt gnode create`
 */

export default {
  name: 'sveltekit',
  description: 'SvelteKit project with SMRT framework integration',
  framework: 'sveltekit',
  version: '1.0.0',

  // Template directory location (relative to this config file)
  templateDir: './template',

  // Dependencies to add to generated project
  dependencies: {
    '@happyvertical/smrt-core': '^0.17.0',
  },

  devDependencies: {
    '@sveltejs/adapter-auto': '^6.0.0',
    '@sveltejs/kit': '^2.16.0',
    '@sveltejs/vite-plugin-svelte': '^5.0.0',
    'svelte': '^5.15.0',
    'svelte-check': '^4.1.0',
    'typescript': '^5.0.0',
    'vite': '^6.0.0',
  },

  // Optional: customize files
  files: {
    // Rename patterns during generation
    rename: {},
    // Skip certain files
    skip: ['.gitkeep'],
    // Append/merge patterns
    append: {},
  },

  // Placeholder substitutions
  placeholders: {
    '{{PROJECT_NAME}}': (ctx) => ctx.name,
    '{{PACKAGE_NAME}}': (ctx) => ctx.name.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
  },

  // Post-generation hooks
  hooks: {
    afterGenerate: async (ctx) => {
      console.log(`\n✅ Created ${ctx.name} successfully!`);
      console.log('\nNext steps:');
      console.log(`  cd ${ctx.name}`);
      console.log('  npm install');
      console.log('  npm run dev');
      console.log();
    },
  },
};
