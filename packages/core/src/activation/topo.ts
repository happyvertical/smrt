/** Deterministic ordering helpers for the activation graph. Pure: no I/O. */

/** Code-unit order: independent of locale and of the host's collation. */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Kahn's algorithm. Among the nodes that are ready, the smallest key (code
 * unit order) goes first, so the result depends only on the node keys and the
 * edge set, never on the order they were listed in. `remaining` holds the
 * nodes left over when the edges contain a cycle (the cycle and everything
 * downstream of it).
 */
export function topologicalOrder(
  nodes: Iterable<string>,
  edges: Iterable<readonly [from: string, to: string]>,
): { order: string[]; remaining: string[] } {
  const all = [...new Set(nodes)].sort(byCodeUnit);
  const known = new Set(all);
  const incoming = new Map<string, number>(all.map((node) => [node, 0]));
  const outgoing = new Map<string, Set<string>>();
  for (const [from, to] of edges) {
    if (from === to || !known.has(from) || !known.has(to)) continue;
    const targets = outgoing.get(from) ?? new Set<string>();
    if (targets.has(to)) continue;
    targets.add(to);
    outgoing.set(from, targets);
    incoming.set(to, (incoming.get(to) ?? 0) + 1);
  }
  const ready = all.filter((node) => incoming.get(node) === 0);
  const order: string[] = [];
  while (ready.length) {
    const node = ready.shift() as string;
    order.push(node);
    for (const target of [...(outgoing.get(node) ?? [])].sort(byCodeUnit)) {
      const left = (incoming.get(target) ?? 0) - 1;
      incoming.set(target, left);
      if (left === 0) {
        ready.push(target);
        ready.sort(byCodeUnit);
      }
    }
  }
  const done = new Set(order);
  return { order, remaining: all.filter((node) => !done.has(node)) };
}

/**
 * One actual cycle among `remaining` (what `topologicalOrder` left over), in
 * edge direction. Descendants of a cycle also remain, so walk predecessors
 * until a node repeats instead of reporting every leftover node.
 */
export function findCycle(
  remaining: readonly string[],
  edges: Iterable<readonly [from: string, to: string]>,
): string[] {
  const left = new Set(remaining);
  const predecessor = new Map<string, string>();
  for (const [from, to] of [...edges].sort(
    (a, b) => byCodeUnit(a[0], b[0]) || byCodeUnit(a[1], b[1]),
  )) {
    if (left.has(from) && left.has(to) && !predecessor.has(to))
      predecessor.set(to, from);
  }
  const start = [...left].sort(byCodeUnit)[0];
  if (start === undefined) return [];
  const path: string[] = [];
  const seen = new Map<string, number>();
  let node: string | undefined = start;
  while (node !== undefined && !seen.has(node)) {
    seen.set(node, path.length);
    path.push(node);
    node = predecessor.get(node);
  }
  if (node === undefined) return [start];
  return path.slice(seen.get(node)).reverse();
}
