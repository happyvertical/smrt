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

/**
 * Resolve a serializer package from the running application's module graph.
 *
 * Model packages own serializer implementations but do not become dependencies
 * of core or generic consumers such as Chat. Bare specifiers therefore resolve
 * from the application's current package location with ESM export conditions,
 * which supports import-only package exports. Relative and URL references keep
 * their declaring module's ordinary dynamic-import behavior.
 */
export async function resolveMcpGetSerializer(
  reference: McpGetSerializerReference,
  options: McpGetSerializerResolveOptions = {},
): Promise<McpGetSerializer> {
  const importPath = resolvesFromConsumer(reference.importPath)
    ? resolveImport(
        reference.importPath,
        pathToFileURL(resolve(process.cwd(), 'package.json')).href,
      )
    : resolveImport(reference.importPath, options.parentUrl ?? import.meta.url);
  const module = (await import(/* @vite-ignore */ importPath)) as Record<
    string,
    unknown
  >;
  const serializer = module[reference.exportName];
  if (typeof serializer !== 'function') {
    throw new Error(
      `MCP get serializer '${reference.exportName}' was not exported by '${reference.importPath}'`,
    );
  }
  return serializer as McpGetSerializer;
}
