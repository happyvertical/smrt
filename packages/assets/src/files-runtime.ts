/**
 * Lazy boundary to `@happyvertical/files` (#1977/#1979).
 *
 * The files SDK statically imports @aws-sdk/client-s3 and reaches googleapis
 * from its root, and smrt-assets is reachable from provider-neutral consumer
 * graphs (profiles → assets), so AssetStore must not import it eagerly.
 *
 *  - Runtimes with node_modules (Node, tsx, vite dev, externalized SSR) load
 *    the SDK on first file operation via a bundler-invisible import.
 *  - Fully-bundled deployments opt in explicitly with
 *    `import '@happyvertical/smrt-assets/filesystem'` at server startup.
 */
import type {
  FilesystemInterface,
  GetFilesystemOptions,
} from '@happyvertical/files';
import { importOptionalDependency } from '@happyvertical/smrt-core';

type FilesModule = typeof import('@happyvertical/files');

let filesModule: FilesModule | undefined;

/**
 * Registers the statically-imported files SDK module. Called by the
 * `@happyvertical/smrt-assets/filesystem` entry point.
 */
export function registerFilesModule(mod: FilesModule): void {
  filesModule = mod;
}

async function loadFilesModule(): Promise<FilesModule> {
  if (!filesModule) {
    filesModule = (await importOptionalDependency(
      '@happyvertical/files',
      "Import '@happyvertical/smrt-assets/filesystem' during server startup to enable asset file storage in bundled builds.",
    )) as FilesModule;
  }
  return filesModule;
}

/** Lazy equivalent of the files SDK's `getFilesystem`. */
export async function getFilesystemLazy(
  options: GetFilesystemOptions,
): Promise<FilesystemInterface> {
  const mod = await loadFilesModule();
  return mod.getFilesystem(options);
}

/**
 * True when `error` is the files SDK's FileNotFoundError. Uses the loaded
 * module's class when available and falls back to an `error.name` check so
 * resolver-injected filesystems built against another SDK copy still match.
 */
export function isFileNotFoundError(error: unknown): boolean {
  if (filesModule && error instanceof filesModule.FileNotFoundError) {
    return true;
  }
  return error instanceof Error && error.name === 'FileNotFoundError';
}
