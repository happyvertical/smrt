/**
 * The core widget definitions (#3727): metric, chart, record list, shortcuts
 * and note. Data-backed widgets take their loader by structural injection, so
 * this package depends on no data package: an app wires `load` to runtime
 * reports, a collection query, or the planner's in-browser source.
 *
 * ```ts
 * registerCoreWidgets(defaultWidgetRegistry, {
 *   metric: (options, ctx) => countRecords(ctx, options),
 *   chart: (options, ctx) => runReportChart(ctx, options),
 * });
 * ```
 */

import { defaultWidgetRegistry, type WidgetRegistry } from '../registry.js';
import type {
  WidgetDefinition,
  WidgetLoad,
  WidgetOptionField,
} from '../types.js';
import ChartWidget from './ChartWidget.svelte';
import type {
  ChartWidgetData,
  MetricWidgetData,
  RecordListWidgetData,
  ShortcutsWidgetData,
} from './data.js';
import MetricWidget from './MetricWidget.svelte';
import NoteWidget from './NoteWidget.svelte';
import RecordListWidget from './RecordListWidget.svelte';
import ShortcutsWidget from './ShortcutsWidget.svelte';

const titleField: WidgetOptionField = {
  key: 'title',
  type: 'text',
  label: 'ui.overview.opt.title',
  help: 'ui.overview.opt.title_help',
  maxLength: 80,
};
const modelField: WidgetOptionField = {
  key: 'model',
  type: 'model',
  label: 'ui.overview.opt.model',
  help: 'ui.overview.opt.model_help',
  required: true,
};
const filterField: WidgetOptionField = {
  key: 'filter',
  type: 'identifier',
  label: 'ui.overview.opt.filter',
  help: 'ui.overview.opt.filter_help',
};
const fieldField: WidgetOptionField = {
  key: 'field',
  type: 'identifier',
  label: 'ui.overview.opt.field',
  help: 'ui.overview.opt.field_help',
};
const measureField = (choices: readonly string[]): WidgetOptionField => ({
  key: 'measure',
  type: 'enum',
  label: 'ui.overview.opt.measure',
  default: 'count',
  choices: choices.map((value) => ({
    value,
    label: `ui.overview.opt.measure_${value}`,
  })),
});

/** Metric: one number from a model. Options: model, measure, field, filter. */
export function createMetricWidget(
  load: WidgetLoad<MetricWidgetData>,
): WidgetDefinition<MetricWidgetData> {
  return {
    type: 'metric',
    title: 'ui.overview.widget.metric.title',
    description: 'ui.overview.widget.metric.description',
    icon: 'layers',
    options: [
      titleField,
      modelField,
      measureField(['count', 'sum', 'avg', 'min', 'max']),
      fieldField,
      filterField,
    ],
    component: MetricWidget,
    load,
  };
}

/** Chart: values grouped by a field over a period. */
export function createChartWidget(
  load: WidgetLoad<ChartWidgetData>,
): WidgetDefinition<ChartWidgetData> {
  return {
    type: 'chart',
    title: 'ui.overview.widget.chart.title',
    description: 'ui.overview.widget.chart.description',
    icon: 'repeat',
    options: [
      titleField,
      modelField,
      {
        key: 'groupBy',
        type: 'identifier',
        label: 'ui.overview.opt.group_by',
      },
      measureField(['count', 'sum', 'avg']),
      fieldField,
      {
        key: 'period',
        type: 'enum',
        label: 'ui.overview.opt.period',
        default: '30d',
        choices: ['7d', '30d', '90d', '12m', 'all'].map((value) => ({
          value,
          label: `ui.overview.opt.period_${value}`,
        })),
      },
      {
        key: 'style',
        type: 'enum',
        label: 'ui.overview.opt.style',
        default: 'bar',
        choices: [
          { value: 'bar', label: 'ui.overview.opt.style_bar' },
          { value: 'line', label: 'ui.overview.opt.style_line' },
        ],
      },
      filterField,
    ],
    component: ChartWidget,
    load,
    defaultSpan: 2,
  };
}

/** Record list: the latest or top records of a model. */
export function createRecordListWidget(
  load: WidgetLoad<RecordListWidgetData>,
): WidgetDefinition<RecordListWidgetData> {
  return {
    type: 'records',
    title: 'ui.overview.widget.records.title',
    description: 'ui.overview.widget.records.description',
    icon: 'fileText',
    options: [
      titleField,
      modelField,
      { key: 'sort', type: 'identifier', label: 'ui.overview.opt.sort' },
      {
        key: 'direction',
        type: 'enum',
        label: 'ui.overview.opt.direction',
        default: 'desc',
        choices: [
          { value: 'desc', label: 'ui.overview.opt.direction_desc' },
          { value: 'asc', label: 'ui.overview.opt.direction_asc' },
        ],
      },
      {
        key: 'limit',
        type: 'integer',
        label: 'ui.overview.opt.limit',
        default: 5,
        min: 1,
        max: 20,
      },
      filterField,
    ],
    component: RecordListWidget,
    load,
    defaultSpan: 2,
  };
}

/**
 * Shortcuts: the section-overview cards. The default widget of a section
 * overview; its loader typically wraps `shortcutsFromNav`.
 */
export function createShortcutsWidget(
  load: WidgetLoad<ShortcutsWidgetData>,
): WidgetDefinition<ShortcutsWidgetData> {
  return {
    type: 'shortcuts',
    title: 'ui.overview.widget.shortcuts.title',
    description: 'ui.overview.widget.shortcuts.description',
    icon: 'home',
    options: [
      titleField,
      {
        key: 'section',
        type: 'identifier',
        label: 'ui.overview.opt.section',
        help: 'ui.overview.opt.section_help',
      },
    ],
    component: ShortcutsWidget,
    load,
    defaultSpan: 4,
  };
}

/** Note: sanitized Markdown text. Needs no loader. */
export function createNoteWidget(): WidgetDefinition {
  return {
    type: 'note',
    title: 'ui.overview.widget.note.title',
    description: 'ui.overview.widget.note.description',
    icon: 'fileText',
    options: [
      titleField,
      {
        key: 'body',
        type: 'markdown',
        label: 'ui.overview.opt.body',
        help: 'ui.overview.opt.body_help',
        default: '',
        maxLength: 4000,
      },
    ],
    component: NoteWidget,
    defaultSpan: 2,
  };
}

/** The loaders an app supplies; a widget without one is not registered. */
export interface CoreWidgetLoaders {
  metric?: WidgetLoad<MetricWidgetData>;
  chart?: WidgetLoad<ChartWidgetData>;
  records?: WidgetLoad<RecordListWidgetData>;
  shortcuts?: WidgetLoad<ShortcutsWidgetData>;
}

/**
 * Register the core widgets on `registry`: `note` always, each data-backed
 * widget only when its loader is given. Returns a disposer for all of them.
 */
export function registerCoreWidgets(
  registry: WidgetRegistry = defaultWidgetRegistry,
  loaders: CoreWidgetLoaders = {},
  options: { replace?: boolean } = {},
): () => void {
  const disposers = [registry.register(createNoteWidget(), options)];
  if (loaders.metric) {
    disposers.push(
      registry.register(createMetricWidget(loaders.metric), options),
    );
  }
  if (loaders.chart) {
    disposers.push(
      registry.register(createChartWidget(loaders.chart), options),
    );
  }
  if (loaders.records) {
    disposers.push(
      registry.register(createRecordListWidget(loaders.records), options),
    );
  }
  if (loaders.shortcuts) {
    disposers.push(
      registry.register(createShortcutsWidget(loaders.shortcuts), options),
    );
  }
  return () => {
    for (const dispose of disposers) dispose();
  };
}
