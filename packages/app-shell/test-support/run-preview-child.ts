// Runs a Node-only fixture producer (jsdom's browser conditions cannot boot
// app models) as a child process. These children boot several real engines and
// a nested vitest run: ~20 s on a quiet machine, 5x that on a CI runner shared
// with other packages (#5014). They exit as soon as the output is written, so a
// tight wall-clock limit only ever fires on load. The limit here is a hang
// detector with an order-of-magnitude margin, not a speed assertion.
import { spawn } from 'node:child_process';

/** Hang guard for one child (typical run ~20 s). */
export const PREVIEW_CHILD_LIMIT_MS = 300_000;
/** Hang guard for the nested vitest run the approval child starts. */
export const PREVIEW_NESTED_LIMIT_MS = 240_000;
/** Vitest test timeout for a test that runs a child: the guard plus headroom. */
export const PREVIEW_TEST_TIMEOUT_MS = PREVIEW_CHILD_LIMIT_MS + 30_000;

export function runPreviewChild(script: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', script, output],
      // stdout is routine logging; keep only the stderr tail for failures.
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: PREVIEW_CHILD_LIMIT_MS },
    );
    let tail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${script} exited with ${signal ?? code} (limit ${PREVIEW_CHILD_LIMIT_MS} ms):\n${tail}`,
            ),
          ),
    );
  });
}
