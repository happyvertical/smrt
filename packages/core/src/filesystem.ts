/**
 * Explicit filesystem enablement entry point.
 *
 * Importing this module statically links `@happyvertical/files` and registers
 * its adapter factory with SmrtClass, restoring filesystem support in
 * fully-bundled deployments (where the runtime fallback in filesystem-loader
 * cannot resolve node_modules). Provider-neutral consumers must NOT import
 * this — it deliberately makes the files SDK (S3/googleapis) reachable.
 *
 * @example
 * ```ts
 * // hooks.server.ts / server bootstrap
 * import '@happyvertical/smrt-core/filesystem';
 * ```
 */
import { FilesystemAdapter } from '@happyvertical/files';
import { registerFilesystemAdapterFactory } from './filesystem-loader.js';

registerFilesystemAdapterFactory((options) =>
  FilesystemAdapter.create(options),
);

export { registerFilesystemAdapterFactory } from './filesystem-loader.js';
export { FilesystemAdapter };
