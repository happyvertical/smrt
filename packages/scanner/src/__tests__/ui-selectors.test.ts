import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManifestAdapter } from '../manifest-adapter.js';
import { OxcScanner } from '../scanner.js';
import { mergeUiSelectors, parseUiSelectorsFile } from '../ui-selectors.js';

/**
 * #3599: a `ModuleUISlot` with `selects: '<qualified model>'` marks a package
 * component as the selector for that model. The scanner reads it statically
 * from the package's `ui.ts` and the adapter emits it as `uiSelectors`.
 */
describe('UI selector slots (#3599)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smrt-ui-selectors-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(rel: string, source: string): string {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, source);
    return full;
  }

  const UI = `
import type { ModuleUISlot, SmrtModuleMeta } from '@happyvertical/smrt-types';
export const SALES_UI_SLOTS: Record<string, ModuleUISlot> = {
  'customer-select': {
    id: 'customer-select',
    label: 'Customer',
    description: 'Pick a customer',
    category: 'form',
    selects: '@example/sales:Customer',
  },
  'order-card': { id: 'order-card', label: 'Order Card', category: 'display' },
};
export const SALES_MODULE_META: SmrtModuleMeta = {
  name: '@example/sales',
  displayName: 'Sales',
  uiSlots: SALES_UI_SLOTS,
};
`;

  it('collects only slots that declare selects', () => {
    const file = write('src/ui.ts', UI);
    const { selectors, errors } = parseUiSelectorsFile(file);
    expect(errors).toEqual([]);
    expect(selectors).toEqual([
      {
        slotId: 'customer-select',
        selects: '@example/sales:Customer',
        label: 'Customer',
        description: 'Pick a customer',
        filePath: file,
      },
    ]);
  });

  it('reports a non-literal or malformed selects instead of dropping it', () => {
    const file = write(
      'src/ui.ts',
      `const T = '@example/sales:Customer';
export const SLOTS = {
  a: { id: 'a', label: 'A', selects: T },
  b: { id: 'b', label: 'B', selects: 'Customer' },
};`,
    );
    const { selectors, errors } = parseUiSelectorsFile(file);
    expect(selectors).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(errors[0].message).toMatch(
      /must be a string literal qualified model name/,
    );
    expect(errors.every((e) => e.severity === 'error')).toBe(true);
  });

  it('rejects two selectors for one model', () => {
    const a = write(
      'src/ui.ts',
      `export const A = {
  one: { id: 'one', label: 'One', selects: '@example/sales:Customer' },
  two: { id: 'two', label: 'Two', selects: '@example/sales:Customer' },
};`,
    );
    const merged = mergeUiSelectors([parseUiSelectorsFile(a)]);
    expect(merged.errors.map((e) => e.message)).toEqual([
      expect.stringContaining('both select @example/sales:Customer'),
    ]);
    expect(Object.keys(merged.selectors)).toEqual(['one']);
  });

  it('rejects a slot id declared twice', () => {
    const a = write(
      'src/ui.ts',
      `export const A = { one: { id: 'one', label: 'One', selects: '@example/sales:Customer' } };`,
    );
    const b = write(
      'src/more/ui.ts',
      `export const B = { one: { id: 'one', label: 'Again', selects: '@example/sales:Vendor' } };`,
    );
    const merged = mergeUiSelectors([
      parseUiSelectorsFile(a),
      parseUiSelectorsFile(b),
    ]);
    expect(merged.errors.map((e) => e.message)).toEqual([
      expect.stringContaining('"one" is declared more than once'),
    ]);
  });

  it('OxcScanner finds ui.ts beside an unrelated class glob and the adapter emits it portably', async () => {
    write('src/ui.ts', UI);
    write(
      'src/lib/objects/Customer.ts',
      `import { smrt, SmrtObject } from '@happyvertical/smrt-core';\n@smrt()\nexport class Customer extends SmrtObject { name = ''; }\n`,
    );
    const scanner = new OxcScanner({
      cwd: dir,
      include: ['src/lib/objects/**/*.ts'],
    });
    const { results, resolved } = await scanner.scanAndResolve();
    expect(results.errors).toEqual([]);
    expect(Object.keys(results.uiSelectors ?? {})).toEqual(['customer-select']);

    const manifest = new ManifestAdapter().toManifest(resolved, {
      packageName: '@example/sales',
      uiSelectors: results.uiSelectors,
    });
    expect(manifest.uiSelectors).toEqual({
      'customer-select': {
        slotId: 'customer-select',
        selects: '@example/sales:Customer',
        label: 'Customer',
        description: 'Pick a customer',
      },
    });
    // No absolute paths leak into the manifest.
    expect(JSON.stringify(manifest.uiSelectors)).not.toContain(dir);
  });

  it('emits no uiSelectors key when none are declared', async () => {
    write('src/ui.ts', `export const S = { a: { id: 'a', label: 'A' } };`);
    const { results, resolved } = await new OxcScanner({
      cwd: dir,
    }).scanAndResolve();
    expect(results.uiSelectors).toBeUndefined();
    expect(
      new ManifestAdapter().toManifest(resolved, {
        uiSelectors: results.uiSelectors,
      }),
    ).not.toHaveProperty('uiSelectors');
  });
});
