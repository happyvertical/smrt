import type { UserConfig } from 'vite';
import { createPackageConfig } from '../../vite.config.base.js';

const baseConfig = createPackageConfig('app-runtime', {
  entries: ['sveltekit'],
});

/**
 * `@sveltejs/kit` is an optional peer used only by the `./sveltekit` entry.
 * It must resolve to the consumer's single copy: SvelteKit recognizes
 * `redirect()` / `fail()` results by class identity, so bundling it would
 * silently break form actions.
 */
export default async (
  env: Parameters<typeof baseConfig>[0],
): Promise<UserConfig> => {
  const config = await baseConfig(env);
  const rollupOptions = config.build?.rollupOptions ?? {};
  const external = rollupOptions.external;
  return {
    ...config,
    build: {
      ...config.build,
      rollupOptions: {
        ...rollupOptions,
        external: [
          ...(Array.isArray(external) ? external : external ? [external] : []),
          /^@sveltejs\/kit(\/|$)/,
        ] as (string | RegExp)[],
      },
    },
  };
};
