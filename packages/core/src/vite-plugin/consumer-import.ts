/**
 * Consumer-relative ESM resolution for generated-route dependencies (#3913).
 *
 * Generated SvelteKit files are written into the consumer's own `src/`, and
 * some of them import a package that core itself cannot depend on
 * (`@happyvertical/smrt-users/sveltekit`, `@happyvertical/smrt-app-runtime/
 * sveltekit`, `@happyvertical/smrt-dev-mcp/dev-plane`). The generator emits
 * such a file only when that exact specifier would resolve in the consumer's
 * build, so this check must answer the question Vite/SvelteKit will ask:
 *
 * - **ESM import conditions.** Published subpaths may expose only `types` and
 *   `import`. A CommonJS `createRequire(...).resolve` probe uses `require`
 *   conditions, throws `ERR_PACKAGE_PATH_NOT_EXPORTED` for such a subpath,
 *   and would falsely skip a correctly installed dependency.
 * - **Anchored to the consumer.** Resolution starts from the consumer's
 *   `package.json` URL, so it walks the consumer's own `node_modules` and any
 *   hoisted ancestor `node_modules` — never core's install location.
 * - **Existing file target.** ESM resolution can return a URL for a target
 *   that does not exist (or is a directory), so the target must be a file.
 *
 * Do not change a package's export map to accommodate a mismatched detector.
 */

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve as resolveImport } from 'import-meta-resolve';

/**
 * Whether `specifier` resolves from the consumer at `projectRoot` under ESM
 * import conditions to an existing file.
 */
export function consumerResolvesImport(
  projectRoot: string,
  specifier: string,
): boolean {
  try {
    const target = resolveImport(
      specifier,
      pathToFileURL(join(projectRoot, 'package.json')).href,
    );
    return statSync(fileURLToPath(target)).isFile();
  } catch {
    return false;
  }
}
