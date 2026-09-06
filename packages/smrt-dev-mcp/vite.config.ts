import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

const packageDir = resolve(__dirname);

export default defineConfig({
  plugins: [
    {
      name: 'smrt-dev-mcp-executable-entrypoint',
      writeBundle() {
        chmodSync(resolve(packageDir, 'dist/index.js'), 0o755);
      },
    },
    dts({
      outDir: resolve(packageDir, 'dist'),
      entryRoot: resolve(packageDir, 'src'),
      include: [resolve(packageDir, 'src/**/*')],
      exclude: ['**/*.test.ts', '**/*.spec.ts'],
      insertTypesEntry: false,
      rollupTypes: false,
      tsconfigPath: resolve(packageDir, 'tsconfig.json'),
      clearPureImport: true,
    }),
  ],
  build: {
    lib: {
      entry: {
        index: resolve(packageDir, 'src/index.ts'),
        knowledge: resolve(packageDir, 'src/knowledge.ts'),
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
