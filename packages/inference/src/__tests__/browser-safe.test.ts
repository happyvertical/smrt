/**
 * The root entry stays browser-safe (#4752): no `node:` built-ins and no
 * value import of the AI SDK outside the `./node` subpath. Model packages are
 * held by the bundle-gate browser fixture; this package has no models, so it
 * guards its own graph here. `./resolver` (#4756) is Node-only too: it reads
 * smrt-secrets and the ambient principal, and the root never imports it.
 * `hosted.ts` (#4759) is part of `./node` (secrets, runOnce, the gateway
 * admin client).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_ENTRIES = ['node.ts', 'resolver.ts', 'hosted.ts'];

describe('root entry graph', () => {
  const rootFiles = readdirSync(SRC).filter(
    (name) =>
      name.endsWith('.ts') &&
      !NODE_ENTRIES.includes(name) &&
      !name.endsWith('.d.ts'),
  );

  it('covers the source files', () => {
    expect(rootFiles).toEqual(
      expect.arrayContaining([
        'index.ts',
        'executor.ts',
        'config.ts',
        'provider-config.ts',
      ]),
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

  it.each(rootFiles)('%s never reaches the Node-only entries', (name) => {
    const source = readFileSync(join(SRC, name), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\/(node|resolver|hosted)\.js['"]/);
    expect(source).not.toMatch(
      /from ['"]@happyvertical\/smrt-(secrets|tenancy|users)['"]/,
    );
  });
});
