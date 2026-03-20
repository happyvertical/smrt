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
import ContentTransparencyReport from './components/ContentTransparencyReport.svelte';
import FactualContentEditor from './components/FactualContentEditor.svelte';
import FactualContentWorkflow from './components/FactualContentWorkflow.svelte';
import Markdown from './components/Markdown.svelte';

// Export components
export {
  ArticleCard,
  ArticleList,
  ContentTransparencyReport,
  FactualContentEditor,
  FactualContentWorkflow,
  Markdown,
};

// Export component prop types
export type ArticleCardProps = ComponentProps<typeof ArticleCard>;
export type ArticleListProps = ComponentProps<typeof ArticleList>;
export type ContentTransparencyReportProps = ComponentProps<
  typeof ContentTransparencyReport
>;
export type FactualContentEditorProps = ComponentProps<
  typeof FactualContentEditor
>;
export type FactualContentWorkflowProps = ComponentProps<
  typeof FactualContentWorkflow
>;
export type MarkdownProps = ComponentProps<typeof Markdown>;

// Export types
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
ModuleUIRegistry.register('@happyvertical/smrt-content', 'markdown', Markdown);
