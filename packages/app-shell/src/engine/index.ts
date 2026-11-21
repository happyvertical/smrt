// The shared app engine: runs a person's own smrt app from a definition.
export {
  type BatchBlocker,
  type BatchCheck,
  type BatchCommand,
  type BatchOverwrites,
  type BlockerCode,
  batchDigest,
  type ChangeEngine,
  type ChangeFence,
  type ChangePrincipal,
  createSqliteChangeEngine,
  findChainBlockers,
  type RebuildInput,
  type RebuildResult,
  SqliteChangeEngine,
  type UndoBatchInput,
} from './change-engine.ts';
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
export type { DraftMarker } from './draft.ts';

import { removeDraftDirectory as removeDraftDirectoryOf } from './draft.ts';

/**
 * Delete a draft directory no host holds (SQLite). A PostgreSQL draft is
 * refused: its schema would be stranded; use `discardOrphanDraft`.
 */
export const discardDraftDirectory = (dir: string): void =>
  removeDraftDirectoryOf(dir);
export {
  AppError,
  ApprovalRequiredError,
  EngineError,
  type EngineErrorCode,
  StaleFenceError,
  WorkerCrashedError,
} from './errors.ts';
export type { ExtractModelCommand, ExtractPreview } from './extract-model.ts';
export { formulaWords } from './formula.ts';
export {
  AppHost,
  bundledWorkerUrl,
  type ChangeResult,
  type CleanUpResult,
  discardOrphanDraft,
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
  wantsBundledWorker,
} from './host.ts';
export type { ImportNames, RetainedImportPlan } from './import-names.ts';
export {
  createEngineImportTarget,
  EngineImportError,
  type EngineImportTarget,
  type ImportCommandHook,
  importFieldName,
  importModelName,
} from './import-target.ts';
export type { MergePreview, MergeRecordsCommand } from './merge-records.ts';
export {
  checkUserAppBundle,
  digestVersionHistory,
  type ExportUserAppOptions,
  exportUserApp,
  hasUserAppDatabase,
  type ImportUserAppOptions,
  type ImportUserAppResult,
  importUserApp,
  inspectUserApp,
  PORTABLE_USER_APP_FORMAT,
  type PortableUserApp,
  type PortableUserAppTable,
  type UserAppInspection,
  type UserAppVerification,
  verifyUserApp,
} from './portable-export.ts';
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
export {
  ENGINE_COMMAND_TYPES,
  ENGINE_TOOLS,
  isEngineTool,
} from './tool-definitions.ts';
export {
  DEFAULT_WORKER_LIMITS,
  type WorkerLimits,
} from './worker-handle.ts';
