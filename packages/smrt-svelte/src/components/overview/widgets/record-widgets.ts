/**
 * The record-page widget definitions (#3718 record page): `related` and
 * `line-items` (the contract's `lineItems`), registered per record view by `registerRecordWidgets`
 * because they are built from the record's relations. Loaders and the
 * loader contract are in `record-loaders.ts`.
 */
import { defaultWidgetRegistry, type WidgetRegistry } from '../registry.js';
import type { WidgetDefinition, WidgetLoad } from '../types.js';
import type { LineItemsWidgetData, RelatedWidgetData } from './data.js';
import LineItemsWidget from './LineItemsWidget.svelte';
import RelatedWidget from './RelatedWidget.svelte';
import {
  createLineItemsLoader,
  createRelatedLoader,
  LINE_ITEMS_LIMIT,
  RELATED_WIDGET_LIMIT,
  type RecordWidgetsOptions,
} from './record-loaders.js';

/** `related`: tabbed related records. Options: `title`, `relations`, `limit`. */
export function createRelatedWidget(
  load: WidgetLoad<RelatedWidgetData>,
): WidgetDefinition<RelatedWidgetData> {
  return {
    type: 'related',
    title: 'ui.overview.widget.related.title',
    description: 'ui.overview.widget.related.description',
    icon: 'layers',
    options: [
      {
        key: 'title',
        type: 'text',
        label: 'ui.overview.opt.title',
        help: 'ui.overview.opt.title_help',
        maxLength: 80,
      },
      {
        key: 'relations',
        type: 'text',
        label: 'ui.overview.opt.relations',
        help: 'ui.overview.opt.relations_help',
        maxLength: 1000,
      },
      {
        key: 'limit',
        type: 'integer',
        label: 'ui.overview.opt.limit',
        default: RELATED_WIDGET_LIMIT,
        min: 1,
        max: 20,
      },
    ],
    component: RelatedWidget,
    load,
    defaultSpan: 4,
  };
}

/**
 * `line-items`: a document's lines and totals block. Options: `title`,
 * `relation` (an `items` relation key; empty = the first), `limit`. The
 * type id is kebab case (`line-items`): widget type ids are lowercase kebab.
 */
export function createLineItemsWidget(
  load: WidgetLoad<LineItemsWidgetData>,
): WidgetDefinition<LineItemsWidgetData> {
  return {
    type: 'line-items',
    title: 'ui.overview.widget.line_items.title',
    description: 'ui.overview.widget.line_items.description',
    icon: 'fileText',
    options: [
      {
        key: 'title',
        type: 'text',
        label: 'ui.overview.opt.title',
        help: 'ui.overview.opt.title_help',
        maxLength: 80,
      },
      {
        key: 'relation',
        type: 'identifier',
        label: 'ui.overview.opt.relation',
        help: 'ui.overview.opt.relation_help',
      },
      {
        key: 'limit',
        type: 'integer',
        label: 'ui.overview.opt.limit',
        default: LINE_ITEMS_LIMIT,
        min: 1,
        max: LINE_ITEMS_LIMIT,
      },
    ],
    component: LineItemsWidget,
    load,
    defaultSpan: 4,
  };
}

/**
 * Register the record-page widgets for one record view's relations,
 * `related` and `line-items`, both loading through the host's `records`
 * loader. Returns a disposer.
 */
export function registerRecordWidgets(
  registry: WidgetRegistry = defaultWidgetRegistry,
  options: RecordWidgetsOptions,
  registerOptions: { replace?: boolean } = {},
): () => void {
  const disposers = [
    registry.register(
      createRelatedWidget(createRelatedLoader(options)),
      registerOptions,
    ),
    registry.register(
      createLineItemsWidget(createLineItemsLoader(options)),
      registerOptions,
    ),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
