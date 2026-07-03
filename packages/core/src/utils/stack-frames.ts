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
  return DECORATOR_RUNTIME_PACKAGES.some((pkg) => lower.includes(`/${pkg}/`));
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
