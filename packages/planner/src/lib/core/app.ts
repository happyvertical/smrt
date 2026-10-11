import { fileURLToPath } from 'node:url';

/**
 * Absolute path of the prerendered static planner app inside this package
 * (`app/`, built with the planner's relative base, so it works at `/` and at
 * any sub-path). Node only; kept out of `./core` so that entry stays free of
 * Node built-ins.
 *
 * Serve the files from here, and write your own `planner.config.json` next to
 * its `index.html` (copy the directory, or answer that one path yourself).
 */
export const appDir: string = fileURLToPath(
  new URL('../../app/', import.meta.url),
);

/** Absolute path of one file in the app, e.g. `appFile('planner.config.json')`. */
export function appFile(relativePath: string): string {
  return fileURLToPath(
    new URL(relativePath, new URL('../../app/', import.meta.url)),
  );
}
