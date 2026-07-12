/**
 * Explicit filesystem enablement entry point for smrt-assets.
 *
 * Importing this module statically links `@happyvertical/files` and registers
 * it with AssetStore's lazy boundary AND core's global optional-dependency
 * registry (so every importOptionalDependency('@happyvertical/files') caller
 * — e.g. smrt-messages Attachment.readContent — is satisfied too). This
 * restores asset file storage in fully-bundled deployments where the runtime
 * fallback in files-runtime cannot resolve node_modules. Provider-neutral
 * consumers must NOT import this — it deliberately makes the files SDK
 * (S3/googleapis) reachable.
 *
 * @example
 * ```ts
 * // hooks.server.ts / server bootstrap
 * import '@happyvertical/smrt-assets/filesystem';
 * ```
 */
import * as files from '@happyvertical/files';
import { registerOptionalDependency } from '@happyvertical/smrt-core';
import { registerFilesModule } from './files-runtime.js';

registerOptionalDependency('@happyvertical/files', files);
registerFilesModule(files);

export { FileNotFoundError, getFilesystem } from '@happyvertical/files';
