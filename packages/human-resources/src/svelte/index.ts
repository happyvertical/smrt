/**
 * @happyvertical/smrt-human-resources/svelte
 *
 * Props-driven Svelte 5 surfaces for HR records: an employee list, an
 * employee form, one person's qualifications with their expiry state, and an
 * "expiring soon" list. Hosts load data
 * through the package services and pass plain view objects.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import type { ComponentProps } from 'svelte';
import { HUMAN_RESOURCES_MODULE_META } from '../ui.js';
import EmployeeForm from './components/EmployeeForm.svelte';
import EmployeeList from './components/EmployeeList.svelte';
import ExpiringQualificationsList from './components/ExpiringQualificationsList.svelte';
import PersonQualifications from './components/PersonQualifications.svelte';

export {
  EmployeeForm,
  EmployeeList,
  ExpiringQualificationsList,
  PersonQualifications,
};

export type EmployeeFormProps = ComponentProps<typeof EmployeeForm>;
export type EmployeeListProps = ComponentProps<typeof EmployeeList>;
export type ExpiringQualificationsListProps = ComponentProps<
  typeof ExpiringQualificationsList
>;
export type PersonQualificationsProps = ComponentProps<
  typeof PersonQualifications
>;

export {
  DEFAULT_EXPIRING_SOON_DAYS,
  daysUntil,
  type EmployeeFormDraft,
  type EmployeeFormField,
  type EmployeeFormInitial,
  type EmployeeFormValidation,
  type EmployeeFormValues,
  type EmployeeLoginOption,
  type EmployeeView,
  type EmploymentLike,
  type ExpiringQualificationView,
  employmentStatusBadgeKey,
  employmentStatusLabelKey,
  expiryDistance,
  type HeldQualificationLike,
  isCalendarDate,
  isWorkerType,
  type PersonQualificationView,
  type ProfileQualificationLike,
  type QualificationExpiryState,
  type QualificationLike,
  type QualificationStatusOn,
  qualificationExpiryState,
  qualificationKindLabelKey,
  qualificationStateBadgeKey,
  qualificationStateLabelKey,
  sortBySoonestExpiry,
  toEmployeeFormInitial,
  toEmployeeView,
  toExpiringQualificationView,
  toPersonQualificationView,
  validateEmployeeForm,
} from './types.js';

// Auto-register with ModuleUIRegistry
ModuleUIRegistry.registerModule(HUMAN_RESOURCES_MODULE_META);
ModuleUIRegistry.register(
  '@happyvertical/smrt-human-resources',
  'employee-list',
  EmployeeList,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-human-resources',
  'employee-form',
  EmployeeForm,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-human-resources',
  'person-qualifications',
  PersonQualifications,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-human-resources',
  'expiring-qualifications-list',
  ExpiringQualificationsList,
);
