import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolve as resolveImport } from 'import-meta-resolve';
import type { PublicJsonOptions, SmrtObject } from './object.js';
import { ObjectRegistry } from './registry.js';

/** A named module export that projects an admitted MCP `get` result. */
export type McpGetSerializer = (
  item: SmrtObject,
  options: PublicJsonOptions,
) => unknown | Promise<unknown>;

/** Package-owned location of an MCP `get` result serializer. */
export interface McpGetSerializerReference {
  importPath: string;
  exportName: string;
}

export interface McpGetSerializerResolveOptions {
  /**
   * Module URL that owns a relative serializer reference. Omit only when the
   * resolver itself owns that relative reference.
   */
  parentUrl?: string;

  /**
   * Qualified registry key of the model that declared the serializer. Its
   * loaded module is the default anchor for resolving a bare package.
   */
  ownerRegistryKey?: string;

  /**
   * Explicit application module URL for a host that resolves a serializer
   * outside a registered MCP model.
   */
  consumerAnchorUrl?: string;
}

function resolvesFromConsumer(importPath: string): boolean {
  return (
    !importPath.startsWith('.') &&
    !isAbsolute(importPath) &&
    !importPath.startsWith('file:') &&
    !importPath.startsWith('data:') &&
    !importPath.startsWith('node:')
  );
}

function isUnresolvedPackage(error: unknown, importPath: string): boolean {
  if (
    !(error instanceof Error) ||
    (error as Error & { code?: string }).code !== 'ERR_MODULE_NOT_FOUND'
  )
    return false;
  const packageName = importPath.startsWith('@')
    ? importPath.split('/').slice(0, 2).join('/')
    : importPath.split('/')[0];
  return error.message.includes(`'${packageName}'`);
}

function registeredModuleUrl(
  ownerRegistryKey: string | undefined,
): string | undefined {
  if (!ownerRegistryKey) return undefined;
  const sourceFilePath =
    ObjectRegistry.getClass(ownerRegistryKey)?.sourceFilePath;
  if (!sourceFilePath) return undefined;
  if (sourceFilePath.startsWith('file:')) return sourceFilePath;
  return isAbsolute(sourceFilePath)
    ? pathToFileURL(sourceFilePath).href
    : undefined;
}

/**
 * Resolve a serializer package from the running application's module graph.
 *
 * Model packages own serializer implementations but do not become dependencies
 * of core or generic consumers such as Chat. Bare specifiers first use the
 * active runtime module graph so workspace aliases keep one constructor
 * identity. When the package is absent from Core's dependency graph, resolution
 * continues from the module that registered the owning model (or an explicit
 * host anchor), with ESM export conditions. Relative and URL references keep
 * their declaring module's ordinary dynamic-import behavior.
 */
export async function resolveMcpGetSerializer(
  reference: McpGetSerializerReference,
  options: McpGetSerializerResolveOptions = {},
): Promise<McpGetSerializer> {
  let module: Record<string, unknown> | undefined;
  let missingPackageError: unknown;
  if (resolvesFromConsumer(reference.importPath)) {
    try {
      module = (await import(reference.importPath)) as Record<string, unknown>;
    } catch (error) {
      if (!isUnresolvedPackage(error, reference.importPath)) throw error;
      missingPackageError = error;
    }
  }
  if (!module) {
    const consumerAnchorUrl =
      options.consumerAnchorUrl ??
      registeredModuleUrl(options.ownerRegistryKey);
    let resolvedImportPath: string;
    if (resolvesFromConsumer(reference.importPath)) {
      if (!consumerAnchorUrl) {
        throw (
          missingPackageError ??
          new Error(
            `MCP get serializer '${reference.importPath}' requires a registered model or host module anchor`,
          )
        );
      }
      resolvedImportPath = resolveImport(
        reference.importPath,
        consumerAnchorUrl,
      );
    } else {
      resolvedImportPath = resolveImport(
        reference.importPath,
        options.parentUrl ?? import.meta.url,
      );
    }
    module = (await import(/* @vite-ignore */ resolvedImportPath)) as Record<
      string,
      unknown
    >;
  }
  const serializer = module[reference.exportName];
  if (typeof serializer !== 'function') {
    throw new Error(
      `MCP get serializer '${reference.exportName}' was not exported by '${reference.importPath}'`,
    );
  }
  return serializer as McpGetSerializer;
}
