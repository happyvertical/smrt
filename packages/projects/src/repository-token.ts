/**
 * Token resolution for repository providers.
 *
 * Only the config key is persisted on a Repository; the secret itself is read
 * from the environment or module config at call time.
 */

import { getModuleConfig } from '@happyvertical/smrt-config';

/**
 * Resolve a provider token from `tokenConfigKey`.
 *
 * Order: environment variable of that name, then the `smrt-projects` module
 * config entry of that name.
 *
 * @param tokenConfigKey - Environment variable name or module config key
 * @returns The token
 * @throws Error when no token is configured under that key
 */
export function resolveRepositoryToken(tokenConfigKey: string): string {
  const token =
    process.env[tokenConfigKey] ||
    (getModuleConfig<Record<string, string>>('smrt-projects', {})[
      tokenConfigKey
    ] as string);
  if (!token) {
    throw new Error(
      `Token not found for key '${tokenConfigKey}'. ` +
        `Set the ${tokenConfigKey} environment variable or configure it in smrt.config.`,
    );
  }
  return token;
}
