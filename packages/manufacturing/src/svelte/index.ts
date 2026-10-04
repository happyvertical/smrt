/**
 * @happyvertical/smrt-manufacturing/svelte
 *
 * Props-driven Svelte 5 surfaces: the managed list of operations (a list with
 * retire and reinstate, and a form), and assemblies (a list, a policy-driven
 * form, and a bill-of-materials editor whose sub-assemblies expand to their own
 * bills). Hosts load data through the package services and collections and
 * pass plain view objects.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import type { ComponentProps } from 'svelte';
import { MANUFACTURING_MODULE_META } from '../ui.js';
import AssemblyForm from './components/AssemblyForm.svelte';
import AssemblyList from './components/AssemblyList.svelte';
import BomEditor from './components/BomEditor.svelte';
import BomStructureTree from './components/BomStructureTree.svelte';
import OperationForm from './components/OperationForm.svelte';
import OperationList from './components/OperationList.svelte';

export {
  AssemblyForm,
  AssemblyList,
  BomEditor,
  BomStructureTree,
  OperationForm,
  OperationList,
};

export type AssemblyFormProps = ComponentProps<typeof AssemblyForm>;
export type AssemblyListProps = ComponentProps<typeof AssemblyList>;
export type BomEditorProps = ComponentProps<typeof BomEditor>;
export type BomStructureTreeProps = ComponentProps<typeof BomStructureTree>;

export type OperationFormProps = ComponentProps<typeof OperationForm>;
export type OperationListProps = ComponentProps<typeof OperationList>;

export {
  type AssemblyView,
  type BomComponentOption,
  type BomEditorLine,
  type BomLineDraft,
  type BomLineDraftField,
  type BomLineInput,
  type BomLineValidation,
  type ComponentKind,
  componentKindLabelKey,
  type OperationFormDraft,
  type OperationFormField,
  type OperationFormInitial,
  type OperationFormValidation,
  type OperationFormValues,
  type OperationView,
  operationStatusBadgeKey,
  splitLabourMinutes,
  toAssemblyView,
  toBomEditorLine,
  toBomEditorLines,
  validateBomLineInput,
  validateOperationForm,
} from './types.js';

// Auto-register with ModuleUIRegistry
ModuleUIRegistry.registerModule(MANUFACTURING_MODULE_META);
ModuleUIRegistry.register(
  '@happyvertical/smrt-manufacturing',
  'operation-list',
  OperationList,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-manufacturing',
  'operation-form',
  OperationForm,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-manufacturing',
  'assembly-list',
  AssemblyList,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-manufacturing',
  'assembly-form',
  AssemblyForm,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-manufacturing',
  'bom-editor',
  BomEditor,
);
