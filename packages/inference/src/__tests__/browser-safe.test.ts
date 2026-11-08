/**
 * The root entry stays browser-safe (#4752): no `node:` built-ins and no
 * value import of the AI SDK outside the `./node` subpath. Model packages are
 * held by the bundle-gate browser fixture; this package has no models, so it
 * guards its own graph here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('root entry graph', () => {
  const rootFiles = readdirSync(SRC).filter(
    (name) =>
      name.endsWith('.ts') && name !== 'node.ts' && !name.endsWith('.d.ts'),
  );

  it('covers the source files', () => {
    expect(rootFiles).toEqual(
      expect.arrayContaining(['index.ts', 'executor.ts', 'config.ts']),
    );
  });

  it.each(rootFiles)('%s imports no node: module or AI SDK value', (name) => {
    const source = readFileSync(join(SRC, name), 'utf8');
    expect(source).not.toMatch(/from ['"]node:/);
    expect(source).not.toMatch(
      /import\s+\{[^}]*\}\s+from ['"]@happyvertical\/ai['"]/,
    );
    expect(source).not.toMatch(/from ['"]@happyvertical\/smrt-config['"]/);
  });
});
