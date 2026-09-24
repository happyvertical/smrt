/**
 * Decorator-runtime stack-frame detection (#1785).
 *
 * ObjectRegistry attributes a `@smrt()` class to its declaring package by
 * walking the registration call stack for the first frame OUTSIDE smrt-core —
 * the module that applied the decorator. Decorator *lowering* breaks that
 * assumption: the compiler inserts a runtime-helper frame between the `@smrt()`
 * decorator and the consumer module that declares the class.
 *
 * Under Vite 8, oxc's legacy-decorator lowering routes the decorator application
 * through `@oxc-project/runtime`'s helper (e.g.
 * `.../@oxc-project/runtime/src/helpers/esm/applyDecoratedDescriptor.js`), so a
 * naive walk stops at that frame and misattributes the class to
 * `@oxc-project/runtime` instead of the consumer package. `tslib` (tsc's
 * `__decorate`), `@swc/helpers`, and `@babel/runtime` insert the identical kind
 * of frame under their respective toolchains.
 *
 * These are pure plumbing packages — a class is applied THROUGH them, never
 * DECLARED in them — so both stack walks (source-file identity in
 * `registry/shared-state.ts` and package attribution in
 * `manifest/manifest-loader.ts`) skip them and continue to the real declaring
 * module. Kept as a leaf module (no smrt imports) so both walkers can share it
 * without risking an import cycle.
 */

/**
 * Runtime-helper packages that decorator lowering routes the decorator
 * application through. Frames from these packages are never the module that
 * declares a decorated class.
 */
export const DECORATOR_RUNTIME_PACKAGES: readonly string[] = [
  '@oxc-project/runtime',
  '@swc/helpers',
  '@babel/runtime',
  'tslib',
];

/**
 * Whether a file path (normalized to forward slashes) lives inside a
 * decorator-runtime helper package — i.e. a stack frame introduced by decorator
 * lowering rather than the module that declares the decorated class.
 *
 * Matches both the plain installed form (`.../node_modules/tslib/...`) and the
 * pnpm form (`.../node_modules/.pnpm/tslib@2/node_modules/tslib/...`) because
 * the real `/<package>/` segment appears in both. Case-insensitive.
 *
 * @param path - A file path from a stack frame (already normalized to `/`).
 */
export function isDecoratorRuntimeFramePath(path: string): boolean {
  const lower = path.toLowerCase();
  return DECORATOR_RUNTIME_PACKAGES.some(
    (pkg) =>
      lower.includes(`/${pkg}/`) ||
      // Vite serves the helper as a virtual module whose id flattens the
      // scope separator and appends the version, e.g.
      // `<root>/\0@oxc-project+runtime@0.138.0/helpers/esm/decorate.js`.
      // Missing it attributed every class Vitest loads to the project root's
      // package (#3098).
      lower.includes(`\0${pkg.replace('/', '+')}@`),
  );
}

/**
 * Module and test runners that evaluate a module and so appear below it on
 * the stack. Like decorator helpers, they never declare a class.
 */
const MODULE_RUNNER_PATH_SEGMENTS: readonly string[] = [
  '/node_modules/@vitest/',
  '/node_modules/vitest/',
  '/node_modules/vite/dist/node/module-runner',
];

/**
 * Whether a stack-frame path belongs to a module or test runner (Vitest, the
 * Vite module runner) rather than to code that could declare a class (#3098).
 *
 * @param path - A file path from a stack frame (already normalized to `/`).
 */
export function isModuleRunnerFramePath(path: string): boolean {
  const lower = path.toLowerCase();
  return MODULE_RUNNER_PATH_SEGMENTS.some((segment) => lower.includes(segment));
}

/**
 * Whether a scoped package name (as captured from a `node_modules/@scope/name`
 * stack match) is a decorator-runtime helper package.
 *
 * @param name - A scoped package name, e.g. `@oxc-project/runtime`.
 */
export function isDecoratorRuntimePackageName(name: string): boolean {
  return DECORATOR_RUNTIME_PACKAGES.includes(name);
}

let smrtCoreRoot: string | null | undefined;

/**
 * The directory of the smrt-core package this module belongs to (its
 * `package.json` names `@happyvertical/smrt-core`), or `null` when it cannot
 * be determined (a browser, or core inlined into a consumer's bundle).
 * Resolved once from this module's own location, so it follows the monorepo
 * checkout, a linked checkout, or an installed copy alike.
 */
function getSmrtCoreRoot(): string | null {
  if (smrtCoreRoot !== undefined) return smrtCoreRoot;
  smrtCoreRoot = null;
  try {
    const getBuiltinModule = (
      globalThis as {
        process?: { getBuiltinModule?: (id: string) => unknown };
      }
    ).process?.getBuiltinModule;
    const fs = getBuiltinModule?.('node:fs') as
      | typeof import('node:fs')
      | undefined;
    const path = getBuiltinModule?.('node:path') as
      | typeof import('node:path')
      | undefined;
    const url = getBuiltinModule?.('node:url') as
      | typeof import('node:url')
      | undefined;
    if (!fs || !path || !url || !import.meta.url.startsWith('file:')) {
      return smrtCoreRoot;
    }
    let dir = path.dirname(url.fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 16; depth++) {
      const manifest = path.join(dir, 'package.json');
      if (
        fs.existsSync(manifest) &&
        (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: string })
          .name === '@happyvertical/smrt-core'
      ) {
        smrtCoreRoot = dir.replace(/\\/g, '/');
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    smrtCoreRoot = null;
  }
  return smrtCoreRoot;
}

/**
 * Whether a stack-frame path is smrt-core's own code, which applies decorators
 * but never declares an application class. Both stack walks (source-file
 * identity in `registry/shared-state.ts` and package attribution in
 * `manifest/manifest-loader.ts`) skip these frames.
 *
 * Matched by where core actually lives, never by a generic substring: a
 * consumer's own `packages/core` workspace package (ergot's `@ergot/core`) or
 * a file named like a core module declares classes too. That is this core's
 * package directory (outside its `__tests__` fixtures) and any installed
 * `node_modules/@happyvertical/smrt-core` copy. With source maps enabled —
 * `tsx`, `node --enable-source-maps`, Vite SSR — an installed core's frames
 * report mapped `.../node_modules/@happyvertical/smrt-core/src/...` paths;
 * missing them attributed every class to `@happyvertical/smrt-core` (#3109,
 * #3110).
 *
 * @param path - A file path from a stack frame (already normalized to `/`).
 */
export function isSmrtCoreFramePath(path: string): boolean {
  const normalized = path.replace(/^file:\/\//, '').replace(/\\/g, '/');
  if (
    normalized.toLowerCase().includes('/node_modules/@happyvertical/smrt-core/')
  ) {
    return true;
  }
  const root = getSmrtCoreRoot();
  if (!root || !normalized.startsWith(`${root}/`)) return false;
  return !normalized.slice(root.length + 1).includes('__tests__');
}
