import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, searchForWorkspaceRoot } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [svelte()],
  build: {
    outDir: 'dist',
    rolldownOptions: {
      input: [
        'index',
        'notifications',
        'tools-dock',
        'mcp-apps-binding',
        'mcp-apps-child',
        'mcp-apps-bridge',
        'mcp-apps-bridge-child',
        'file-upload',
        'activity-ticker',
        'phone-heading',
      ].map((entry) =>
        fileURLToPath(new URL(`./${entry}.html`, import.meta.url)),
      ),
    },
  },
  server: { fs: { allow: [searchForWorkspaceRoot(process.cwd())] } },
});
