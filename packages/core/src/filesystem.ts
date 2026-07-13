/**
 * Explicit filesystem enablement entry point.
 *
 * Importing this module statically links `@happyvertical/files` and registers
 * it for the whole optional-dependency boundary: the SmrtClass adapter
 * factory AND every importOptionalDependency('@happyvertical/files') call in
 * any smrt package (e.g. smrt-messages Attachment.readContent). This restores
 * filesystem support in fully-bundled deployments where the runtime fallback
 * cannot resolve node_modules. Provider-neutral consumers must NOT import
 * this — it deliberately makes the files SDK (S3/googleapis) reachable.
 *
 * @example
 * ```ts
 * // hooks.server.ts / server bootstrap
 * import '@happyvertical/smrt-core/filesystem';
 * ```
 */
import * as files from '@happyvertical/files';
import { FilesystemAdapter } from '@happyvertical/files';
import { registerFilesystemAdapterFactory } from './filesystem-loader.js';
import { registerOptionalDependency } from './lazy-external.js';

registerOptionalDependency('@happyvertical/files', files);
registerFilesystemAdapterFactory((options) =>
  FilesystemAdapter.create(options),
);

export { registerFilesystemAdapterFactory } from './filesystem-loader.js';
export { registerOptionalDependency } from './lazy-external.js';
export { FilesystemAdapter };
