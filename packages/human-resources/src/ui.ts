/**
 * Human Resources Module UI Slot Declarations
 *
 * UI extension points for the HR module. Components are implemented in the
 * ./svelte subpath and are props-driven: hosts load records through the
 * services and pass plain view objects.
 */

import type { ModuleUISlot, SmrtModuleMeta } from '@happyvertical/smrt-types';

/**
 * Human resources module UI slots
 */
export const HUMAN_RESOURCES_UI_SLOTS: Record<string, ModuleUISlot> = {
  'employee-list': {
    id: 'employee-list',
    label: 'Employee List',
    description:
      'Table of employees with position, worker type, status and start date',
    icon: 'list',
    category: 'list',
    order: 1,
    propsInterface: 'EmployeeListProps',
  },
  'employee-form': {
    id: 'employee-form',
    label: 'Employee Form',
    description: 'Hire or edit form for the employment fields a host manages',
    icon: 'edit',
    category: 'form',
    order: 2,
    propsInterface: 'EmployeeFormProps',
  },
  'person-qualifications': {
    id: 'person-qualifications',
    label: 'Person Qualifications',
    description: "One person's qualifications with their expiry state",
    icon: 'badge',
    category: 'display',
    order: 3,
    propsInterface: 'PersonQualificationsProps',
  },
  'expiring-qualifications-list': {
    id: 'expiring-qualifications-list',
    label: 'Expiring Qualifications List',
    description: 'Qualifications expiring soon across people, soonest first',
    icon: 'clock',
    category: 'list',
    order: 4,
    propsInterface: 'ExpiringQualificationsListProps',
  },
};

/**
 * Human resources module metadata
 */
export const HUMAN_RESOURCES_MODULE_META: SmrtModuleMeta = {
  name: '@happyvertical/smrt-human-resources',
  displayName: 'Human Resources',
  description:
    'Employment records with dated terms, and qualifications with expiry',
  uiSlots: HUMAN_RESOURCES_UI_SLOTS,
  models: [
    'Employment',
    'EmploymentTerm',
    'EmploymentChange',
    'Qualification',
    'HeldQualification',
    'HeldQualificationChange',
  ],
  collections: [
    'EmploymentCollection',
    'EmploymentTermCollection',
    'EmploymentChangeCollection',
    'QualificationCollection',
    'HeldQualificationCollection',
    'HeldQualificationChangeCollection',
  ],
};
