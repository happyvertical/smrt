/**
 * Verbosity helper and once-per-process summary guard for smrt-vitest's own
 * console output.
 *
 * Deliberately a small leaf module with no dependency on `./index.ts` (and
 * not re-exported from it): `setup.ts` imports `./index.js` dynamically on
 * purpose, to keep its own static import graph free of the full Vite-plugin
 * module and its stack-attribution side effects (see the comment on
 * `ensureManifestsRegisteredInThisProcess` in `setup.ts`). This module is
 * safe for `setup.ts` (or anything else) to import statically.
 *
 * @packageDocumentation
 */

/**
 * True when smrt-vitest's own diagnostic ("verbose") logging should be
 * emitted: the plugin option, the shared `SMRT_VERBOSE` env convention, or
 * `DEBUG` containing `smrt` (mirrors
 * `packages/core/src/manifest/discover-smrt-packages.ts`).
 */
export function isVerbose(optionVerbose?: boolean): boolean {
  return (
    optionVerbose === true ||
    process.env.SMRT_VERBOSE === 'true' ||
    (process.env.DEBUG ?? '').includes('smrt')
  );
}

const SUMMARY_LOGGED_KEY = Symbol.for(
  '@happyvertical/smrt-vitest:manifest-summary-logged',
);

interface SummaryFlagHolder {
  [SUMMARY_LOGGED_KEY]?: boolean;
}

/**
 * Returns `true` the first time it is called in this process, and `false`
 * on every later call — used to print the `Loaded manifests from N/M
 * packages` summary at most once per process from the per-test-file setup
 * path, regardless of how many test files run in this worker.
 */
export function shouldLogManifestSummaryOnce(): boolean {
  const holder = globalThis as SummaryFlagHolder;
  if (holder[SUMMARY_LOGGED_KEY]) {
    return false;
  }
  holder[SUMMARY_LOGGED_KEY] = true;
  return true;
}
