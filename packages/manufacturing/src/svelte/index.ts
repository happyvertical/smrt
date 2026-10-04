/**
 * @happyvertical/smrt-manufacturing/svelte
 *
 * Props-driven Svelte 5 surfaces for the managed list of operations: an
 * operation list (with retire and reinstate) and an operation form. Hosts load
 * data through `OperationService` and pass plain view objects.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import type { ComponentProps } from 'svelte';
import { MANUFACTURING_MODULE_META } from '../ui.js';
import OperationForm from './components/OperationForm.svelte';
import OperationList from './components/OperationList.svelte';

export { OperationForm, OperationList };

export type OperationFormProps = ComponentProps<typeof OperationForm>;
export type OperationListProps = ComponentProps<typeof OperationList>;

export {
  type OperationFormDraft,
  type OperationFormField,
  type OperationFormInitial,
  type OperationFormValidation,
  type OperationFormValues,
  type OperationView,
  operationStatusBadgeKey,
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
