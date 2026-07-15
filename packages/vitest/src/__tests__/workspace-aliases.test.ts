/**
 * Coverage for the workspace vite-alias builder (`getWorkspaceViteAliases`),
 * which maps `@happyvertical/smrt-*` package + subpath specifiers to their
 * source entries so tests resolve workspace code without a build. Exercised
 * against the real repo workspace. Includes the S11 (#1416) component-test
 * harness special-case for smrt-vitest.
 *
 * Entries are emitted with anchored RegExp `find`s so an alias only matches
 * its exact specifier — rolldown (vite 8) prefix-matches string finds, which
 * mangled unaliased subpath imports downstream (anytown.ai#707).
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getWorkspaceViteAliases } from '../index.js';

// packages/vitest/src/__tests__ → repo root
const repoRoot = resolve(__dirname, '../../../..');
const aliases = getWorkspaceViteAliases(repoRoot);
const replacementFor = (specifier: string) =>
  aliases.find((entry) => entry.find.test(specifier))?.replacement;

describe('getWorkspaceViteAliases', () => {
  it('aliases each workspace package root to its source entry', () => {
    expect(replacementFor('@happyvertical/smrt-core')).toMatch(
      /packages\/core\/src\/index\.ts$/,
    );
    expect(replacementFor('@happyvertical/smrt-vitest')).toMatch(
      /packages\/vitest\/src\/index\.ts$/,
    );
  });

  it('aliases known package subpaths to source (e.g. smrt-core/testing)', () => {
    expect(replacementFor('@happyvertical/smrt-core/testing')).toMatch(
      /src\/testing\.ts$/,
    );
  });

  it('aliases the trusted profiles OIDC integration subpath to source', () => {
    expect(
      replacementFor('@happyvertical/smrt-profiles/internal/oidc-provisioning'),
    ).toMatch(/packages\/profiles\/src\/internal\/oidc-provisioning\.ts$/);
  });

  it('aliases the S11 component-test harness subpaths (smrt-vitest special-case)', () => {
    expect(replacementFor('@happyvertical/smrt-vitest/svelte')).toMatch(
      /src\/svelte\.ts$/,
    );
    expect(replacementFor('@happyvertical/smrt-vitest/svelte-setup')).toMatch(
      /src\/svelte-setup\.ts$/,
    );
    expect(replacementFor('@happyvertical/smrt-vitest/a11y')).toMatch(
      /src\/a11y\.ts$/,
    );
  });

  it('aliases the smrt-ui leaf subpaths to source, including forms (#1589)', () => {
    // smrt-ui's nested component subpaths are special-cased (they map to dirs,
    // not the generic `${pkg}/ui` → `src/ui.ts` convention). /forms is the
    // relocated Provider-free form primitives — without it, consumer tests that
    // render a migrated form component fail to resolve the import.
    expect(replacementFor('@happyvertical/smrt-ui/forms')).toMatch(
      /src\/components\/forms\/index\.ts$/,
    );
    expect(replacementFor('@happyvertical/smrt-ui/ui')).toMatch(
      /src\/components\/ui\/index\.ts$/,
    );
    expect(replacementFor('@happyvertical/smrt-ui/chat')).toMatch(
      /src\/components\/chat\/index\.ts$/,
    );
  });

  it('emits anchored exact-match finds so unaliased subpaths fall through (#2017)', () => {
    // Rolldown (vite 8) prefix-matches string finds: the bare-package alias
    // would turn `@happyvertical/smrt-core/not-an-aliased-subpath` into
    // `.../src/index.ts/not-an-aliased-subpath`. Anchored finds must not
    // match, so the specifier resolves through the package exports map.
    expect(
      replacementFor('@happyvertical/smrt-core/not-an-aliased-subpath'),
    ).toBeUndefined();

    for (const { find } of aliases) {
      expect(find).toBeInstanceOf(RegExp);
      expect(find.source.startsWith('^')).toBe(true);
      expect(find.source.endsWith('$')).toBe(true);
    }
  });

  it('sorts entries most-specific first so subpaths precede the bare-package root', () => {
    // Recover the raw specifier from the anchored source (strip ^…$, unescape)
    // — ordering is by raw specifier length, not escaped regex length.
    const rawFind = (find: RegExp) =>
      find.source.slice(1, -1).replace(/\\(.)/g, '$1');
    const lengths = aliases.map((entry) => rawFind(entry.find).length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));

    const svelteIdx = aliases.findIndex((entry) =>
      entry.find.test('@happyvertical/smrt-vitest/svelte'),
    );
    const rootIdx = aliases.findIndex((entry) =>
      entry.find.test('@happyvertical/smrt-vitest'),
    );
    expect(svelteIdx).toBeGreaterThanOrEqual(0);
    expect(svelteIdx).toBeLessThan(rootIdx);
  });

  it('drops entries rejected by the filter option, keeping the rest (#2017)', () => {
    const filtered = getWorkspaceViteAliases(repoRoot, {
      filter: (entry) => entry.find !== '@happyvertical/smrt-core',
    });
    const filteredReplacementFor = (specifier: string) =>
      filtered.find((entry) => entry.find.test(specifier))?.replacement;

    expect(filteredReplacementFor('@happyvertical/smrt-core')).toBeUndefined();
    expect(filteredReplacementFor('@happyvertical/smrt-core/testing')).toMatch(
      /src\/testing\.ts$/,
    );
    expect(filteredReplacementFor('@happyvertical/smrt-vitest')).toMatch(
      /packages\/vitest\/src\/index\.ts$/,
    );
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
