// @vitest-environment jsdom
/**
 * BomEditor: lines for materials and sub-assemblies, each sub-assembly saying
 * whether it has its own bill and expanding to it read-only (to any depth);
 * adding, editing and removing lines through the host's handlers; the host's
 * error; and accessibility.
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
  within,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import BomEditor from '../components/BomEditor.svelte';
import type { BomEditorLine } from '../types.js';
import { editorLine } from './fixtures.js';

const steel = editorLine();
const panel = editorLine({
  id: 'line-2',
  componentSkuId: 'sku-panel',
  componentName: 'Side panel',
  skuCode: 'SP-100',
  kind: 'assembly',
  qtyPerUnit: 2,
  uom: 'each',
  wastePercent: 0,
  subBomId: 'bom-panel',
});
const bracket = editorLine({
  id: 'line-3',
  componentSkuId: 'sku-bracket',
  componentName: 'Bracket',
  skuCode: 'BR-7',
  kind: 'assembly',
  qtyPerUnit: 4,
  uom: 'each',
  wastePercent: 0,
  subBomId: null,
});

const subBills: Record<string, BomEditorLine[]> = {
  'bom-panel': [
    editorLine({
      id: 'p-1',
      componentName: 'Hinge',
      skuCode: 'HN-1',
      kind: 'assembly',
      qtyPerUnit: 2,
      uom: 'each',
      subBomId: 'bom-hinge',
    }),
    editorLine({
      id: 'p-2',
      componentName: 'Sheet',
      skuCode: 'SH-1',
      kind: 'material',
      qtyPerUnit: 1.2,
      uom: 'm2',
    }),
  ],
  'bom-hinge': [
    editorLine({
      id: 'h-1',
      componentName: 'Pin',
      skuCode: 'PN-1',
      kind: 'bought',
      qtyPerUnit: 1,
      uom: 'each',
    }),
  ],
};

const loadBill = vi.fn(async (bomId: string) => subBills[bomId] ?? []);

describe('BomEditor', () => {
  it('lists materials and sub-assemblies, saying which have their own bill', () => {
    render(BomEditor, { props: { lines: [steel, panel, bracket] } });
    const steelRow = within(screen.getByRole('row', { name: /Steel tube/ }));
    expect(steelRow.getByText('Material')).toBeInTheDocument();
    expect(steelRow.getByText('3.5')).toBeInTheDocument();
    expect(steelRow.getByText('m')).toBeInTheDocument();
    const panelRow = within(screen.getByRole('row', { name: /Side panel/ }));
    expect(
      panelRow.getByRole('rowheader', { name: 'Side panel (SP-100)' }),
    ).toBeInTheDocument();
    expect(panelRow.getByText('Sub-assembly')).toBeInTheDocument();
    expect(panelRow.getByText('Has its own bill')).toBeInTheDocument();
    const bracketRow = within(screen.getByRole('row', { name: /Bracket/ }));
    expect(bracketRow.getByText('No active bill')).toBeInTheDocument();
    // Read-only without handlers: no inputs and no expansion without loadBill.
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('expands a sub-assembly to its own bill, read-only, to any depth', async () => {
    loadBill.mockClear();
    render(BomEditor, { props: { lines: [steel, panel, bracket], loadBill } });
    expect(
      screen.queryByRole('button', { name: 'Show the bill of Bracket' }),
    ).not.toBeInTheDocument();

    const show = screen.getByRole('button', {
      name: 'Show the bill of Side panel',
    });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(show);
    expect(loadBill).toHaveBeenCalledWith('bom-panel');
    const panelBill = await screen.findByRole('list', {
      name: 'Bill of Side panel',
    });
    expect(within(panelBill).getByText('Sheet (SH-1)')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Hide the bill of Side panel' }),
    ).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(
      within(panelBill).getByRole('button', { name: 'Show the bill of Hinge' }),
    );
    const hingeBill = await screen.findByRole('list', {
      name: 'Bill of Hinge',
    });
    expect(within(hingeBill).getByText('Pin (PN-1)')).toBeInTheDocument();
    expect(within(hingeBill).getByText('Bought item')).toBeInTheDocument();
    // Nothing in a sub-bill is editable.
    expect(within(panelBill).queryByRole('spinbutton')).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'Hide the bill of Side panel' }),
    );
    expect(
      screen.queryByRole('list', { name: 'Bill of Side panel' }),
    ).not.toBeInTheDocument();
  });

  it('never expands the bill being edited inside itself', () => {
    render(BomEditor, {
      props: { lines: [panel], loadBill, bomId: 'bom-panel' },
    });
    expect(
      screen.queryByRole('button', { name: 'Show the bill of Side panel' }),
    ).not.toBeInTheDocument();
  });

  it('says when a sub-assembly bill cannot be loaded', async () => {
    render(BomEditor, {
      props: {
        lines: [panel],
        loadBill: () => Promise.reject(new Error('offline')),
      },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Show the bill of Side panel' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The bill could not be loaded',
    );
  });

  it('adds a line with checked values and resets the draft', async () => {
    const onadd = vi.fn();
    render(BomEditor, {
      props: {
        lines: [steel],
        components: [
          { skuId: 'sku-panel', label: 'Side panel (SP-100)' },
          { skuId: 'sku-bolt', label: 'Bolt (BT-8)' },
        ],
        onadd,
      },
    });
    const add = screen.getByRole('button', { name: 'Add line' });
    await userEvent.click(add);
    expect(onadd).not.toHaveBeenCalled();
    expect(screen.getByText('Choose a component.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Component' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Component' }),
      'sku-bolt',
    );
    const qty = screen.getByRole('spinbutton', { name: 'Quantity per unit' });
    await userEvent.clear(qty);
    await userEvent.type(qty, '6');
    await userEvent.click(add);
    expect(onadd).toHaveBeenCalledExactlyOnceWith({
      componentSkuId: 'sku-bolt',
      qtyPerUnit: 6,
      uom: 'each',
      wastePercent: 0,
    });
    expect(screen.getByRole('combobox', { name: 'Component' })).toHaveValue('');
    expect(screen.queryByText('Choose a component.')).not.toBeInTheDocument();
  });

  it('keeps the draft when the host refuses the add', async () => {
    const onadd = vi.fn(() => false);
    render(BomEditor, {
      props: {
        lines: [],
        components: [{ skuId: 'sku-frame', label: 'Frame (FR-100)' }],
        onadd,
        error: 'Refused: "Frame" would contain itself: Frame → Frame',
      },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Refused: "Frame" would contain itself: Frame → Frame',
    );
    expect(screen.getByText('This bill has no lines yet')).toBeInTheDocument();
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Component' }),
      'sku-frame',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add line' }));
    expect(onadd).toHaveBeenCalledOnce();
    expect(screen.getByRole('combobox', { name: 'Component' })).toHaveValue(
      'sku-frame',
    );
  });

  it('refuses a zero quantity and a negative waste', async () => {
    const onadd = vi.fn();
    render(BomEditor, {
      props: {
        lines: [],
        components: [{ skuId: 'sku-bolt', label: 'Bolt' }],
        onadd,
      },
    });
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Component' }),
      'sku-bolt',
    );
    const qty = screen.getByRole('spinbutton', { name: 'Quantity per unit' });
    await userEvent.clear(qty);
    await userEvent.type(qty, '0');
    const waste = screen.getByRole('spinbutton', { name: 'Waste %' });
    await userEvent.clear(waste);
    await userEvent.type(waste, '-5');
    await userEvent.click(screen.getByRole('button', { name: 'Add line' }));
    expect(onadd).not.toHaveBeenCalled();
    expect(
      screen.getByText('Enter a quantity greater than zero.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Enter a waste percent of zero or more.'),
    ).toBeInTheDocument();
  });

  it('saves an edited line and removes a line through the host', async () => {
    const onupdate = vi.fn();
    const onremove = vi.fn();
    render(BomEditor, { props: { lines: [steel, panel], onupdate, onremove } });
    const save = screen.getByRole('button', { name: 'Save line: Steel tube' });
    expect(save).toBeDisabled();
    const qty = screen.getByRole('spinbutton', {
      name: 'Quantity per unit for Steel tube',
    });
    await userEvent.clear(qty);
    await userEvent.type(qty, '4');
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(onupdate).toHaveBeenCalledExactlyOnceWith('line-1', {
      componentSkuId: 'sku-steel',
      qtyPerUnit: 4,
      uom: 'm',
      wastePercent: 10,
    });

    await userEvent.click(
      screen.getByRole('button', { name: 'Remove line: Side panel' }),
    );
    expect(onremove).toHaveBeenCalledExactlyOnceWith('line-2');
  });

  it('refuses an edit that empties the unit', async () => {
    const onupdate = vi.fn();
    render(BomEditor, { props: { lines: [steel], onupdate } });
    const unit = screen.getByRole('textbox', { name: 'Unit for Steel tube' });
    await userEvent.clear(unit);
    await userEvent.click(
      screen.getByRole('button', { name: 'Save line: Steel tube' }),
    );
    expect(onupdate).not.toHaveBeenCalled();
    expect(unit).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Enter a unit.')).toBeInTheDocument();
  });

  it('blocks every control while disabled', () => {
    render(BomEditor, {
      props: {
        lines: [steel],
        components: [{ skuId: 'sku-bolt', label: 'Bolt' }],
        onadd: vi.fn(),
        onupdate: vi.fn(),
        onremove: vi.fn(),
        disabled: true,
      },
    });
    for (const button of screen.getAllByRole('button'))
      expect(button).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Component' })).toBeDisabled();
  });

  it('is axe-clean, editable and expanded', async () => {
    const { container } = render(BomEditor, {
      props: {
        lines: [steel, panel, bracket],
        components: [{ skuId: 'sku-bolt', label: 'Bolt' }],
        onadd: vi.fn(),
        onupdate: vi.fn(),
        onremove: vi.fn(),
        loadBill,
      },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Show the bill of Side panel' }),
    );
    await screen.findByRole('list', { name: 'Bill of Side panel' });
    await expectNoA11yViolations(container);
  });
});
