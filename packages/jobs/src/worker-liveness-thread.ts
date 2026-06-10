/**
 * Worker-thread entry for the off-loop liveness ticker.
 *
 * Thin shell: read {@link LivenessTickerOptions} from `workerData`, start the
 * ticker, and stop it on a `'stop'` message from the parent. All real logic
 * lives in {@link runLivenessTicker} so it can be unit-tested without spawning
 * a thread. Keep this file decorator-free so Node type-stripping can run the
 * `.ts` directly under vitest.
 */
import { parentPort, workerData } from 'node:worker_threads';
import {
  type LivenessTickerOptions,
  runLivenessTicker,
} from './worker-liveness-ticker.js';

async function main(): Promise<void> {
  const ticker = await runLivenessTicker(workerData as LivenessTickerOptions);

  parentPort?.on('message', async (message) => {
    if (message === 'stop') {
      await ticker.stop();
      parentPort?.postMessage('stopped');
    }
  });

  // Signal the parent that the lease is seeded and renewal is running.
  parentPort?.postMessage('ready');
}

main().catch((error) => {
  // Surface startup failure to the parent so the runner can fall back to
  // main-loop renewal rather than silently losing its lease.
  parentPort?.postMessage({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
  });
});
