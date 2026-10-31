/**
 * Build-time collision check across the host-declared agent tool surfaces.
 *
 * A host operation (`defineHostOperationTool` in
 * `@happyvertical/smrt-app-mcp/host-operations`) is projected as an MCP
 * workflow tool and a WebMCP bespoke tool under ONE name, so the same
 * `declaredBy` appearing on several surfaces is the design, not a clash. A
 * name claimed by two different declarations is: the MCP server throws on a
 * duplicate catalog name and the document-global WebMCP lock silently drops
 * the later tool, so it fails the build here, naming both sources.
 */

/** The surface a host-declared tool name is registered on. */
export type HostToolSurface = 'workflow' | 'bespoke' | 'mcp';

/** One host-declared tool name and the source that declares it. */
export interface HostToolNameDeclaration {
  name: string;
  surface: HostToolSurface;
  /** Where it is declared, e.g. `src/lib/ops/review.ts` or `ReviewApply`. */
  declaredBy: string;
}

export interface HostToolNameCollision {
  name: string;
  first: HostToolNameDeclaration;
  second: HostToolNameDeclaration;
  message: string;
}

/**
 * Find names claimed by two different declarations. `generatedToolNames` are
 * the model tools the build will register (they use the `bespoke`/WebMCP and
 * `mcp` namespaces alike), so a host tool shadowing one also collides.
 */
export function checkHostToolNameCollisions(
  declarations: readonly HostToolNameDeclaration[],
  generatedToolNames: ReadonlyArray<{ name: string; declaredBy?: string }> = [],
): HostToolNameCollision[] {
  const seen = new Map<string, HostToolNameDeclaration>();
  for (const generated of generatedToolNames) {
    if (!seen.has(generated.name)) {
      seen.set(generated.name, {
        name: generated.name,
        surface: 'mcp',
        declaredBy: generated.declaredBy ?? 'a generated model action',
      });
    }
  }
  const collisions: HostToolNameCollision[] = [];
  for (const declaration of declarations) {
    const first = seen.get(declaration.name);
    if (!first) {
      seen.set(declaration.name, declaration);
      continue;
    }
    // The same operation projected onto another surface shares its name.
    if (first.declaredBy === declaration.declaredBy) continue;
    collisions.push({
      name: declaration.name,
      first,
      second: declaration,
      message:
        `agent tool name \`${declaration.name}\` is declared twice: by ${first.declaredBy} ` +
        `(${first.surface}) and by ${declaration.declaredBy} (${declaration.surface}). ` +
        'Rename one; a host operation shares one name across its MCP and WebMCP projections only when both come from the same definition.',
    });
  }
  return collisions.sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.message.localeCompare(b.message),
  );
}

/** Throw one error listing every collision, for the build to fail on. */
export function assertNoHostToolNameCollisions(
  declarations: readonly HostToolNameDeclaration[],
  generatedToolNames?: ReadonlyArray<{ name: string; declaredBy?: string }>,
): void {
  const collisions = checkHostToolNameCollisions(
    declarations,
    generatedToolNames,
  );
  if (collisions.length === 0) return;
  throw new Error(
    `[smrt] ${collisions.length} agent tool name collision(s):\n${collisions
      .map((collision) => `  - ${collision.message}`)
      .join('\n')}`,
  );
}
