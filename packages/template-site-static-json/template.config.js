/**
 * Static Site Template Configuration
 *
 * Template for community news sites with:
 * - JSON-based data storage
 * - Static site generation (SvelteKit)
 * - Weather integration (Caelus)
 * - Meeting scraping (Praeco)
 * - Config-driven site identity
 */

export default {
  name: 'site-static-json',
  description: 'Static community site with JSON data storage',
  framework: 'sveltekit',
  version: '1.0.0',

  // Template directory location
  templateDir: './template',

  // Dependencies for generated project
  // Note: template/package.json intentionally has empty dependencies/devDependencies;
  // the scaffolder injects the entries below at generation time, so this file is
  // the single source of truth for dependency versions.
  dependencies: {
    '@happyvertical/smrt-core': '^0.38.6',
    '@happyvertical/smrt-config': '^0.38.6',
    '@happyvertical/smrt-ui': '^0.38.6',
    '@happyvertical/smrt-content': '^0.38.6',
    '@happyvertical/smrt-events': '^0.38.6',
    '@happyvertical/smrt-places': '^0.38.6',
    '@happyvertical/smrt-profiles': '^0.38.6',
    '@happyvertical/caelus': '^0.1.385',
  },

  devDependencies: {
    '@happyvertical/praeco': '^0.2.398',
    '@sveltejs/adapter-static': '^3.0.10',
    '@sveltejs/kit': '^2.55.0',
    '@sveltejs/vite-plugin-svelte': '^6.2.4',
    svelte: '^5.18.0',
    'svelte-check': '^4.3.5',
    typescript: '^5.9.3',
    vite: '^7.3.1',
    tsx: '^4.0.0',
  },

  // Placeholder substitutions for template files
  placeholders: {
    '{{SITE_NAME}}': (ctx) => ctx.siteName,
    '{{SITE_SHORT_NAME}}': (ctx) => {
      // Extract first part of location or use site name
      const loc = ctx.location || ctx.siteName;
      return loc.split(',')[0].trim();
    },
    '{{PACKAGE_NAME}}': (ctx) => ctx.name.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
    '{{LOCATION_NAME}}': (ctx) => ctx.location || ctx.siteName,
    '{{LATITUDE}}': (ctx) => String(ctx.latitude || 0),
    '{{LONGITUDE}}': (ctx) => String(ctx.longitude || 0),
    '{{TIMEZONE}}': (ctx) => ctx.timezone || 'America/Edmonton',
  },

  // Files configuration
  files: {
    skip: ['.gitkeep'],
  },

  // Post-generation hooks
  hooks: {
    afterGenerate: async (ctx) => {
      console.log(`\n  Site "${ctx.siteName}" created successfully!`);
      console.log('\nNext steps:');
      console.log(`  cd ${ctx.name}`);
      console.log('  pnpm install');
      console.log('  cp .env.example .env');
      console.log('  pnpm run init-data');
      console.log('  pnpm dev');
      console.log();
      console.log('To configure your site:');
      console.log('  1. Edit smrt.config.js to add Praeco sources (councils)');
      console.log('  2. Customize about/contact page content');
      console.log('  3. Update theme colors in smrt.config.js');
      console.log();
    },
  },
};
