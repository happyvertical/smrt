import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';

// Plugin to add cross-origin isolation headers
function crossOriginIsolation(): Plugin {
  return {
    name: 'cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        next();
      });
    },
  };
}

// Node.js-only packages that should not be bundled for browser
const nodeOnlyPackages = [
  '@happyvertical/utils',
  '@happyvertical/sql',
  '@happyvertical/ai',
  '@happyvertical/files',
  '@happyvertical/smrt-core',
  '@happyvertical/smrt-agents',
  '@happyvertical/smrt-profiles',
];

export default defineConfig({
  plugins: [crossOriginIsolation(), sveltekit()],
  server: {
    port: 5555,
  },
  // Treat native .node files as assets (fixes oxc-parser bundling issue)
  assetsInclude: ['**/*.node'],
  optimizeDeps: {
    exclude: ['@remotion/whisper-web', ...nodeOnlyPackages],
  },
  ssr: {
    // External packages with Node.js-only dependencies
    // These will be loaded from node_modules at runtime during SSR
    external: nodeOnlyPackages,
    // Don't externalize packages with .svelte files so they can be properly compiled
    noExternal: [
      '@happyvertical/smrt-svelte',
      '@happyvertical/smrt-users',
      '@happyvertical/smrt-commerce',
    ],
  },
  build: {
    rollupOptions: {
      // Exclude native modules and Node.js packages from client bundle
      external: [/\.node$/, ...nodeOnlyPackages],
    },
  },
});
