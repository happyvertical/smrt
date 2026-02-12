/**
 * Content Module Svelte Components
 *
 * Optional Svelte UI components for content display.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
import { CONTENT_MODULE_META } from '../ui.js';

// Import components
import ArticleCard from './components/ArticleCard.svelte';
import ArticleList from './components/ArticleList.svelte';
import Markdown from './components/Markdown.svelte';

// Export components
export { ArticleCard, ArticleList, Markdown };

// Export component prop types
export type { Props as ArticleCardProps } from './components/ArticleCard.svelte';
export type { Props as ArticleListProps } from './components/ArticleList.svelte';
export type { Props as MarkdownProps } from './components/Markdown.svelte';

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
