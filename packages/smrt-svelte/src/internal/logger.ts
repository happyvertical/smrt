/**
 * Shared package logger for `@happyvertical/smrt-svelte`.
 *
 * This module is browser-reachable (Provider + the form components import it),
 * so it must never touch Node globals at module scope. `createLogger()` reads
 * `HAVE_LOGGER_LEVEL` from `process.env`, and `process` does not exist in
 * browsers — calling it during module init threw
 * `ReferenceError: process is not defined` under `vite dev` and killed
 * client-side hydration for every consuming app. The logger is therefore
 * created lazily on first use, and the env-config path is only consulted when
 * a usable `process.env` actually exists; browsers get the plain console
 * logger at the same level.
 *
 * Centralising the instance keeps voice/AI error reporting consistent across
 * the form components (mic permission denials, STT init failures) instead of
 * swallowing them in empty `catch` blocks or scattering raw `console.*` calls.
 */
import {
  ConsoleLogger,
  createLogger,
  type Logger,
} from '@happyvertical/logger';

const LEVEL = 'warn';

let instance: Logger | undefined;

function resolveLogger(): Logger {
  if (!instance) {
    const hasProcessEnv =
      typeof process !== 'undefined' &&
      typeof process.env === 'object' &&
      process.env !== null;
    instance = hasProcessEnv
      ? createLogger({ level: LEVEL })
      : new ConsoleLogger(LEVEL);
  }
  return instance;
}

export const logger: Logger = {
  debug: (message, context) => resolveLogger().debug(message, context),
  info: (message, context) => resolveLogger().info(message, context),
  warn: (message, context) => resolveLogger().warn(message, context),
  error: (message, context) => resolveLogger().error(message, context),
};
