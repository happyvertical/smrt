/**
 * The record-page widget definitions (#3718 record page): `related` and
 * `line-items`, registered per record view by `registerRecordWidgets`
 * because they are built from the record's relations. Loaders and the
 * loader contract are in `record-loaders.ts`.
 */
import { defaultWidgetRegistry, type WidgetRegistry } from '../registry.js';
import type { WidgetDefinition, WidgetLoad } from '../types.js';
import type { RelatedWidgetData } from './data.js';
import RelatedWidget from './RelatedWidget.svelte';
import {
  createRelatedLoader,
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
 * Register the record-page widgets for one record view's relations:
 * `related` (when a `records` loader is given). Returns a disposer.
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
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}
