/**
 * @happyvertical/smrt-svelte/overview
 *
 * Customizable overview surfaces (#3727): a flow grid of registered widgets
 * with versioned option schemas, edited in place with the shell's layout
 * editor. The Svelte-free model, registry and server load contract are also
 * published on `@happyvertical/smrt-svelte/overview/server`.
 */
export {
  createOverview,
  OverviewController,
  type OverviewControllerOptions,
  type OverviewOpResult,
  type OverviewWidgetEntry,
} from './controller.svelte.js';
export {
  type FormatWidgetValueOptions,
  formatWidgetValue,
  type WidgetValueFormat,
} from './format.js';
export type {
  OverviewFormIssue,
  OverviewGridProps,
  OverviewModelChoice,
  WidgetOptionsFormProps,
} from './grid-types.js';
export {
  type BlockNode,
  type InlineNode,
  parseMarkdown,
  safeHref,
} from './markdown.js';
export { default as OverviewGrid } from './OverviewGrid.svelte';
export { spanFromKey, spanFromPointer } from './resize.js';
export * from './server.js';
export { default as WidgetOptionsForm } from './WidgetOptionsForm.svelte';
export { default as ChartWidget } from './widgets/ChartWidget.svelte';
export {
  type CoreWidgetLoaders,
  createChartWidget,
  createMetricWidget,
  createNoteWidget,
  createRecordListWidget,
  createShortcutsWidget,
  registerCoreWidgets,
} from './widgets/core.js';
export {
  type ChartWidgetData,
  type MetricWidgetData,
  type RecordListWidgetData,
  type ShortcutNavSection,
  type ShortcutsWidgetData,
  shortcutsFromNav,
} from './widgets/data.js';
export { default as MetricWidget } from './widgets/MetricWidget.svelte';
export { default as NoteWidget } from './widgets/NoteWidget.svelte';
export { default as RecordListWidget } from './widgets/RecordListWidget.svelte';
export { default as ShortcutsWidget } from './widgets/ShortcutsWidget.svelte';
