/**
 * Projects Module Svelte Components
 *
 * Optional Svelte UI components for time tracking and project management.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import type { ComponentProps } from 'svelte';
import { PROJECTS_MODULE_META } from '../ui.js';
import AssistanceLauncher from './AssistanceLauncher.svelte';
// Import components
import ApprovalActions from './components/ApprovalActions.svelte';
import BulkActions from './components/BulkActions.svelte';
import DevelopmentRequestForm from './components/DevelopmentRequestForm.svelte';
import DevelopmentRequestList from './components/DevelopmentRequestList.svelte';
import DurationDisplay from './components/DurationDisplay.svelte';
import RejectDialog from './components/RejectDialog.svelte';
import TimeEntryCard from './components/TimeEntryCard.svelte';
import TimeEntryList from './components/TimeEntryList.svelte';
import TimeSummary from './components/TimeSummary.svelte';
import DeliveryStatus from './DeliveryStatus.svelte';
import DevelopmentBoard from './DevelopmentBoard.svelte';
import DevelopmentRequestDetail from './DevelopmentRequestDetail.svelte';
import PreviewApprovalPanel from './PreviewApprovalPanel.svelte';
import ServiceEvidenceList from './ServiceEvidenceList.svelte';

// Export components
export {
  ApprovalActions,
  AssistanceLauncher,
  BulkActions,
  DeliveryStatus,
  DevelopmentBoard,
  DevelopmentRequestDetail,
  DevelopmentRequestForm,
  DevelopmentRequestList,
  DurationDisplay,
  PreviewApprovalPanel,
  RejectDialog,
  ServiceEvidenceList,
  TimeEntryCard,
  TimeEntryList,
  TimeSummary,
};

// Export component prop types
export type ApprovalActionsProps = ComponentProps<typeof ApprovalActions>;
export type AssistanceLauncherProps = ComponentProps<typeof AssistanceLauncher>;
export type BulkActionsProps = ComponentProps<typeof BulkActions>;
export type DeliveryStatusProps = ComponentProps<typeof DeliveryStatus>;
export type DevelopmentBoardProps = ComponentProps<typeof DevelopmentBoard>;
export type DevelopmentRequestFormProps = ComponentProps<
  typeof DevelopmentRequestForm
>;
export type DevelopmentRequestDetailProps = ComponentProps<
  typeof DevelopmentRequestDetail
>;
export type DevelopmentRequestListProps = ComponentProps<
  typeof DevelopmentRequestList
>;
export type DurationDisplayProps = ComponentProps<typeof DurationDisplay>;
export type RejectDialogProps = ComponentProps<typeof RejectDialog>;
export type PreviewApprovalPanelProps = ComponentProps<
  typeof PreviewApprovalPanel
>;
export type ServiceEvidenceListProps = ComponentProps<
  typeof ServiceEvidenceList
>;
export type TimeEntryCardProps = ComponentProps<typeof TimeEntryCard>;
export type TimeEntryListProps = ComponentProps<typeof TimeEntryList>;
export type TimeSummaryProps = ComponentProps<typeof TimeSummary>;

export * from './delivery-types.js';
// Export types and utilities
export {
  type ApprovalStatus,
  type Currency,
  formatCurrency,
  formatDate,
  formatHours,
  formatHoursHHMM,
  statusColors,
  type TimeEntry,
  type TimeEntryStatus,
} from './utils.js';

// Auto-register with ModuleUIRegistry
ModuleUIRegistry.registerModule(PROJECTS_MODULE_META);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'development-board',
  DevelopmentBoard,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'delivery-status',
  DeliveryStatus,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'preview-approval',
  PreviewApprovalPanel,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'assistance-launcher',
  AssistanceLauncher,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'service-evidence-list',
  ServiceEvidenceList,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'development-request-form',
  DevelopmentRequestForm,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'development-request-list',
  DevelopmentRequestList,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'development-request-detail',
  DevelopmentRequestDetail,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'time-entry-card',
  TimeEntryCard,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'time-entry-list',
  TimeEntryList,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'time-summary',
  TimeSummary,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'duration-display',
  DurationDisplay,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'approval-actions',
  ApprovalActions,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'bulk-actions',
  BulkActions,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-projects',
  'reject-dialog',
  RejectDialog,
);
