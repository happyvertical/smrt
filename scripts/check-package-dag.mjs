#!/usr/bin/env node
/**
 * DAG guardrail (happyvertical/smrt#1582).
 *
 * Fails if the `@happyvertical/smrt-*` package graph contains a cycle over
 * `dependencies` + `peerDependencies`. A cross-package cycle is what let the
 * `smrt-svelte` keystone fan out — domain packages peering `smrt-svelte` while
 * `smrt-svelte` reached back into the domain layer. The graph must stay a DAG so
 * a plain dependency always dedupes to one physical instance.
 *
 * Reads package.json only (no build / node_modules needed). `devDependencies`
 * are intentionally NOT counted: a test-only edge (e.g. a fixture importing the
 * package that depends on it) is resolved via workspace hoisting and does not
 * affect the shipped dependency graph.
 *
 * The companion `pnpm deps:check` (dependency-cruiser, collapsed to package
 * level) validates the same property over *actual source imports* once packages
 * are built — run it locally for a deeper check.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES = join(import.meta.dirname, '..', 'packages');

const nodes = new Set();
const edges = new Map(); // name -> Set(workspace dep/peer names)
const dirs = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

const pkgs = {};
for (const d of dirs) {
  let p;
  try {
    p = JSON.parse(readFileSync(join(PACKAGES, d, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  if (!p.name) continue;
  pkgs[p.name] = p;
  nodes.add(p.name);
  edges.set(p.name, new Set());
}

const isWorkspace = (v) => typeof v === 'string' && v.startsWith('workspace:');
for (const p of Object.values(pkgs)) {
  for (const block of [p.dependencies, p.peerDependencies]) {
    for (const [dep, ver] of Object.entries(block ?? {})) {
      if (nodes.has(dep) && isWorkspace(ver)) edges.get(p.name).add(dep);
    }
  }
}

// Tarjan strongly-connected components.
let idx = 0;
const stack = [];
const onStack = new Set();
const index = new Map();
const low = new Map();
const cycles = [];
function strongConnect(v) {
  index.set(v, idx);
  low.set(v, idx);
  idx += 1;
  stack.push(v);
  onStack.add(v);
  for (const w of edges.get(v)) {
    if (!index.has(w)) {
      strongConnect(w);
      low.set(v, Math.min(low.get(v), low.get(w)));
    } else if (onStack.has(w)) {
      low.set(v, Math.min(low.get(v), index.get(w)));
    }
  }
  if (low.get(v) === index.get(v)) {
    const comp = [];
    let w;
    do {
      w = stack.pop();
      onStack.delete(w);
      comp.push(w);
    } while (w !== v);
    if (comp.length > 1) cycles.push(comp);
  }
}
for (const v of nodes) if (!index.has(v)) strongConnect(v);

if (cycles.length > 0) {
  console.error(
    '✗ package-dag: the @happyvertical/smrt-* dependency graph is not acyclic (#1582).\n',
  );
  for (const comp of cycles) {
    console.error(`  cycle: ${comp.map((n) => n.replace('@happyvertical/', '')).join(' → ')}`);
    for (const v of comp) {
      for (const w of edges.get(v)) {
        if (comp.includes(w)) {
          const kind = pkgs[v].peerDependencies?.[w] ? 'peer' : 'dep';
          console.error(`    ${v.replace('@happyvertical/', '')} --${kind}--> ${w.replace('@happyvertical/', '')}`);
        }
      }
    }
  }
  console.error('\n  Break it: extract a shared leaf, invert the edge, or use @crossPackageRef indirection.');
  process.exit(1);
}

console.log(`✓ package-dag: ${nodes.size} smrt packages form a DAG (deps + peers, no cycles).`);
