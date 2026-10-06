/**
 * The component-free `./views` subpath: the view adapters run in a plain Node
 * context, and nothing they import at runtime reaches a `.svelte` file.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BillStructure } from '../services/AssemblyService.js';
import type { PlannedLine } from '../types.js';
import {
  toBomEditorLine,
  toBomEditorLines,
  toRequirementTotals,
  toRequirementTree,
} from '../views.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '../..');

const frame = { bomId: 'bom-frame', productId: 'p-frame', name: 'Frame' };
const planned = (overrides: Partial<PlannedLine>): PlannedLine => ({
  lineId: 'l',
  bomId: 'bom-frame',
  level: 1,
  path: [frame],
  componentSkuId: 'sku',
  kind: 'material',
  name: 'Tube',
  skuCode: 'TB',
  qtyPerUnit: 1,
  wastePercent: 0,
  effectiveQtyPerUnit: 1,
  uom: 'm',
  totalQty: 3,
  buildable: false,
  subBomId: null,
  expanded: false,
  available: 1,
  short: 2,
  ...overrides,
});

describe('@happyvertical/smrt-manufacturing/views', () => {
  it('adapts a bill structure without compiling a component', () => {
    const structure = {
      lines: [
        {
          line: {
            id: 'l1',
            componentSkuId: 'sku-1',
            qtyPerUnit: '2',
            uom: 'each',
            wastePercent: '5',
            notes: null,
          },
          component: {
            kind: 'material',
            sku: { code: 'TB' },
            product: { name: 'Tube' },
            activeBom: null,
          },
        },
      ],
    } as unknown as BillStructure;
    const [line] = toBomEditorLines(structure);
    expect(line).toMatchObject({
      id: 'l1',
      componentName: 'Tube',
      skuCode: 'TB',
      qtyPerUnit: 2,
      wastePercent: 5,
      notes: '',
      subBomId: null,
    });
    expect(toBomEditorLine(structure.lines[0])).toEqual(line);
  });

  it('nests and totals requirement lines', () => {
    const lines = [
      planned({
        lineId: 'a',
        kind: 'assembly',
        buildable: true,
        expanded: true,
      }),
      planned({
        lineId: 'b',
        level: 2,
        path: [frame, { bomId: 'bom-a', productId: 'p-a', name: 'A' }],
      }),
    ];
    const tree = toRequirementTree({ lines });
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((child) => child.key)).toEqual([
      'bom-frame/bom-a/b',
    ]);
    expect(toRequirementTotals({ lines })).toEqual([
      expect.objectContaining({ componentSkuId: 'sku', required: 3, short: 2 }),
    ]);
  });

  it('has no runtime import that can reach a .svelte file', () => {
    const source = readFileSync(resolve(pkg, 'src/views.ts'), 'utf8');
    const runtimeImports = source
      .split('\n')
      .filter((text) => /^(import|export)\b.*\bfrom\b/.test(text))
      .filter((text) => !/^(import|export) type\b/.test(text));
    expect(runtimeImports).toEqual([]);
    expect(source).not.toMatch(/\.svelte['"]/);
  });

  it('is declared as a build entry and an export with types', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(pkg, 'package.json'), 'utf8'),
    );
    expect(manifest.exports['./views']).toEqual({
      types: './dist/views.d.ts',
      import: './dist/views.js',
    });
    expect(readFileSync(resolve(pkg, 'vite.config.ts'), 'utf8')).toMatch(
      /entries:\s*\[[^\]]*'views'/,
    );
  });
});
