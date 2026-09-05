import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CRUD_OPERATIONS } from './custom-action.js';

/**
 * #2665: four vite-plugin emitters each carried their own copy of the
 * standard CRUD verb list (`STANDARD_API_ACTIONS` / `STANDARD_API_ACTION_SET`
 * / inline literals). Three of them (`sveltekit-generator.ts`,
 * `api-client-entries.ts`, `index.ts`) now import {@link CRUD_OPERATIONS} (or
 * the `isCrudOperation()` collision test built on it) from
 * `generators/custom-action.ts` instead.
 *
 * `vite-plugin/templates/default-ui.ts` deliberately keeps a local literal:
 * its source is copied verbatim into `dist/` and inlined as literal
 * browser-script text (`getDefaultUIModule()` in `vite-plugin/index.ts`),
 * never compiled or executed under Node, so a static import of the Node-side
 * `generators/custom-action.js` module is unsafe there even though it
 * type-checks and builds fine (final review, #2665). That site's assertion
 * below checks the literal's *value* against {@link CRUD_OPERATIONS} instead
 * of checking for an import.
 *
 * This spec asserts the shared vocabulary directly (so a change to
 * `CRUD_OPERATIONS` is felt everywhere at once) and source-scans each former
 * duplicate to fail loudly if a hardcoded, un-synced copy of the verb list is
 * reintroduced, rather than silently drifting again.
 */
describe('CRUD verb list consolidation (#2665)', () => {
  const expectedVerbs = ['list', 'get', 'create', 'update', 'delete'];

  it('is the single five-verb vocabulary every emitter now shares', () => {
    expect([...CRUD_OPERATIONS]).toEqual(expectedVerbs);
  });

  const generatorsDir = dirname(fileURLToPath(import.meta.url));
  const srcDir = dirname(generatorsDir);

  const importingSites = [
    'vite-plugin/sveltekit-generator.ts',
    'vite-plugin/api-client-entries.ts',
    'vite-plugin/index.ts',
  ];

  for (const relativePath of importingSites) {
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

  it('vite-plugin/templates/default-ui.ts carries a browser-safe literal that still equals CRUD_OPERATIONS', () => {
    const absolutePath = join(srcDir, 'vite-plugin/templates/default-ui.ts');
    const source = readFileSync(absolutePath, 'utf8');

    // Deliberately NOT importing generators/custom-action.js here: this
    // file is inlined as literal browser-script text, never executed
    // under Node (see the module-level comment in default-ui.ts).
    expect(source).not.toMatch(
      /import\s*\{[^}]*\}\s*from\s*['"][^'"]*generators\/custom-action\.js['"]/,
    );

    const literalMatch = source.match(
      /const CRUD_OPERATIONS_FOR_BROWSER_TEMPLATE[^=]*=\s*\[([\s\S]*?)\]/,
    );
    expect(literalMatch).not.toBeNull();

    const verbs = [...(literalMatch?.[1].matchAll(/'([^']+)'/g) ?? [])].map(
      (m) => m[1],
    );
    expect(verbs).toEqual(expectedVerbs);
  });
});
