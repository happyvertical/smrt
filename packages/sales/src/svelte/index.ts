import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import type { ComponentProps } from 'svelte';
import { SALES_MODULE_META } from '../ui.js';
import LeadList from './components/LeadList.svelte';
import OpportunityBoard from './components/OpportunityBoard.svelte';
import SalesDetail from './components/SalesDetail.svelte';

export { LeadList, OpportunityBoard, SalesDetail };

export type LeadListProps = ComponentProps<typeof LeadList>;
export type OpportunityBoardProps = ComponentProps<typeof OpportunityBoard>;
export type SalesDetailProps = ComponentProps<typeof SalesDetail>;

export type {
  SalesAcquisitionView,
  SalesActivityView,
  SalesBoardOpportunity,
  SalesDetailRecord,
  SalesLeadListItem,
  SalesPipelineStageView,
} from './types.js';

ModuleUIRegistry.registerModule(SALES_MODULE_META);
ModuleUIRegistry.register('@happyvertical/smrt-sales', 'lead-list', LeadList);
ModuleUIRegistry.register(
  '@happyvertical/smrt-sales',
  'opportunity-board',
  OpportunityBoard,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-sales',
  'sales-detail',
  SalesDetail,
);
