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
  'production-run-list': {
    id: 'production-run-list',
    label: 'Production Run List',
    description:
      'Production runs with target, completed quantity and status, and completion reporting',
    icon: 'list',
    category: 'list',
    order: 6,
    propsInterface: 'ProductionRunListProps',
  },
  'requirements-tree': {
    id: 'requirements-tree',
    label: 'Requirements Tree',
    description:
      "A bill's exploded requirements by level, with totals and available and short stock",
    icon: 'tree',
    category: 'detail',
    order: 7,
    propsInterface: 'RequirementsTreeProps',
  },
};
/**
 * Manufacturing module metadata
 */
export const MANUFACTURING_MODULE_META: SmrtModuleMeta = {
  name: '@happyvertical/smrt-manufacturing',
  displayName: 'Manufacturing',
  description:
    'Assemblies, multi-level bills of materials, routing operations, cost and labour rollup, production runs, and production-order stock movement',
  uiSlots: MANUFACTURING_UI_SLOTS,
  models: [
    'Assembly',
    'BillOfMaterials',
    'BomLine',
    'Operation',
    'ProductionRun',
    'ProductionRunCompletion',
    'RoutingStep',
  ],
  collections: [
    'AssemblyCollection',
    'BillOfMaterialsCollection',
    'BomLineCollection',
    'OperationCollection',
    'ProductionRunCollection',
    'ProductionRunCompletionCollection',
    'RoutingStepCollection',
  ],
};
