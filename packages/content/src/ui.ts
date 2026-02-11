/**
 * Content Module UI Slot Declarations
 *
 * This file defines the UI extension points for the content module.
 * UI components are implemented in the ./svelte subpath.
 */

import type { ModuleUISlot, SmrtModuleMeta } from '@happyvertical/smrt-types';

/**
 * Content module UI slots
 */
export const CONTENT_UI_SLOTS: Record<string, ModuleUISlot> = {
  'article-card': {
    id: 'article-card',
    label: 'Article Card',
    description: 'Article preview card with title, excerpt, and metadata',
    icon: 'file-text',
    category: 'display',
    order: 1,
    propsInterface: 'ArticleCardProps',
  },
  'article-list': {
    id: 'article-list',
    label: 'Article List',
    description: 'Grid or list of article cards',
    icon: 'list',
    category: 'list',
    order: 2,
    propsInterface: 'ArticleListProps',
  },
  markdown: {
    id: 'markdown',
    label: 'Markdown',
    description: 'Markdown content renderer with syntax highlighting',
    icon: 'code',
    category: 'display',
    order: 3,
    propsInterface: 'MarkdownProps',
  },
};

/**
 * Content module metadata
 */
export const CONTENT_MODULE_META: SmrtModuleMeta = {
  name: '@happyvertical/smrt-content',
  displayName: 'Content',
  description: 'Content processing: documents, web content, and media',
  uiSlots: CONTENT_UI_SLOTS,
  models: ['Content', 'Article', 'Document'],
  collections: ['ContentCollection', 'ArticleCollection', 'DocumentCollection'],
};
