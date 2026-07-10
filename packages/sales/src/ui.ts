import type { ModuleUISlot, SmrtModuleMeta } from '@happyvertical/smrt-types';

export const SALES_UI_SLOTS: Record<string, ModuleUISlot> = {
  'lead-list': {
    id: 'lead-list',
    label: 'Lead List',
    description:
      'Lead queue with assignment and qualification actions for sales reps',
    icon: 'users',
    category: 'list',
    order: 1,
    propsInterface: 'LeadListProps',
  },
  'opportunity-board': {
    id: 'opportunity-board',
    label: 'Opportunity Board',
    description:
      'Pipeline board showing stage movement, value, next action, and outcomes',
    icon: 'columns-3',
    category: 'dashboard',
    order: 2,
    propsInterface: 'OpportunityBoardProps',
  },
  'sales-detail': {
    id: 'sales-detail',
    label: 'Sales Detail',
    description:
      'Detail surface for lead and opportunity history, activities, and outcomes',
    icon: 'panel-right',
    category: 'detail',
    order: 3,
    propsInterface: 'SalesDetailProps',
  },
};

export const SALES_MODULE_META: SmrtModuleMeta = {
  name: '@happyvertical/smrt-sales',
  displayName: 'Sales',
  description:
    'Tenant-scoped CRM primitives for leads, opportunities, pipelines, and sales workflows',
  uiSlots: SALES_UI_SLOTS,
  models: [
    'Lead',
    'Opportunity',
    'PipelineDefinition',
    'PipelineStage',
    'SalesActivity',
    'LeadMerge',
  ],
  collections: [
    'LeadCollection',
    'OpportunityCollection',
    'PipelineDefinitionCollection',
    'PipelineStageCollection',
    'SalesActivityCollection',
    'LeadMergeCollection',
  ],
};
