import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CRUD_OPERATIONS } from './custom-action.js';

/**
 * #2665: four vite-plugin emitters each carried their own copy of the
 * standard CRUD verb list (`STANDARD_API_ACTIONS` / `STANDARD_API_ACTION_SET`
 * / inline literals). They now import {@link CRUD_OPERATIONS} from
 * `generators/custom-action.ts` instead. This asserts the shared vocabulary
 * directly (so a change to `CRUD_OPERATIONS` is felt everywhere at once) and
 * source-scans each former duplicate to fail loudly if a hardcoded copy of
 * the verb list is reintroduced, rather than silently drifting again.
 */
describe('CRUD verb list consolidation (#2665)', () => {
  it('is the single five-verb vocabulary every emitter now shares', () => {
    expect([...CRUD_OPERATIONS]).toEqual([
      'list',
      'get',
      'create',
      'update',
      'delete',
    ]);
  });

  const sitesUnderPackageRoot = [
    'vite-plugin/sveltekit-generator.ts',
    'vite-plugin/api-client-entries.ts',
    'vite-plugin/index.ts',
    'vite-plugin/templates/default-ui.ts',
  ];

  const generatorsDir = dirname(fileURLToPath(import.meta.url));
  const srcDir = dirname(generatorsDir);

  for (const relativePath of sitesUnderPackageRoot) {
    it(`${relativePath} imports CRUD_OPERATIONS and carries no hardcoded copy`, () => {
      const absolutePath = join(srcDir, relativePath);
      const source = readFileSync(absolutePath, 'utf8');

      // Each site imports either CRUD_OPERATIONS directly or the
      // isCrudOperation() collision test built on it -- both route through
      // the single shared list, so either satisfies the consolidation.
      expect(source).toMatch(
        /import\s*\{[^}]*\b(CRUD_OPERATIONS|isCrudOperation)\b[^}]*\}\s*from\s*['"][^'"]*generators\/custom-action\.js['"]/,
      );

      // The literal this file used to hardcode, in any quoting/spacing.
      expect(source).not.toMatch(
        /\[\s*['"]list['"]\s*,\s*['"]get['"]\s*,\s*['"]create['"]\s*,\s*['"]update['"]\s*,\s*['"]delete['"]\s*\]/,
      );
    });
  }
});
