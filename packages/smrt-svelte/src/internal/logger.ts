/**
 * Shared package logger for `@happyvertical/smrt-svelte`.
 *
 * Browser-safe: the `@happyvertical/logger` console adapter pulls no Node
 * built-ins and its `@sentry/node` integration is an optional peer that is
 * never imported here. Centralising the instance keeps voice/AI error reporting
 * consistent across the form components (mic permission denials, STT init
 * failures) instead of swallowing them in empty `catch` blocks or scattering
 * raw `console.*` calls.
 */
import { createLogger, type Logger } from '@happyvertical/logger';

export const logger: Logger = createLogger({ level: 'warn' });
