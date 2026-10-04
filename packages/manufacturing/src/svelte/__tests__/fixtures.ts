/** Shared view and policy fixtures for the manufacturing component tests. */
import type {
  AssemblyFieldPolicy,
  AssemblyView,
  BomEditorLine,
} from '../types.js';

export function assemblyView(
  overrides: Partial<AssemblyView> = {},
): AssemblyView {
  return {
    id: 'asm-1',
    name: 'Frame',
    partReference: 'DWG-1001',
    skuCodes: ['FR-100'],
    price: 125000,
    estimatedLabourMinutes: 95,
    activeBomVersion: 3,
    ...overrides,
  };
}

export function editorLine(
  overrides: Partial<BomEditorLine> = {},
): BomEditorLine {
  return {
    id: 'line-1',
    componentSkuId: 'sku-steel',
    componentName: 'Steel tube',
    skuCode: 'ST-25',
    kind: 'material',
    qtyPerUnit: 3.5,
    uom: 'm',
    wastePercent: 10,
    notes: '',
    subBomId: null,
    ...overrides,
  };
}

/**
 * A resolved Assembly field policy for `AssemblyList`. `visibility` maps
 * field name to its visibility; fields not named are basic.
 */
export function assemblyPolicy(
  visibility: Record<string, 'basic' | 'advanced' | 'hidden'> = {},
): AssemblyFieldPolicy {
  const names = [
    'name',
    'partReference',
    'price',
    'estimatedLabourMinutes',
    'description',
  ];
  return {
    fields: Object.fromEntries(
      names.map((fieldName) => [
        fieldName,
        { visibility: visibility[fieldName] ?? 'basic' },
      ]),
    ),
  };
}
