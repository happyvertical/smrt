/**
 * A downstream app's build, against the installed release packages: the
 * build plugin scans this app's own @smrt() objects into .smrt/manifest.json,
 * and the consumer plugin merges smrt-core's published manifest into that file
 * and generates .smrt/register.js.
 */
import { fileURLToPath } from 'node:url';
import { smrtConsumer } from '@happyvertical/smrt-core/consumer-plugin';
import { smrtPlugin } from '@happyvertical/smrt-core/vite-plugin';
import { defineConfig } from 'vite';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  plugins: [
    smrtPlugin({ projectRoot, mode: 'server', generateTypes: false }),
    smrtConsumer({
      packages: ['@happyvertical/smrt-core', '@happyvertical/smrt-tags'],
      projectRoot,
      generateTypes: false,
    }),
  ],
  build: {
    ssr: true,
    outDir: 'dist',
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'index' },
    rollupOptions: { external: [/^@happyvertical\//, /^node:/] },
  },
});
