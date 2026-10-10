/**
 * @happyvertical/smrt-svelte/overview/server
 *
 * The Svelte-free half of the overview surface (#3727): the data model, option
 * schemas, widget registry, and the server load contract. Safe to import from
 * a `+page.server.ts` or a save endpoint.
 */
export {
  createOverviewAssistantSurface,
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
  createWidgetRegistry,
  defaultWidgetRegistry,
  registerWidget,
  resolveWidgetComponents,
  type WidgetComponents,
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
