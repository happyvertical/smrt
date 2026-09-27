import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { declarations } from '../../scripts/declarations.js';

const packageDir = resolve(__dirname);

export default defineConfig({
  plugins: [
    {
      name: 'smrt-dev-mcp-executable-entrypoint',
      writeBundle() {
        chmodSync(resolve(packageDir, 'dist/index.js'), 0o755);
      },
    },
    declarations({ packageDir: __dirname }),
  ],
  build: {
    lib: {
      entry: {
        index: resolve(packageDir, 'src/index.ts'),
        knowledge: resolve(packageDir, 'src/knowledge.ts'),
        'dev-plane': resolve(packageDir, 'src/dev-plane.ts'),
        runtime: resolve(packageDir, 'src/runtime.ts'),
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: [
        /^@modelcontextprotocol\//,
        /^@happyvertical\/smrt-core/,
        /^@happyvertical\/smrt-scanner/,
        /^@happyvertical\/smrt-config/,
        /^@happyvertical\/sql/,
        /^node:/,
      ],
      output: {
        banner: (chunk) =>
          chunk.name === 'index' ? '#!/usr/bin/env node' : '',
      },
    },
    target: 'esnext',
    minify: false,
    sourcemap: true,
  },
});
