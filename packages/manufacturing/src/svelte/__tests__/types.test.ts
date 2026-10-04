/**
 * The view adapters and the bill-line validation behind the components.
 */
import { describe, expect, it } from 'vitest';
import type { BillStructure } from '../../services/AssemblyService.js';
import {
  componentKindLabelKey,
  splitLabourMinutes,
  toAssemblyView,
  toBomEditorLine,
  toBomEditorLines,
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
