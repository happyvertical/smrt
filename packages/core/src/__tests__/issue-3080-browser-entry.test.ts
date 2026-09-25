/**
 * `runOnce()` is server-only (`node:crypto`, `knowledge-graph.ts`), and the
 * browser entry deliberately does not export it. `system/retention.ts` is
 * re-exported by `browser.ts`, so its run-once table name must come from the
 * browser-safe `system/schema.ts`, never from `run-once.ts` (#3080).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..');
const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g;

function resolveRelative(from: string, specifier: string): string | null {
  const base = normalize(join(dirname(from), specifier));
  for (const candidate of [
    base,
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    join(base, 'index.ts'),
  ]) {
    if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate;
  }
  return null;
}

function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = resolveRelative(file, specifier);
      if (resolved) stack.push(resolved);
    }
  }
  return seen;
}

describe('browser entry stays free of runOnce (#3080)', () => {
  it('never reaches run-once.ts from browser.ts', () => {
    const reached = reachableFrom(join(SRC, 'browser.ts'));
    expect(reached.has(join(SRC, 'system', 'retention.ts'))).toBe(true);
    expect(reached.has(join(SRC, 'run-once.ts'))).toBe(false);
  });
});
