/**
 * Content Module Svelte Components
 *
 * Optional Svelte UI components for content display.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import type { ComponentProps } from 'svelte';
import { CONTENT_MODULE_META } from '../ui.js';

// Import components
import ArticleCard from './components/ArticleCard.svelte';
import ArticleList from './components/ArticleList.svelte';
import ContentAgentChat from './components/ContentAgentChat.svelte';
import ContentBodyEditor from './components/ContentBodyEditor.svelte';
import ContentBodyRenderer from './components/ContentBodyRenderer.svelte';
import ContentClaimAuditTool from './components/ContentClaimAuditTool.svelte';
import ContentContributionForm from './components/ContentContributionForm.svelte';
import ContentContributionInbox from './components/ContentContributionInbox.svelte';
import ContentContributionPortal from './components/ContentContributionPortal.svelte';
import ContentContributionTypeManager from './components/ContentContributionTypeManager.svelte';
import ContentContributorManager from './components/ContentContributorManager.svelte';
import ContentCorrectionsTool from './components/ContentCorrectionsTool.svelte';
import ContentEditor from './components/ContentEditor.svelte';
import ContentGovernanceAssignmentEditor from './components/ContentGovernanceAssignmentEditor.svelte';
import ContentGovernanceManager from './components/ContentGovernanceManager.svelte';
import ContentGovernancePanel from './components/ContentGovernancePanel.svelte';
import ContentGovernancePolicyEditor from './components/ContentGovernancePolicyEditor.svelte';
import ContentGovernanceProfileEditor from './components/ContentGovernanceProfileEditor.svelte';
import ContentGovernanceTool from './components/ContentGovernanceTool.svelte';
import ContentImageBrowser from './components/ContentImageBrowser.svelte';
import ContentImageChooser from './components/ContentImageChooser.svelte';
import ContentList from './components/ContentList.svelte';
import ContentMetadataFields from './components/ContentMetadataFields.svelte';
import ContentReferencesPanel from './components/ContentReferencesPanel.svelte';
import ContentReviewStatusTray from './components/ContentReviewStatusTray.svelte';
import ContentStatusFields from './components/ContentStatusFields.svelte';
import ContentTitleField from './components/ContentTitleField.svelte';
import ContentTransparencyReport from './components/ContentTransparencyReport.svelte';
import ContentTransparencyTool from './components/ContentTransparencyTool.svelte';
import ContentVersionsTool from './components/ContentVersionsTool.svelte';
import GovernedContentEditor from './components/GovernedContentEditor.svelte';
import Markdown from './components/Markdown.svelte';
import ContentContributionsRoute from './routes/ContentContributionsRoute.svelte';
import ContentFactsRoute from './routes/ContentFactsRoute.svelte';
import ContentGovernanceRoute from './routes/ContentGovernanceRoute.svelte';
import ContentWorkspaceRoute from './routes/ContentWorkspaceRoute.svelte';
import PublishedArticleRoute from './routes/PublishedArticleRoute.svelte';
import {
  buildPublishedArticlePath,
  CONTENT_DEFAULT_ROUTE_NAVIGATION,
  CONTENT_ROUTE_IDS,
  CONTENT_ROUTE_META,
  createContentRouteNavigation,
  getContentRouteDefaultPath,
  getContentRouteHref,
} from './routes/shared.js';

// Export components
export {
  ArticleCard,
  ArticleList,
  buildPublishedArticlePath,
  CONTENT_DEFAULT_ROUTE_NAVIGATION,
  CONTENT_ROUTE_IDS,
  CONTENT_ROUTE_META,
  ContentAgentChat,
  ContentBodyEditor,
  ContentBodyRenderer,
  ContentClaimAuditTool,
  ContentContributionForm,
  ContentContributionInbox,
  ContentContributionPortal,
  ContentContributionsRoute,
  ContentContributionTypeManager,
  ContentContributorManager,
  ContentCorrectionsTool,
  ContentEditor,
  ContentFactsRoute,
  ContentGovernanceAssignmentEditor,
  ContentGovernanceManager,
  ContentGovernancePanel,
  ContentGovernancePolicyEditor,
  ContentGovernanceProfileEditor,
  ContentGovernanceRoute,
  ContentGovernanceTool,
  ContentImageBrowser,
  ContentImageChooser,
  ContentList,
  ContentMetadataFields,
  ContentReferencesPanel,
  ContentReviewStatusTray,
  ContentStatusFields,
  ContentTitleField,
  ContentTransparencyReport,
  ContentTransparencyTool,
  ContentVersionsTool,
  ContentWorkspaceRoute,
  createContentRouteNavigation,
  GovernedContentEditor,
  getContentRouteDefaultPath,
  getContentRouteHref,
  Markdown,
  PublishedArticleRoute,
};

// Export component prop types
export type ArticleCardProps = ComponentProps<typeof ArticleCard>;
export type ArticleListProps = ComponentProps<typeof ArticleList>;
export type ContentAgentChatProps = ComponentProps<typeof ContentAgentChat>;
export type ContentBodyEditorProps = ComponentProps<typeof ContentBodyEditor>;
export type { ContentBodyEditorChange } from './components/ContentBodyEditor.svelte';
export type ContentBodyRendererProps = ComponentProps<
  typeof ContentBodyRenderer
>;
export type ContentEditorProps = ComponentProps<typeof ContentEditor>;
export type ContentImageChooserProps = ComponentProps<
  typeof ContentImageChooser
>;
export type ContentImageBrowserProps = ComponentProps<
  typeof ContentImageBrowser
>;
export type ContentClaimAuditToolProps = ComponentProps<
  typeof ContentClaimAuditTool
>;
export type ContentCorrectionsToolProps = ComponentProps<
  typeof ContentCorrectionsTool
>;
export type ContentTransparencyToolProps = ComponentProps<
  typeof ContentTransparencyTool
>;
export type ContentVersionsToolProps = ComponentProps<
  typeof ContentVersionsTool
>;
export type ContentMetadataFieldsProps = ComponentProps<
  typeof ContentMetadataFields
>;
export type ContentReferencesPanelProps = ComponentProps<
  typeof ContentReferencesPanel
>;
export type ContentReviewStatusTrayProps = ComponentProps<
  typeof ContentReviewStatusTray
>;
export type {
  ContentReviewStatusIcon,
  ContentReviewStatusTone,
  ContentReviewStatusTrayItem,
} from './components/ContentReviewStatusTray.svelte';
export type ContentStatusFieldsProps = ComponentProps<
  typeof ContentStatusFields
>;
export type ContentTitleFieldProps = ComponentProps<typeof ContentTitleField>;
export type ContentListProps = ComponentProps<typeof ContentList>;
export type { ContentListUrlStateBinding } from './components/ContentList.svelte';
// Shared content-list adapter: columns, rows, filters, and the data surface
// descriptor every ContentList presentation is built from.
export {
  applyContentListFilter,
  buildContentListColumns,
  buildContentListSurfaceDescriptor,
  CONTENT_LIST_ACTIONS_COLUMN_ID,
  CONTENT_LIST_COLUMN_IDS,
  CONTENT_LIST_HIDDEN_COLUMN_IDS,
  CONTENT_LIST_ROW_KEY,
  CONTENT_LIST_SCHEMA_VERSION,
  CONTENT_LIST_SELECTION_COLUMN_ID,
  CONTENT_LIST_STATUS_FILTER_ID,
  CONTENT_LIST_STATUS_OPTIONS,
  CONTENT_LIST_SURFACE_ID,
  CONTENT_LIST_TABLE_COLUMN_IDS,
  CONTENT_LIST_TOKEN_COLUMN_IDS,
  CONTENT_LIST_TYPE_FILTER_ID,
  CONTENT_LIST_TYPE_OPTIONS,
  CONTENT_LIST_UNREPRESENTABLE_OPTION,
  CONTENT_LIST_VISIBLE_COLUMN_IDS,
  type ContentListActionId,
  type ContentListActionOptions,
  type ContentListColumnId,
  type ContentListColumnLabels,
  type ContentListControllerOptions,
  type ContentListDataSurface,
  type ContentListRow,
  type ContentListSelectFilterState,
  type ContentListSurfaceDescriptorOptions,
  type ContentListViewMode,
  contentListFilters,
  contentListRowActions,
  contentStateVariant,
  contentStatusVariant,
  contentTypeLabel,
  createContentListController,
  formatContentListDate,
  isContentListFilterExactly,
  normalizeContentListTypeLock,
  normalizeContentToken,
  normalizeContentType,
  paginateContentListRows,
  readContentListFilter,
  readContentListSelectFilter,
  resolveContentHref,
  resolveSelectedContentListRows,
  resolveSelectedContents,
  selectableContentListRowIds,
  selectContentListRows,
  toContentListRows,
} from './content-list-controller.js';
// Server-backed ContentList queries (#2452): view state → DataQueryRequest,
// the `POST /api/v1/contents/query` transport, and the binding seam.
export {
  CONTENT_LIST_QUERY_DEFAULT_PAGE_SIZE,
  CONTENT_LIST_QUERY_DEFAULT_SORT,
  CONTENT_LIST_QUERY_FIELDS,
  CONTENT_LIST_QUERY_IDENTITY_FIELD,
  CONTENT_LIST_QUERY_MAX_FIELD_ID_LENGTH,
  CONTENT_LIST_QUERY_MAX_FILTER_NODES,
  CONTENT_LIST_QUERY_MAX_IN_VALUES,
  CONTENT_LIST_QUERY_MAX_OFFSET,
  CONTENT_LIST_QUERY_MAX_OR_BRANCHES,
  CONTENT_LIST_QUERY_MAX_PROJECTION_FIELDS,
  CONTENT_LIST_QUERY_MAX_REQUEST_BYTES,
  CONTENT_LIST_QUERY_MAX_REQUEST_ID_LENGTH,
  CONTENT_LIST_QUERY_MAX_VALUE_LENGTH,
  CONTENT_LIST_QUERY_PROJECTABLE_FIELDS,
  CONTENT_LIST_QUERY_PROJECTION,
  CONTENT_LIST_QUERY_SEARCH_FIELDS,
  type ContentListDataQueryRequest,
  type ContentListDataQueryResult,
  type ContentListQueryBinding,
  type ContentListQueryDrop,
  type ContentListQueryDropReason,
  ContentListQueryError,
  type ContentListQueryField,
  type ContentListQueryFieldType,
  type ContentListQueryFilter,
  type ContentListQueryFilterOperator,
  type ContentListQueryNotices,
  type ContentListQueryRequestOptions,
  type ContentListQueryScalar,
  type ContentListQuerySource,
  type ContentListQueryTotal,
  type ContentListQueryTranslation,
  type ContentListQueryTransport,
  type ContentListQueryTransportOptions,
  contentFromContentListQueryRow,
  contentListQueryErrorMessage,
  contentListQueryExactTotal,
  contentListQueryRequestKey,
  contentListQueryRowsToContents,
  contentListQueryTotalValue,
  contentListViewStateToDataQueryRequest,
  createContentListQueryTransport,
  escapeContentListQueryLikeValue,
  readContentListQueryNotices,
  resolveContentListMaxPageSize,
} from './content-list-query.js';
export {
  type ContentListJob,
  type ContentListJobBinding,
  type ContentListJobController,
  type ContentListJobControllerOptions,
  type ContentListJobSnapshot,
  type ContentListJobStatus,
  type ContentListJobSubmission,
  type ContentListJobTarget,
  contentListJobAffectsQuery,
  createContentListJobController,
} from './content-list-runtime.js';
// Saved views (#2452): a named, restorable view backed by a narrow store seam.
export {
  CONTENT_LIST_SAVED_VIEW_SCHEMA_VERSION,
  CONTENT_LIST_SAVED_VIEW_STORAGE_PREFIX,
  type ContentListLocalSavedViewStore,
  type ContentListSavedView,
  type ContentListSavedViewInput,
  type ContentListSavedViewRestoration,
  type ContentListSavedViewStorage,
  type ContentListSavedViewStore,
  type ContentListSavedViewStoreOptions,
  createContentListMemorySavedViewStore,
  createContentListSavedViewStore,
  type RawContentListViewSnapshot,
  restoreContentListSavedView,
  toContentListSavedViewInput,
} from './content-list-saved-views.js';
// Shareable URL state (#2452): the validator both restore paths share.
export {
  applyContentListViewState,
  CONTENT_LIST_FILTER_OPERATORS,
  CONTENT_LIST_MAX_PAGE_SIZE,
  CONTENT_LIST_PAGE_PARAM,
  CONTENT_LIST_PAGE_SIZE_PARAM,
  CONTENT_LIST_QUERYABLE_COLUMN_IDS,
  CONTENT_LIST_RESERVED_PARAMS,
  CONTENT_LIST_SEARCH_PARAM,
  CONTENT_LIST_SORT_PARAM,
  type ContentListStateDrop,
  type ContentListStateDropReason,
  type ContentListStateDropScope,
  type ContentListStateValidationOptions,
  type ContentListUrlStateOptions,
  type ContentListUrlStateReading,
  type ContentListViewStateSanitization,
  contentListViewStateFromSearchParams,
  contentListViewStateToSearchParams,
  mergeContentListViewStateIntoSearchParams,
  readContentListViewStateFromSearchParams,
  sanitizeContentListViewState,
} from './content-list-url-state.js';
// Browser-safe ContentList bulk workflow binding and transport (#2453).
export {
  CONTENT_LIST_WORKFLOW_IDS,
  CONTENT_LIST_WORKFLOW_OPTIONS,
  type ContentListWorkflowBinding,
  type ContentListWorkflowClient,
  ContentListWorkflowError,
  type ContentListWorkflowId,
  type ContentListWorkflowOption,
  type ContentListWorkflowRequest,
  type ContentListWorkflowTransportOptions,
  contentListWorkflowOutcomes,
  createContentListWorkflowTransport,
} from './content-list-workflows.js';
export type ContentContributionFormProps = ComponentProps<
  typeof ContentContributionForm
>;
export type ContentContributionInboxProps = ComponentProps<
  typeof ContentContributionInbox
>;
export type ContentContributionPortalProps = ComponentProps<
  typeof ContentContributionPortal
>;
export type ContentContributionTypeManagerProps = ComponentProps<
  typeof ContentContributionTypeManager
>;
export type ContentContributorManagerProps = ComponentProps<
  typeof ContentContributorManager
>;
export type ContentTransparencyReportProps = ComponentProps<
  typeof ContentTransparencyReport
>;
export type ContentGovernanceAssignmentEditorProps = ComponentProps<
  typeof ContentGovernanceAssignmentEditor
>;
export type ContentGovernanceManagerProps = ComponentProps<
  typeof ContentGovernanceManager
>;
export type ContentGovernancePanelProps = ComponentProps<
  typeof ContentGovernancePanel
>;
export type ContentGovernanceToolProps = ComponentProps<
  typeof ContentGovernanceTool
>;
export type ContentGovernancePolicyEditorProps = ComponentProps<
  typeof ContentGovernancePolicyEditor
>;
export type ContentGovernanceProfileEditorProps = ComponentProps<
  typeof ContentGovernanceProfileEditor
>;
export type GovernedContentEditorProps = ComponentProps<
  typeof GovernedContentEditor
>;
export type MarkdownProps = ComponentProps<typeof Markdown>;
export type ContentContributionsRouteProps = ComponentProps<
  typeof ContentContributionsRoute
>;
export type ContentFactsRouteProps = ComponentProps<typeof ContentFactsRoute>;
export type ContentGovernanceRouteProps = ComponentProps<
  typeof ContentGovernanceRoute
>;
export type ContentWorkspaceRouteProps = ComponentProps<
  typeof ContentWorkspaceRoute
>;
export type PublishedArticleRouteProps = ComponentProps<
  typeof PublishedArticleRoute
>;

export type { ContentBodyFormat, ContentBodyImage } from '../body-format.js';
export {
  extractBodyImages,
  resolveBodyFormat,
} from '../body-format.js';
// Export types
export type {
  ContentEditorAssistantActions,
  ContentEditorAssistantChatProps,
  ContentEditorAssistantContext,
  ContentEditorAssistantContextChange,
  ContentEditorAssistantContextData,
  ContentEditorAssistantEditorKind,
  ContentEditorAssistantFactSummary,
  ContentEditorAssistantFields,
  ContentEditorAssistantFieldUpdateAllowList,
  ContentEditorAssistantGovernanceSummary,
  ContentEditorAssistantRegistration,
  CreateContentEditorAssistantContextInput,
} from '../content-editor-assistant.js';
export {
  contentEditorAssistantContextToChatProps,
  createContentEditorAssistantContext,
  sanitizeContentEditorAssistantFieldUpdates,
} from '../content-editor-assistant.js';
export type {
  ContentPublishReadinessState,
  EvaluateContentPublishReadinessOptions,
  PublishReadinessProfile,
  PublishReadinessRequirement,
} from '../publish-readiness.js';
export { evaluateContentPublishReadiness } from '../publish-readiness.js';
export type {
  ContentEditorAsset,
  ContentEditorFormData,
  ContentEditorInitialContent,
  ContentEditorReference,
  ContentEditorSavePayload,
} from './content-editor-form.js';
export {
  formatDateTimeLocal,
  getContentEditorInitialFormData,
  getContentEditorSavePayload,
  getContentEditorSnapshot,
  normalizePublishDate,
} from './content-editor-form.js';
export {
  createContentEditorImageRecord,
  getContentEditorAssetImageSource,
  readContentEditorFileAsDataUrl,
  resolveContentEditorImageSelection,
} from './content-editor-media.js';
export type {
  ContentEditorFieldChange,
  CreateContentEditorStateOptions,
} from './content-editor-state.svelte.js';
export {
  ContentEditorState,
  createContentEditorState,
} from './content-editor-state.svelte.js';
export type {
  ContentRouteId,
  ContentRouteKey,
  ContentRouteNavigationItem,
  LoadPublishedArticleRouteInput,
  PublishedContentArticleRouteData,
} from './routes/shared.js';
export type {
  Article,
  ArticleCardProps as ArticleCardPropsLegacy,
  ArticleListProps as ArticleListPropsLegacy,
  MarkdownProps as MarkdownPropsLegacy,
} from './types.js';

// Auto-register with ModuleUIRegistry
ModuleUIRegistry.registerModule(CONTENT_MODULE_META);
ModuleUIRegistry.register(
  '@happyvertical/smrt-content',
  'article-card',
  ArticleCard,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-content',
  'article-list',
  ArticleList,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-content',
  'content-list',
  ContentList,
);
ModuleUIRegistry.register('@happyvertical/smrt-content', 'markdown', Markdown);
