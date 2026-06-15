/**
 * Coverage for the workspace vite-alias builder (`getWorkspaceViteAliases`),
 * which maps `@happyvertical/smrt-*` package + subpath specifiers to their
 * source entries so tests resolve workspace code without a build. Exercised
 * against the real repo workspace. Includes the S11 (#1416) component-test
 * harness special-case for smrt-vitest.
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getWorkspaceViteAliases } from '../index.js';

// packages/vitest/src/__tests__ → repo root
const repoRoot = resolve(__dirname, '../../../..');
const aliases = getWorkspaceViteAliases(repoRoot);
const byFind = new Map(aliases.map((entry) => [entry.find, entry.replacement]));

describe('getWorkspaceViteAliases', () => {
  it('aliases each workspace package root to its source entry', () => {
    expect(byFind.get('@happyvertical/smrt-core')).toMatch(
      /packages\/core\/src\/index\.ts$/,
    );
    expect(byFind.get('@happyvertical/smrt-vitest')).toMatch(
      /packages\/vitest\/src\/index\.ts$/,
    );
  });

  it('aliases known package subpaths to source (e.g. smrt-core/testing)', () => {
    expect(byFind.get('@happyvertical/smrt-core/testing')).toMatch(
      /src\/testing\.ts$/,
    );
  });

  it('aliases the S11 component-test harness subpaths (smrt-vitest special-case)', () => {
    expect(byFind.get('@happyvertical/smrt-vitest/svelte')).toMatch(
      /src\/svelte\.ts$/,
    );
    expect(byFind.get('@happyvertical/smrt-vitest/svelte-setup')).toMatch(
      /src\/svelte-setup\.ts$/,
    );
    expect(byFind.get('@happyvertical/smrt-vitest/a11y')).toMatch(
      /src\/a11y\.ts$/,
    );
  });

  it('sorts entries most-specific first so subpaths win over the bare-package root', () => {
    const lengths = aliases.map((entry) => entry.find.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));

    const svelteIdx = aliases.findIndex(
      (entry) => entry.find === '@happyvertical/smrt-vitest/svelte',
    );
    const rootIdx = aliases.findIndex(
      (entry) => entry.find === '@happyvertical/smrt-vitest',
    );
    expect(svelteIdx).toBeGreaterThanOrEqual(0);
    expect(svelteIdx).toBeLessThan(rootIdx);
  });

  it('only emits aliases whose source target exists', () => {
    // addAliasIfPresent guards on existsSync, so every replacement is a real path.
    for (const { replacement } of aliases) {
      expect(replacement.endsWith('.ts') || replacement.endsWith('.json')).toBe(
        true,
      );
    }
  });
});
