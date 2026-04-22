/**
 * Import a module that exists in both source (`.ts`) and compiled (`.js`)
 * form, deterministically.
 *
 * # Why this exists
 *
 * The Vite plugin needs to load sibling modules (scanner, schema generator)
 * at runtime. Those siblings ship in two shapes:
 *
 *   src/scanner/index.ts           (workspace dev, tsx-driven)
 *   dist/vite-plugin/../scanner.js (published tarball, plain Node ESM)
 *
 * The previous implementation picked a branch by sniffing
 * `import.meta.url.endsWith('.ts')` and then issued a relative dynamic
 * `import()`. That decision rode on top of tsx's ESM loader, whose
 * interception of `@happyvertical/smrt-core/vite-plugin` varies with tsx
 * version, Node version, pnpm symlink state, and Node's internal resolver
 * cache (first-import wins). As a result, the branch was non-deterministic
 * at publish time and could pick the `.ts` source even though `dist/`
 * existed — then fail inside that source on an inner `.js→.ts` hop. Seen
 * on PR 1131, Release A, Release B, and PR 1141, each time losing the
 * publish for 12–13 downstream domain packages.
 *
 * # How this is deterministic
 *
 * We don't ask tsx anything. We check `<packageRoot>/dist/vite-plugin/<dist>`
 * directly with `fs.existsSync`. If dist is on disk we load it via an
 * absolute `file://` URL — Node's loader doesn't consult tsx for that.
 * If dist is absent (fresh clone, pre-first-build) we fall back to the
 * source path via a plain relative `import()`; at that point tsx is the
 * only way to load `.ts` anyway, so there's no choice to make.
 *
 * # Dev-mode caveat
 *
 * When `dist/` exists, this helper always loads dist — even if a core
 * developer just edited source. That's a deliberate trade: in any
 * meaningful dev loop you have `pnpm build:watch` keeping dist fresh, and
 * the determinism at publish time is worth far more than a hot-reload
 * convenience for the handful of times anyone edits
 * `packages/core/src/scanner/*.ts` directly.
 *
 * @see https://github.com/happyvertical/smrt/issues/1139
 */

import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface ImportBuildAwareOptions {
  /**
   * Relative path to the `.ts` source entry, expressed from the
   * `vite-plugin/` directory (e.g. `'../scanner/index.ts'`). Used only
   * when the corresponding dist file is absent.
   */
  source: string;
  /**
   * Relative path to the compiled `.js` entry, expressed from the
   * `vite-plugin/` directory (e.g. `'../scanner.js'`). Resolved to an
   * absolute path against `<packageRoot>/dist/vite-plugin/` — independent
   * of where the caller physically lives on disk.
   */
  dist: string;
  /**
   * Override for the caller's `import.meta.url`. Tests use this to
   * simulate being loaded from different locations without physically
   * relocating the source file. Defaults to this module's URL, which is
   * equivalent to the caller in the normal production path (both sit in
   * `vite-plugin/`).
   */
  callerUrl?: string;
}

export async function importBuildAwareModule<T>({
  source,
  dist,
  callerUrl = import.meta.url,
}: ImportBuildAwareOptions): Promise<T> {
  const thisFile = fileURLToPath(callerUrl);
  const thisDir = dirname(thisFile);

  // Walk up two levels: `src/vite-plugin/` and `dist/vite-plugin/` both
  // sit at package-root + 2 segments, so the same math works regardless
  // of which copy of the plugin the consumer loaded.
  const packageRoot = resolvePath(thisDir, '..', '..');
  const distAbs = resolvePath(packageRoot, 'dist', 'vite-plugin', dist);

  if (existsSync(distAbs)) {
    // Absolute `file://` URL bypasses tsx's specifier resolver entirely
    // — Node's native loader handles it. Deterministic regardless of
    // whether tsx, pnpm, or Node's resolver cache are in play.
    return (await import(/* @vite-ignore */ pathToFileURL(distAbs).href)) as T;
  }

  // Dist missing → fresh clone before first build. Resolve source to an
  // absolute URL against the caller's directory too, so tsx's loader sees
  // a concrete path and handles the `.ts` transpilation. Using an absolute
  // URL here also means the test harness can synthesize a different
  // caller location without having to juggle relative-to-helper paths.
  const sourceAbs = resolvePath(thisDir, source);
  return (await import(/* @vite-ignore */ pathToFileURL(sourceAbs).href)) as T;
}
