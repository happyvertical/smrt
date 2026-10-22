import type { UserConfig } from 'vite';
import { createPackageConfig } from '../../vite.config.base.js';

const baseConfig = createPackageConfig('users', {
  entries: ['app-contract', 'operator', 'sveltekit', 'ui', 'playground'],
  svelte: 'svelte',
});

/**
 * The WebAuthn libraries stay external (#3275): they are declared
 * `dependencies`, so the consumer resolves them (one copy of
 * `reflect-metadata` and its CBOR/X.509 stack) instead of inlining ~650 kB
 * into every consumer of this package, passkeys or not.
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
          /^@simplewebauthn\//,
        ] as (string | RegExp)[],
      },
    },
  };
};
