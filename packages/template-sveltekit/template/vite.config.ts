import { sveltekit } from '@sveltejs/kit/vite';
import { smrtConsumer } from '@happyvertical/smrt-core/consumer-plugin';
import { smrtPlugin } from '@happyvertical/smrt-core/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
  // Lower `@smrt()` legacy (experimentalDecorators) decorators explicitly.
  // tsconfig.json sets experimentalDecorators, but Vite's oxc transform does
  // not reliably honor it through the SvelteKit `extends
  // "./.svelte-kit/tsconfig.json"` chain — raw `@decorator class` syntax then
  // reaches the SSR runtime and throws `SyntaxError: Invalid or unexpected
  // token` on the first request.
  oxc: {
    decorator: {
      legacy: true,
      emitDecoratorMetadata: true,
    },
  },
  plugins: [
    sveltekit(),
    smrtPlugin({
      include: ['src/lib/objects/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts'],
      generateTypes: true,
      svelteKit: {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        configPath: 'src/lib/server',
        configFileName: 'smrt.ts',
      },
    }),
    // Required alongside smrtPlugin(): this project depends on external SMRT
    // packages (@happyvertical/smrt-users, smrt-tenancy, …), and the consumer
    // plugin emits `.smrt/register.js` so their classes load for CLI/runtime.
    smrtConsumer(),
  ],
});
