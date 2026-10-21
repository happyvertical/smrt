import type { UserConfig } from 'vite';
import { createPackageConfig } from '../../vite.config.base.js';

const baseConfig = createPackageConfig('users', {
  entries: ['app-contract', 'operator', 'sveltekit', 'ui', 'playground'],
  svelte: 'svelte',
});

/**
 * The WebAuthn libraries stay external (#3275). `@simplewebauthn/server`
 * brings `reflect-metadata`, which must resolve to the consumer's one copy and
 * is only ever loaded on first use (see `PasskeyCredentialService`); inlining
 * it would bundle ~650 kB of CBOR/X.509 code into every consumer of this
 * package, passkeys or not.
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
