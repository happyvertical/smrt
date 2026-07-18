/**
 * SvelteKit Template Configuration
 *
 * This file configures the template for use with `smrt gnode create`
 *
 * Version pins are kept in sync with `template/package.json` and the rest of
 * the s-m-r-t monorepo. Any changes here MUST be mirrored in
 * `template/package.json` so generated projects match the tracked template.
 */

export default {
  name: 'sveltekit',
  description: 'Minimal SvelteKit project with s-m-r-t integration',
  framework: 'sveltekit',
  version: '1.0.0',

  // Template directory location (relative to this config file)
  templateDir: './template',

  // Dependencies to add to generated project
  dependencies: {
    '@happyvertical/smrt-core': '^0.40.10',
    '@happyvertical/smrt-profiles': '^0.40.10',
    '@happyvertical/smrt-svelte': '^0.40.10',
    '@happyvertical/smrt-tenancy': '^0.40.10',
    '@happyvertical/smrt-ui': '^0.40.10',
    '@happyvertical/smrt-users': '^0.40.10',
  },

  devDependencies: {
    '@happyvertical/smrt-cli': '^0.40.10',
    '@sveltejs/adapter-auto': '^7.0.1',
    '@sveltejs/kit': '^2.69.2',
    '@sveltejs/vite-plugin-svelte': '^7.2.0',
    '@types/node': '^24.13.3',
    'svelte': '^5.56.4',
    'svelte-check': '^4.7.2',
    'typescript': '^6.0.3',
    'vite': '^8.1.4',
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
      console.log('  pnpm install');
      console.log('  pnpm db:migrate');
      console.log('  pnpm dev');
      console.log();
    },
  },
};
