import { createHash } from 'node:crypto';

/** Internal execution identity; never inferred from a protocol alias. */
export interface McpToolTarget {
  objectName: string;
  action: string;
  /** Original generated name before protocol canonicalization. */
  originalName?: string;
  /**
   * Registry key (qualified identity) of the generating class (#3490).
   * `objectName` is the wire/display name; every registry lookup — in-process
   * and in generated runtimes — goes through this key when present.
   */
  registryKey?: string;
}

/**
 * Preserve valid aliases and deterministically name previously invalid ones.
 * Reserve all valid names before assigning hashes so registry order cannot
 * cause an invalid alias to steal a valid published name. Collisions fail closed.
 */
export function canonicalMcpToolNames(
  entries: readonly { name: string; target: McpToolTarget }[],
): string[] {
  const valid = /^[A-Za-z0-9_.-]{1,64}$/;
  const occupied = new Set<string>();
  const rawNames = new Set<string>();
  for (const { name } of entries) {
    if (rawNames.has(name)) throw new Error(`Duplicate MCP tool name: ${name}`);
    rawNames.add(name);
    if (valid.test(name)) occupied.add(name);
  }
  return entries.map(({ name, target }) => {
    if (valid.test(name)) return name;
    const identity = JSON.stringify([target.objectName, target.action, name]);
    const prefix = name.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 31);
    const digest = createHash('sha256')
      .update(identity)
      .digest('hex')
      .slice(0, 32);
    const canonical = `${prefix}_${digest}`;
    if (occupied.has(canonical)) {
      throw new Error(`MCP tool name collision: ${canonical}`);
    }
    occupied.add(canonical);
    return canonical;
  });
}
