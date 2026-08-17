/**
 * "Green is never text" — the Svelte-stack half of the rule (#2323).
 *
 * `--smrt-color-success` is the one palette role that is not reliably
 * text-safe: a green that reads as "running" at a glance sits in a narrow
 * luminance band, so under the happyvertical light scheme it measures
 * 4.22–4.44:1 on `surfaceDim` / `surfaceContainerHighest` / `surfaceVariant` /
 * `background` — under the WCAG AA 4.5:1 floor for normal text. It stays legal
 * as a MARKER: status lamps, dots, borders, and container fills (which pair
 * with `on-success-container` ink and are AA by construction).
 *
 * `smrt-ui` pins this for its own components in
 * `src/themes/__tests__/happyvertical-theme.test.ts`; that scan cannot see this
 * package, which is how `SystemStatusChips` and `PhoneInput` drifted. This is
 * the same check with the same matcher, scoped here.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = process.cwd().endsWith('packages/smrt-svelte')
  ? process.cwd()
  : join(process.cwd(), 'packages/smrt-svelte');

const SKIP_DIRS = new Set(['node_modules', 'dist', '.svelte-kit', 'build']);

function svelteFilesUnder(dir: string): string[] {
  const out: string[] = [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...svelteFilesUnder(full));
    } else if (entry.name.endsWith('.svelte')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Does this source paint TEXT with the success token?
 *
 * Matches on the declaration VALUE rather than requiring `var(` to sit next to
 * `color:`, so wrappers count — `color-mix(…)`, `light-dark(…)`, and
 * `var(--x, var(--smrt-color-success))` all paint letterforms just as directly.
 * Resolves one level of custom-property indirection, because
 * `--chip-color: var(--smrt-color-success)` followed by `color: var(--chip-color)`
 * is the shape that hides this from a naive grep. `(?![\w-])` keeps
 * `--smrt-color-success-container` (a fill, with its own ink) from matching.
 */
function paintsTextWithSuccess(source: string): boolean {
  const declaration = /(?<![-\w])color\s*:\s*([^;{}]*)/g;
  const successToken = /--smrt-color-success(?![\w-])/;
  const customProperty = /(--[\w-]+)\s*:\s*([^;{}]*)/g;

  const greenProperties = new Set<string>();
  for (const [, name, value] of source.matchAll(customProperty)) {
    if (successToken.test(value)) greenProperties.add(name);
  }
  for (const [, value] of source.matchAll(declaration)) {
    if (successToken.test(value)) return true;
    for (const property of greenProperties) {
      if (value.includes(`var(${property}`)) return true;
    }
  }
  return false;
}

describe('success is a marker colour, never text (#2323)', () => {
  const files = svelteFilesUnder(join(packageRoot, 'src'));

  it('finds components to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no component paints text with --smrt-color-success', () => {
    const offenders = files
      .filter((file) => paintsTextWithSuccess(readFileSync(file, 'utf8')))
      .map((file) => file.slice(packageRoot.length + 1));

    expect(offenders).toEqual([]);
  });

  it('detects the wrapped and indirect forms the naive check missed', () => {
    expect(
      paintsTextWithSuccess('.x { color: var(--smrt-color-success); }'),
    ).toBe(true);
    expect(
      paintsTextWithSuccess(
        '.x { color: color-mix(in srgb, var(--smrt-color-success) 80%, transparent); }',
      ),
    ).toBe(true);
    expect(
      paintsTextWithSuccess(
        '.x { color: light-dark(var(--smrt-color-success), #fff); }',
      ),
    ).toBe(true);
    expect(
      paintsTextWithSuccess(
        '.x { color: var(--y, var(--smrt-color-success)); }',
      ),
    ).toBe(true);
    expect(
      paintsTextWithSuccess(
        '.a { --tone: var(--smrt-color-success); } .b { color: var(--tone); }',
      ),
    ).toBe(true);
  });

  it('leaves marker, fill, and border uses alone', () => {
    expect(
      paintsTextWithSuccess('.x { background: var(--smrt-color-success); }'),
    ).toBe(false);
    expect(
      paintsTextWithSuccess('.x { border-color: var(--smrt-color-success); }'),
    ).toBe(false);
    expect(
      paintsTextWithSuccess(
        '.x { background-color: var(--smrt-color-success); }',
      ),
    ).toBe(false);
    expect(
      paintsTextWithSuccess(
        '.x { color: var(--smrt-color-success-container); }',
      ),
    ).toBe(false);
    expect(
      paintsTextWithSuccess('.x { color: var(--smrt-color-on-success); }'),
    ).toBe(false);
  });
});
