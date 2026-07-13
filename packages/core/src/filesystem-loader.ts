/**
 * Filesystem adapter acquisition boundary.
 *
 * `@happyvertical/files` statically imports @aws-sdk/client-s3 and reaches
 * googleapis from its root, so SmrtClass must not import it eagerly — that
 * single edge put the whole files SDK into every downstream SSR bundle
 * (#1977/#1978). Filesystem support is acquired here instead:
 *
 *  - Runtimes with node_modules (Node, tsx, vite dev, externalized SSR) work
 *    unchanged: the adapter is loaded on first use via a bundler-invisible
 *    import.
 *  - Fully-bundled deployments opt in explicitly with
 *    `import '@happyvertical/smrt-core/filesystem'` at server startup, which
 *    registers the statically-imported adapter factory.
 */
import type {
  FilesystemAdapter,
  FilesystemAdapterOptions,
} from '@happyvertical/files';
import { importOptionalDependency } from './lazy-external.js';

export type FilesystemAdapterFactory = (
  options: FilesystemAdapterOptions,
) => Promise<FilesystemAdapter>;

let factory: FilesystemAdapterFactory | undefined;

/**
 * Registers the factory used to satisfy `fs` options on SmrtClass instances.
 * Called by the `@happyvertical/smrt-core/filesystem` entry point; hosts with
 * a custom adapter can call it directly. The last registration wins.
 */
export function registerFilesystemAdapterFactory(
  create: FilesystemAdapterFactory,
): void {
  factory = create;
}

/**
 * Creates a filesystem adapter for SmrtClass `fs` options, using the
 * registered factory or falling back to a runtime-resolved
 * `@happyvertical/files` import.
 */
export async function createFilesystemAdapter(
  options: FilesystemAdapterOptions,
): Promise<FilesystemAdapter> {
  if (!factory) {
    const mod = (await importOptionalDependency(
      '@happyvertical/files',
      "Import '@happyvertical/smrt-core/filesystem' during server startup (or call registerFilesystemAdapterFactory) to enable filesystem support in bundled builds.",
    )) as typeof import('@happyvertical/files');
    const adapter = mod.FilesystemAdapter;
    factory = (fsOptions) => adapter.create(fsOptions);
  }
  return factory(options);
}
