/**
 * Content Module Svelte Components
 *
 * Optional Svelte UI components for content display.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
import type { ComponentProps } from 'svelte';
import { CONTENT_MODULE_META } from '../ui.js';

// Import components
import ArticleCard from './components/ArticleCard.svelte';
import ArticleList from './components/ArticleList.svelte';
import ContentAgentChat from './components/ContentAgentChat.svelte';
import ContentBodyEditor from './components/ContentBodyEditor.svelte';
import ContentBodyRenderer from './components/ContentBodyRenderer.svelte';
import ContentContributionForm from './components/ContentContributionForm.svelte';
import ContentContributionInbox from './components/ContentContributionInbox.svelte';
import ContentContributionPortal from './components/ContentContributionPortal.svelte';
import ContentContributionTypeManager from './components/ContentContributionTypeManager.svelte';
import ContentContributorManager from './components/ContentContributorManager.svelte';
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
import ContentStatusFields from './components/ContentStatusFields.svelte';
import ContentTransparencyReport from './components/ContentTransparencyReport.svelte';
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
  ContentAgentChat,
  ContentBodyEditor,
  ContentBodyRenderer,
  ContentContributionForm,
  ContentContributionInbox,
  ContentContributionPortal,
  ContentContributionTypeManager,
  ContentContributorManager,
  ContentEditor,
  ContentGovernanceAssignmentEditor,
  ContentGovernanceManager,
  ContentGovernancePanel,
  ContentGovernancePolicyEditor,
  ContentGovernanceProfileEditor,
  ContentGovernanceTool,
  ContentImageBrowser,
  ContentImageChooser,
  ContentList,
  ContentMetadataFields,
  ContentReferencesPanel,
  ContentStatusFields,
  ContentTransparencyReport,
  ContentContributionsRoute,
  ContentFactsRoute,
  ContentGovernanceRoute,
  ContentWorkspaceRoute,
  GovernedContentEditor,
  Markdown,
  PublishedArticleRoute,
  buildPublishedArticlePath,
  CONTENT_DEFAULT_ROUTE_NAVIGATION,
  CONTENT_ROUTE_IDS,
  CONTENT_ROUTE_META,
  createContentRouteNavigation,
  getContentRouteDefaultPath,
  getContentRouteHref,
};

// Export component prop types
export type ArticleCardProps = ComponentProps<typeof ArticleCard>;
export type ArticleListProps = ComponentProps<typeof ArticleList>;
export type ContentAgentChatProps = ComponentProps<typeof ContentAgentChat>;
export type ContentBodyEditorProps = ComponentProps<typeof ContentBodyEditor>;
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
export type ContentMetadataFieldsProps = ComponentProps<
  typeof ContentMetadataFields
>;
export type ContentReferencesPanelProps = ComponentProps<
  typeof ContentReferencesPanel
>;
export type ContentStatusFieldsProps = ComponentProps<
  typeof ContentStatusFields
>;
export type ContentListProps = ComponentProps<typeof ContentList>;
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
