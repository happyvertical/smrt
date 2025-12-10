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
  dependencies: {
    '@happyvertical/smrt-core': '^0.17.0',
    '@happyvertical/smrt-config': '^0.17.0',
    '@happyvertical/svelte': '^0.17.0',
    '@happyvertical/smrt-content': '^0.17.0',
    '@happyvertical/smrt-events': '^0.17.0',
    '@happyvertical/smrt-places': '^0.17.0',
    '@happyvertical/smrt-profiles': '^0.17.0',
    caelus: '^0.1.4',
  },

  devDependencies: {
    '@happyvertical/praeco': '^0.0.42',
    '@sveltejs/adapter-static': '^3.0.0',
    '@sveltejs/kit': '^2.16.0',
    '@sveltejs/vite-plugin-svelte': '^5.0.0',
    svelte: '^5.15.0',
    'svelte-check': '^4.1.0',
    typescript: '^5.0.0',
    vite: '^6.0.0',
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
