/**
 * SvelteKit Template Configuration
 *
 * This file configures the template for use with `smrt gnode create`
 *
 * Version pins are kept in sync with `template/package.json` and the rest of
 * the SMRT monorepo (see packages/smrt-svelte/package.json for the canonical
 * Svelte 5 + Vite 7 baseline). Any changes here MUST be mirrored in
 * `template/package.json` so generated projects match the tracked template.
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
    '@happyvertical/smrt-core': '^0.37.3',
  },

  devDependencies: {
    '@sveltejs/adapter-auto': '^7.0.1',
    '@sveltejs/kit': '^2.46.0',
    '@sveltejs/vite-plugin-svelte': '^6.2.4',
    'svelte': '^5.18.0',
    'svelte-check': '^4.3.5',
    'typescript': '^5.9.3',
    'vite': '^7.3.1',
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
