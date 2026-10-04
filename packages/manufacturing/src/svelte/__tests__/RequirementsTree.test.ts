// @vitest-environment jsdom
/**
 * RequirementsTree: an exploded bill nested by level, with totals; from a
 * plan, available and short per line and what building a shortfall takes;
 * the adapters from a service result; and accessibility.
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  within,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import type { ExplodedLine, PlannedLine } from '../../types.js';
import RequirementsTree from '../components/RequirementsTree.svelte';
import { toRequirementTotals, toRequirementTree } from '../types.js';

const frame = { bomId: 'bom-frame', productId: 'p-frame', name: 'Frame' };
const panelBill = {
  bomId: 'bom-panel',
  productId: 'p-panel',
  name: 'Side panel',
};

function line(overrides: Partial<PlannedLine>): PlannedLine {
  return {
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
    totalQty: 1,
    buildable: false,
    subBomId: null,
    expanded: false,
    available: 0,
    short: 0,
    ...overrides,
  };
}

/** Frame ×10 with 5 side panels in stock: 16 to build. */
const planLines: PlannedLine[] = [
  line({
    lineId: 'l-panel',
    componentSkuId: 'sku-panel',
    kind: 'assembly',
    name: 'Side panel',
    skuCode: 'SP',
    uom: 'each',
    totalQty: 21,
    available: 5,
    short: 16,
    buildable: true,
    subBomId: 'bom-panel',
    expanded: true,
  }),
  line({
    lineId: 'l-bolt',
    bomId: 'bom-panel',
    level: 2,
    path: [frame, panelBill],
    componentSkuId: 'sku-bolt',
    name: 'Bolt',
    skuCode: 'BT',
    uom: 'each',
    totalQty: 64,
    available: 50,
    short: 14,
  }),
  line({
    lineId: 'l-tube2',
    bomId: 'bom-panel',
    level: 2,
    path: [frame, panelBill],
    componentSkuId: 'sku-tube',
    totalQty: 35.2,
    available: 100,
    short: 0,
  }),
  line({
    lineId: 'l-tube',
    componentSkuId: 'sku-tube',
    totalQty: 30,
    available: 64.8,
    short: 0,
  }),
  line({
    lineId: 'l-gusset',
    componentSkuId: 'sku-gusset',
    kind: 'assembly',
    name: 'Gusset',
    skuCode: 'GS',
    uom: 'each',
    totalQty: 2,
    available: 0,
    short: 2,
  }),
];

describe('RequirementsTree', () => {
  it('nests a plan by level with available and short per line', () => {
    render(RequirementsTree, {
      props: {
        lines: toRequirementTree({ lines: planLines }),
        totals: toRequirementTotals({ lines: planLines }),
      },
    });
    const top = screen.getByRole('list', { name: 'Requirements' });
    const panel = within(top).getAllByRole('listitem')[0];
    expect(within(panel).getByText('Side panel (SP)')).toBeInTheDocument();
    expect(within(panel).getByText('Sub-assembly')).toBeInTheDocument();
    expect(within(panel).getByText('Short: 16')).toBeInTheDocument();
    const sub = within(panel).getByRole('list', {
      name: 'Building Side panel takes',
    });
    expect(within(sub).getByText('Bolt (BT)')).toBeInTheDocument();
    expect(within(sub).getByText('Required: 64 each')).toBeInTheDocument();
    expect(within(sub).getByText('Available: 50')).toBeInTheDocument();
    expect(within(sub).getByText('Short: 14')).toBeInTheDocument();
    expect(within(sub).getAllByText('Covered')).toHaveLength(1);
    const gusset = within(top)
      .getAllByRole('listitem')
      .find((item) => item.textContent?.includes('Gusset'));
    expect(
      gusset && within(gusset).getByText('No active bill'),
    ).toBeInTheDocument();
  });

  it('shows totals for the lines not opened, with what is short', () => {
    render(RequirementsTree, {
      props: {
        lines: toRequirementTree({ lines: planLines }),
        totals: toRequirementTotals({ lines: planLines }),
      },
    });
    const table = screen.getByRole('table', { name: 'Totals' });
    const tube = within(within(table).getByRole('row', { name: /Tube/ }));
    expect(tube.getByText('65.2')).toBeInTheDocument();
    expect(
      within(table).queryByRole('row', { name: /Side panel/ }),
    ).not.toBeInTheDocument();
    const bolt = within(within(table).getByRole('row', { name: /Bolt/ }));
    expect(bolt.getByText('14')).toBeInTheDocument();
    expect(
      screen.getByRole('columnheader', { name: 'Short' }),
    ).toBeInTheDocument();
  });

  it('shows a gross explosion without stock columns', () => {
    const gross: ExplodedLine[] = planLines.map(
      ({ available, short, ...rest }) => rest,
    );
    render(RequirementsTree, {
      props: {
        lines: toRequirementTree({ lines: gross }),
        totals: toRequirementTotals({ lines: gross }),
      },
    });
    expect(screen.queryByText(/Available/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('columnheader', { name: 'Short' }),
    ).not.toBeInTheDocument();
  });

  it('says when nothing is required', () => {
    render(RequirementsTree, { props: { lines: [] } });
    expect(screen.getByText('Nothing is required')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('keeps a shared sub-assembly apart in each place it is used', () => {
    const shared = [
      line({
        lineId: 'l-a',
        kind: 'assembly',
        name: 'Bracket',
        buildable: true,
        subBomId: 'bom-b',
        expanded: true,
      }),
      line({
        lineId: 'l-p',
        bomId: 'bom-b',
        level: 2,
        path: [frame, { ...panelBill, bomId: 'bom-b' }],
        name: 'Plate',
      }),
      line({
        lineId: 'l-c',
        kind: 'assembly',
        name: 'Side panel',
        buildable: true,
        subBomId: 'bom-panel',
        expanded: true,
      }),
      line({
        lineId: 'l-a',
        bomId: 'bom-panel',
        level: 2,
        path: [frame, panelBill],
        kind: 'assembly',
        name: 'Bracket',
        buildable: true,
        subBomId: 'bom-b',
        expanded: true,
      }),
      line({
        lineId: 'l-p',
        bomId: 'bom-b',
        level: 3,
        path: [frame, panelBill, { ...panelBill, bomId: 'bom-b' }],
        name: 'Plate',
      }),
    ];
    const tree = toRequirementTree({ lines: shared });
    expect(tree.map((node) => node.name)).toEqual(['Bracket', 'Side panel']);
    expect(tree[1].children[0].children[0].name).toBe('Plate');
    expect(new Set([tree[0].key, tree[1].children[0].key]).size).toBe(2);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(RequirementsTree, {
      props: {
        lines: toRequirementTree({ lines: planLines }),
        totals: toRequirementTotals({ lines: planLines }),
      },
    });
    await expectNoA11yViolations(container);
  });
});
