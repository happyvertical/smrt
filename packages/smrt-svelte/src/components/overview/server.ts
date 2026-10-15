/**
 * @happyvertical/smrt-svelte/overview/server
 *
 * The Svelte-free half of the overview surface (#3727): the data model, option
 * schemas, widget registry, and the server load contract. Safe to import from
 * a `+page.server.ts` or a save endpoint.
 */
export {
  createOverviewAssistantSurface,
  type OverviewAssistantPersistResult,
  type OverviewAssistantSurface,
  type OverviewAssistantSurfaceOptions,
} from './assistant-surface.js';
export {
  type LoadOverviewOptions,
  loadOverview,
  type WidgetLoadInput,
} from './load.js';
export {
  applyOverviewOverride,
  checkOverviewOverride,
  defineOverview,
  diffOverview,
  isEmptyOverride,
  nextWidgetId,
  type OverviewOverrideCheck,
  parseOverviewDocument,
  parseOverviewOverride,
  type ResolvedOverview,
  resolveOverview,
  type SanitizeOptions,
  sanitizeOverview,
} from './model.js';
export {
  allowedWidgetTypes,
  type DescribeOverviewInput,
  describeOverview,
  OVERVIEW_MAX_OPERATIONS,
  OVERVIEW_OPERATION_KINDS,
  OVERVIEW_OPERATION_SCHEMA,
  type OverviewAddOperation,
  type OverviewConfigureOperation,
  type OverviewDescription,
  type OverviewMoveOperation,
  type OverviewOperation,
  type OverviewOperationIssue,
  type OverviewOperationIssueCode,
  type OverviewOperationKind,
  type OverviewOperationResult,
  type OverviewOptionDescription,
  type OverviewPlan,
  type OverviewRemoveOperation,
  type OverviewResizeOperation,
  type OverviewWidgetTypeDescription,
  type PlanOverviewOperationsInput,
  planOverviewOperations,
} from './operations.js';
export {
  parseRecipeExportRef,
  type RecipeExportResolver,
  type RecipeWidgetRegistration,
  type RecipeWidgetSkip,
  type RecipeWidgetSkipReason,
  type RecipeWidgetSource,
  type RegisterRecipeWidgetsOptions,
  registerRecipeWidgets,
} from './recipe-widgets.js';
export {
  RECORD_OVERVIEW_ALLOWED,
  RECORD_OVERVIEW_LIMIT,
  RECORD_OVERVIEW_MAX_METRICS,
  RECORD_OVERVIEW_PANEL_SPAN,
  type RecordOverviewOptions,
  recordOverview,
  recordOverviewId,
} from './record.js';
export {
  createWidgetRegistry,
  defaultWidgetRegistry,
  registerWidget,
  resolveWidgetComponents,
  resolveWidgetOptionsEditors,
  type WidgetComponents,
  type WidgetOptionsEditors,
  WidgetRegistry,
} from './registry.js';
export {
  assertWidgetOptionFields,
  defaultWidgetOptions,
  IDENTIFIER_PATTERN,
  MODEL_PATTERN,
  optionsEqual,
  validateWidgetOptions,
} from './schema.js';
export * from './types.js';
export {
  type LineItemsTotals,
  type LineTotalKey,
  type LineTotalLine,
  type LineTotalsMismatch,
  type LineTotalsResult,
  lineItemTotals,
  sumLineAmounts,
} from './widgets/line-totals.js';
export {
  createLineItemsLoader,
  createRelatedLoader,
  LINE_ITEMS_LIMIT,
  lineItemsOptions,
  lineItemsRelation,
  RELATED_WIDGET_LIMIT,
  RELATED_WIDGET_MAX_TABS,
  type RecordWidgetsOptions,
  relatedRelations,
  relatedTabOptions,
} from './widgets/record-loaders.js';
export {
  DEFAULT_STATUS_TONES,
  formatColumnsOption,
  formatRecordCell,
  lineItemColumns,
  parseColumnsOption,
  RECORD_TABLE_MAX_COLUMNS,
  RECORD_TABLE_MAX_ROWS,
  type RecordCellContext,
  relatedColumns,
  statusLabel,
  statusTone,
} from './widgets/record-table.js';
