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
    // Only packages whose object manifests this app consumes belong here.
    // Keeping the list explicit avoids treating tooling/UI packages as domain
    // model providers and makes generated runtime registration deterministic.
    smrtConsumer({
      packages: [
        '@happyvertical/smrt-profiles',
        '@happyvertical/smrt-tenancy',
        '@happyvertical/smrt-users',
      ],
      generateTypes: true,
      typesDir: 'src/lib/types/smrt-generated',
      svelteKit: true,
    }),
    smrtPlugin({
      include: ['src/lib/objects/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts'],
      generateTypes: true,
      typeDeclarationsPath: 'src/lib/types/smrt-generated',
      svelteKit: {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        configPath: 'src/lib/server',
        configFileName: 'smrt.ts',
      },
    }),
  ],
});
