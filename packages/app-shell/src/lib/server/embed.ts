/**
 * Types of `@happyvertical/smrt-app-shell/embed` (#5546). The runtime is
 * `build/embed.js` (`tools/embed-entry.js`, written by `svelte.config.js`),
 * which `package.json` maps beside these declarations; nothing imports this
 * file for its values.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  Drain,
  DrainCall,
  ShutdownResult,
  ShutdownStep,
  StepStatus,
} from './shutdown.ts';

export type { Drain, DrainCall, ShutdownResult, ShutdownStep, StepStatus };

/** Request listener for `http.createServer`, or middleware for Express/Connect/Polka. */
export declare const handler: (
  req: IncomingMessage,
  res: ServerResponse,
  next?: (error?: unknown) => void,
) => unknown;

/**
 * Stop taking new work and close the shell: end event streams, wait for
 * running imports, close every open app. Does not close a listener, install a
 * signal handler or exit. Call it after your readiness endpoint answers 503.
 * Safe to call twice (the same promise); never rejects; resolves by the
 * `SMRT_APP_SHELL_SHUTDOWN_MS` deadline (default 30 s) plus one second.
 */
export declare const drain: Drain;
