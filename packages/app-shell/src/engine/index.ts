// The app-shell engine: runs a person's own smrt app from a definition.
export {
  type Command,
  type CommandType,
  type ExecuteOptions,
  isRiskyCommand,
  isRiskyTool,
  isStructuralCommand,
  type Plan,
  RISKY_COMMANDS,
  STRUCTURAL_COMMANDS,
  type Template,
} from './commands.ts';
export {
  LOAD_LIMITS,
  type LoadPreview,
  type LoadRecordsCommand,
} from './data-migrations.ts';
export {
  type AppDefinition,
  builtInFields,
  coerceValue,
  convertValue,
  type DescribedModel,
  describeApp,
  EMPTY_APP,
  FIELD_NAME_PATTERN,
  FIELD_TYPES,
  type FieldDef,
  type FieldType,
  FORMAT,
  isValidFieldName,
  isValidModelName,
  type MethodDef,
  type MethodParamDef,
  type Migration,
  type ModelDef,
  RECIPES,
  type Recipe,
  type RecipeModel,
  refuseChanges,
  type Step,
  snake,
  suggestFieldName,
  tableFor,
  USER_PKG,
  validate,
} from './definition.ts';
export {
  type DraftMarker,
  removeDraftDirectory as discardDraftDirectory,
} from './draft.ts';
export {
  AppError,
  ApprovalRequiredError,
  EngineError,
  type EngineErrorCode,
  WorkerCrashedError,
} from './errors.ts';
export {
  AppHost,
  type ChangeResult,
  type CleanUpResult,
  type ExecuteResult,
  type ForkDraftOptions,
  type HostOptions,
  type MethodResult,
  type PublishOptions,
  type PublishPreview,
  type PublishResult,
  type PublishStage,
  type PublishVersionPreview,
  type RestResult,
  type ToolResult,
  type VersionSummary,
} from './host.ts';
export type {
  DefinitionDiff,
  DraftChain,
  FieldChange,
  ModelDiff,
  PublishMethod,
} from './publish.ts';
export type { AppReportResult, ReportDef, ReportOptions } from './reports.ts';
export {
  checkSyntax,
  type MethodInput,
  type MethodOutput,
  runMethod,
  SANDBOX_LIMITS,
  SandboxError,
  type SandboxLimits,
  validateWrites,
  type WritableModel,
  type Write,
} from './sandbox.ts';
export {
  MemoryVersionStore,
  type VersionMigration,
  type VersionRecord,
  type VersionStore,
} from './store.ts';
