/**
 * The view adapters and the bill-line validation behind the components.
 */
import { describe, expect, it } from 'vitest';
import type { BillStructure } from '../../services/AssemblyService.js';
import {
  assemblyFormDraft,
  componentKindLabelKey,
  formatPriceInput,
  keepProtectedFields,
  splitLabourMinutes,
  toAssemblyView,
  toBomEditorLine,
  toBomEditorLines,
  validateAssemblyForm,
  validateBomLineInput,
} from '../index.js';

describe('validateBomLineInput', () => {
  it('returns trimmed, numeric values for a good line', () => {
    expect(
      validateBomLineInput({
        componentSkuId: ' sku-1 ',
        qtyPerUnit: '2.5',
        uom: ' m ',
        wastePercent: '',
      }),
    ).toEqual({
      ok: true,
      value: {
        componentSkuId: 'sku-1',
        qtyPerUnit: 2.5,
        uom: 'm',
        wastePercent: 0,
      },
    });
  });

  it('names every field that is wrong', () => {
    expect(
      validateBomLineInput({
        componentSkuId: '',
        qtyPerUnit: '0',
        uom: '  ',
        wastePercent: -1,
      }),
    ).toEqual({
      ok: false,
      invalid: ['componentSkuId', 'qtyPerUnit', 'uom', 'wastePercent'],
    });
    expect(
      validateBomLineInput({
        componentSkuId: 'x',
        qtyPerUnit: 'abc',
        uom: 'each',
        wastePercent: 'n/a',
      }),
    ).toEqual({ ok: false, invalid: ['qtyPerUnit', 'wastePercent'] });
    expect(
      validateBomLineInput({
        componentSkuId: 'x',
        qtyPerUnit: '',
        uom: 'each',
        wastePercent: 0,
      }),
    ).toEqual({ ok: false, invalid: ['qtyPerUnit'] });
  });
});

describe('adapters', () => {
  it('builds an assembly row from the model and its neighbours', () => {
    expect(
      toAssemblyView(
        {
          id: 'a1',
          name: 'Frame',
          partReference: 'DWG-1',
          price: 1999,
          estimatedLabourMinutes: 30,
        },
        { skuCodes: ['FR-1'], activeBomVersion: 2 },
      ),
    ).toEqual({
      id: 'a1',
      name: 'Frame',
      partReference: 'DWG-1',
      skuCodes: ['FR-1'],
      price: 1999,
      estimatedLabourMinutes: 30,
      activeBomVersion: 2,
    });
    expect(
      toAssemblyView({
        id: 'a2',
        name: 'Bare',
        partReference: '',
        price: 0,
        estimatedLabourMinutes: 0,
      }),
    ).toMatchObject({ skuCodes: [], activeBomVersion: null });
  });

  it('builds editor lines from a bill structure', () => {
    const structure = {
      bom: { id: 'bom-1' },
      lines: [
        {
          line: {
            id: 'l1',
            componentSkuId: 'sku-p',
            qtyPerUnit: 2,
            uom: 'each',
            wastePercent: 0,
            notes: 'left side',
          },
          component: {
            skuId: 'sku-p',
            kind: 'assembly',
            sku: { code: 'SP-1' },
            product: { name: 'Panel' },
            assembly: { name: 'Panel' },
            activeBom: { id: 'bom-p' },
            buildable: true,
          },
        },
        {
          line: {
            id: 'l2',
            componentSkuId: 'sku-gone',
            qtyPerUnit: 1,
            uom: 'each',
            wastePercent: 0,
            notes: '',
          },
          component: {
            skuId: 'sku-gone',
            kind: 'missing',
            sku: null,
            product: null,
            assembly: null,
            activeBom: null,
            buildable: false,
          },
        },
      ],
    } as unknown as BillStructure;

    expect(toBomEditorLines(structure)).toEqual([
      {
        id: 'l1',
        componentSkuId: 'sku-p',
        componentName: 'Panel',
        skuCode: 'SP-1',
        kind: 'assembly',
        qtyPerUnit: 2,
        uom: 'each',
        wastePercent: 0,
        notes: 'left side',
        subBomId: 'bom-p',
      },
      {
        id: 'l2',
        componentSkuId: 'sku-gone',
        componentName: 'sku-gone',
        skuCode: '',
        kind: 'missing',
        qtyPerUnit: 1,
        uom: 'each',
        wastePercent: 0,
        notes: '',
        subBomId: null,
      },
    ]);
    expect(toBomEditorLine(structure.lines[0]).subBomId).toBe('bom-p');
  });

  it('labels every component kind and splits labour', () => {
    expect(componentKindLabelKey('assembly')).not.toBe(
      componentKindLabelKey('material'),
    );
    expect(componentKindLabelKey('bought')).not.toBe(
      componentKindLabelKey('missing'),
    );
    expect(splitLabourMinutes(95)).toEqual({ hours: 1, minutes: 35 });
    expect(splitLabourMinutes(-3)).toEqual({ hours: 0, minutes: 0 });
  });
});

describe('validateAssemblyForm', () => {
  const draft = {
    name: ' Frame ',
    price: '12.5',
    estimatedLabourMinutes: '90',
    defaultOperationId: ' ',
    tags: 'a, b,a',
  };

  it('trims, converts price to minor units and clears a blank operation', () => {
    expect(validateAssemblyForm(draft)).toEqual({
      ok: true,
      values: {
        name: 'Frame',
        description: '',
        category: '',
        partReference: '',
        price: 1250,
        estimatedLabourMinutes: 90,
        defaultOperationId: null,
        tags: ['a', 'b'],
      },
    });
  });

  it('rejects what the model rejects: fractional or negative minutes', () => {
    for (const minutes of ['1.5', '-1', 'x', '1e3']) {
      expect(
        validateAssemblyForm({ ...draft, estimatedLabourMinutes: minutes }),
      ).toEqual({ ok: false, invalid: ['estimatedLabourMinutes'] });
    }
  });

  it('skips the fields it is told to', () => {
    expect(
      validateAssemblyForm({ name: '', price: 'x' }, ['name', 'price']).ok,
    ).toBe(true);
  });

  it('round-trips a price through the input format', () => {
    expect(formatPriceInput(125050)).toBe('1250.50');
    expect(formatPriceInput(5)).toBe('0.05');
    expect(formatPriceInput(-123)).toBe('-1.23');
    expect(formatPriceInput(1300, 0)).toBe('1300');
    expect(formatPriceInput(1234, 3)).toBe('1.234');
  });
});

describe('validateAssemblyForm part number', () => {
  const base = {
    name: 'Frame',
    description: '',
    category: '',
    partReference: '',
    price: '0',
    estimatedLabourMinutes: '0',
    defaultOperationId: '',
    tags: '',
  };

  it('is absent from the values when the draft has none', () => {
    const result = validateAssemblyForm(base);
    expect(result.ok && 'skuCode' in result.values).toBe(false);
  });

  it('trims it and rejects an empty one unless skipped', () => {
    expect(validateAssemblyForm({ ...base, skuCode: ' FR-1 ' })).toMatchObject({
      ok: true,
      values: { skuCode: 'FR-1' },
    });
    expect(validateAssemblyForm({ ...base, skuCode: '  ' })).toEqual({
      ok: false,
      invalid: ['skuCode'],
    });
    expect(validateAssemblyForm({ ...base, skuCode: '' }, ['skuCode']).ok).toBe(
      true,
    );
  });

  it('starts the draft from the stored code and keeps it when protected', () => {
    const initial = {
      name: 'F',
      description: '',
      category: '',
      partReference: '',
      price: 0,
      estimatedLabourMinutes: 0,
      defaultOperationId: null,
      tags: [],
      skuCode: ' X ',
    };
    expect(assemblyFormDraft(initial).skuCode).toBe(' X ');
    expect(
      'skuCode' in assemblyFormDraft({ ...initial, skuCode: undefined }),
    ).toBe(false);
    const checked = validateAssemblyForm({
      ...assemblyFormDraft(initial),
      skuCode: 'Y',
    });
    if (!checked.ok) throw new Error('expected ok');
    expect(
      keepProtectedFields(checked.values, initial, ['skuCode']).skuCode,
    ).toBe(' X ');
  });
});

describe('./svelte re-exports the view adapters unchanged', () => {
  it('is the same functions as ./views', async () => {
    const views = await import('../../views.js');
    const svelte = await import('../index.js');
    expect(svelte.toBomEditorLine).toBe(views.toBomEditorLine);
    expect(svelte.toBomEditorLines).toBe(views.toBomEditorLines);
    expect(svelte.toRequirementTree).toBe(views.toRequirementTree);
    expect(svelte.toRequirementTotals).toBe(views.toRequirementTotals);
  });
});
