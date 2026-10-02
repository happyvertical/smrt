/**
 * smrt-ui is the dependency leaf, and the form-retry entry is published
 * Svelte-free (#3291): its sources must never import `@sveltejs/kit` or
 * `svelte`, so plain SvelteKit apps, smrt-svelte and plain Node can load it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('form-retry import boundary', () => {
  it('imports neither @sveltejs/kit nor svelte', () => {
    const sources = readdirSync(root).filter((name) => name.endsWith('.ts'));
    expect(sources.length).toBeGreaterThan(0);
    for (const name of sources) {
      const text = readFileSync(join(root, name), 'utf8');
      const imports = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
        (match) => match[1],
      );
      for (const specifier of imports) {
        expect(specifier, `${name} imports ${specifier}`).toMatch(/^\.\//);
      }
    }
  });
});
