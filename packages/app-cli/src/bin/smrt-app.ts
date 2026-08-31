// Shebang is injected at build time via vite.config.ts (rollupOptions.output.banner).
/**
 * `smrt-app` — configuration-driven executable for a published SMRT app CLI.
 *
 * The wrapper accepts non-secret identity before `--`; everything after `--`
 * is forwarded unchanged to the canonical `createAppCli` command dispatcher.
 */

import { runAppCliExecutable } from '../executable.js';

try {
  await runAppCliExecutable();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown error.';
  process.stderr.write(`smrt-app: ${message}\n`);
  process.exitCode = 2;
}
