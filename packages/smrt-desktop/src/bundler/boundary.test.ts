import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const RELATIVE_IMPORT =
  /(?:from|import|export\s+\*\s+from)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;

/** Every source file reachable from `entry` through relative imports. */
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [resolve(srcDir, entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(RELATIVE_IMPORT)) {
      const target = resolve(
        dirname(file),
        (match[1] as string).replace(/\.js$/, '.ts'),
      );
      queue.push(target);
    }
  }
  return [...seen].map((file) => relative(srcDir, file)).sort();
}

describe('the bundler entry is separate', () => {
  it('is not reachable from the package root', () => {
    const files = reachable('index.ts');
    expect(files.filter((file) => file.startsWith(`bundler${'/'}`))).toEqual(
      [],
    );
  });

  it('reaches the sidecar manifest serializer it writes', () => {
    const files = reachable('bundler/index.ts');
    expect(files).toContain('sidecar-manifest.ts');
    expect(files).toContain(join('bundler', 'run.ts'));
  });

  it('does not ship test fixtures through the public entry', () => {
    const files = reachable('bundler/index.ts');
    expect(files.filter((file) => /(^|\/)testing\//.test(file))).toEqual([]);
  });
});
