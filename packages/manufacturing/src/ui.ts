/**
 * Manufacturing Module UI Slot Declarations
 *
 * UI extension points for the manufacturing module. Components live in the
 * ./svelte subpath and are props-driven: hosts load records through the
 * services and pass plain view objects.
 */

import type { ModuleUISlot, SmrtModuleMeta } from '@happyvertical/smrt-types';

/**
 * Manufacturing module UI slots
 */
export const MANUFACTURING_UI_SLOTS: Record<string, ModuleUISlot> = {
  'operation-list': {
    id: 'operation-list',
    label: 'Operation List',
    description:
      'Table of operations with category, status and retire or reinstate actions',
    icon: 'list',
    category: 'list',
    order: 1,
    propsInterface: 'OperationListProps',
  },
  'operation-form': {
    id: 'operation-form',
    label: 'Operation Form',
    description: 'Add an operation, or rename and recategorize an existing one',
    icon: 'edit',
    category: 'form',
    order: 2,
    propsInterface: 'OperationFormProps',
  },
  'assembly-list': {
    id: 'assembly-list',
    label: 'Assembly List',
    description: 'Table of assemblies with part reference, SKU, price and bill',
    icon: 'list',
    category: 'list',
    order: 3,
    propsInterface: 'AssemblyListProps',
  },
  'assembly-form': {
    id: 'assembly-form',
    label: 'Assembly Form',
    description: 'Policy-driven create and edit form for an assembly',
    icon: 'edit',
    category: 'form',
    order: 4,
    propsInterface: 'AssemblyFormProps',
  },
  'bom-editor': {
    id: 'bom-editor',
    label: 'Bill of Materials Editor',
    description:
      "Edits an assembly's bill: materials and sub-assemblies, each sub-assembly expandable to its own bill",
    icon: 'tree',
    category: 'form',
    order: 5,
    propsInterface: 'BomEditorProps',
  },
};
/**
 * Manufacturing module metadata
 */
export const MANUFACTURING_MODULE_META: SmrtModuleMeta = {
  name: '@happyvertical/smrt-manufacturing',
  displayName: 'Manufacturing',
  description:
    'Assemblies, bills of materials, routing operations, cost and labour rollup, and production-order stock movement',
  uiSlots: MANUFACTURING_UI_SLOTS,
  models: [
    'Assembly',
    'BillOfMaterials',
    'BomLine',
    'Operation',
    'RoutingStep',
  ],
  collections: [
    'AssemblyCollection',
    'BillOfMaterialsCollection',
    'BomLineCollection',
    'OperationCollection',
    'RoutingStepCollection',
  ],
};
