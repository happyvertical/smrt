import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolve as resolveImport } from 'import-meta-resolve';
import type { PublicJsonOptions, SmrtObject } from './object.js';

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

/**
 * Resolve a serializer package from the running application's module graph.
 *
 * Model packages own serializer implementations but do not become dependencies
 * of core or generic consumers such as Chat. Bare specifiers first use the
 * active runtime module graph so workspace aliases keep one constructor
 * identity. When the package is absent from Core's dependency graph, resolution
 * falls back to the application's current package location with ESM export
 * conditions. Relative and URL references keep their declaring module's
 * ordinary dynamic-import behavior.
 */
export async function resolveMcpGetSerializer(
  reference: McpGetSerializerReference,
  options: McpGetSerializerResolveOptions = {},
): Promise<McpGetSerializer> {
  let module: Record<string, unknown> | undefined;
  if (resolvesFromConsumer(reference.importPath)) {
    try {
      module = (await import(reference.importPath)) as Record<string, unknown>;
    } catch (error) {
      if (!isUnresolvedPackage(error, reference.importPath)) throw error;
    }
  }
  if (!module) {
    const resolvedImportPath = resolvesFromConsumer(reference.importPath)
      ? resolveImport(
          reference.importPath,
          pathToFileURL(resolve(process.cwd(), 'package.json')).href,
        )
      : resolveImport(
          reference.importPath,
          options.parentUrl ?? import.meta.url,
        );
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
