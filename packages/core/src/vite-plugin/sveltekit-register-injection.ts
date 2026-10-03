/**
 * Register generated objects before the application's server config module
 * runs (#3416).
 *
 * The config module (`src/lib/server/smrt.ts` by default) creates the app
 * runtime and is the first SMRT module the server imports (`hooks.server.ts`,
 * page loads, and the generated route-access module all import it). The
 * plugin generates `smrt-register.ts` beside it on every dev/build run, so it
 * prepends that import to the config module instead of each application
 * hand-writing it behind a "not generated yet" guard. Registration stays the
 * generated module's deterministic `consumer.packages` + local-object order.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** File name of the generated registration module beside the config module. */
export const SVELTEKIT_REGISTRATION_FILE_NAME = 'smrt-register.ts';

const REGISTRATION_IMPORT = "import './smrt-register.js';";

export interface SvelteKitRegisterInjectionOptions {
  projectRoot: string;
  configPath?: string;
  configFileName?: string;
}

function normalizeModulePath(id: string): string {
  return resolve(id.replace(/[?#].*$/, '')).replace(/\\/g, '/');
}

/**
 * Return `code` with the generated registration import prepended when `id` is
 * the configured config module and the registration module exists; otherwise
 * `null`. The import shares the first line, so later line numbers are kept.
 */
export function injectSvelteKitRegistration(
  code: string,
  id: string,
  options: SvelteKitRegisterInjectionOptions,
): string | null {
  const configDir = resolve(
    options.projectRoot,
    options.configPath || 'src/lib/server',
  );
  const configFile = join(configDir, options.configFileName || 'smrt.ts');
  if (normalizeModulePath(id) !== normalizeModulePath(configFile)) return null;
  if (!existsSync(join(configDir, SVELTEKIT_REGISTRATION_FILE_NAME))) {
    return null;
  }
  return `${REGISTRATION_IMPORT}${code}`;
}
