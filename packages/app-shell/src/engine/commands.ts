import type { LoadRecordsCommand } from './data-migrations.ts';
// Builder operations are commands. `plan` says what one would do without
// changing anything; `execute` applies it. Risky commands are refused unless
// the caller passes `approved: true`: the lowest-layer enforcement of the
// approval gate (a preview only advises).
import type { AppDefinition, FieldDef, MethodDef, Step } from './definition.ts';
import type { ExtractModelCommand } from './extract-model.ts';
import type { MergeRecordsCommand } from './merge-records.ts';
import type { ReportDef } from './reports.ts';

export type Command =
  | MergeRecordsCommand
  | ExtractModelCommand
  | LoadRecordsCommand
  | { type: 'defineReport'; name: string; definition: ReportDef }
  | { type: 'renameReport'; from: string; to: string }
  | { type: 'removeReport'; name: string }
  | {
      type: 'defineModel';
      name: string;
      label?: string;
      fields?: Record<string, FieldDef>;
    }
  | { type: 'addField'; model: string; field: string; definition: FieldDef }
  | {
      type: 'setCalculation';
      model: string;
      field: string;
      calculated: FieldDef['calculated'] | null;
    }
  | { type: 'hideField'; model: string; field: string }
  | { type: 'renameField'; model: string; from: string; to: string }
  | { type: 'removeField'; model: string; field: string }
  | { type: 'changeFieldType'; model: string; field: string; to: FieldDef }
  | { type: 'removeModel'; model: string }
  | { type: 'addMethod'; model: string; name: string; method: MethodDef }
  | { type: 'enableRecipe'; recipe: string }
  /**
   * Undo the current version. `version` (optional) pins which version the
   * caller means; the host refuses if the app has moved on since.
   */
  | { type: 'undo'; version?: number }
  /**
   * Undo every version after `version` (an ancestor of the current one) in one
   * command, newest first. It needs approval when any of them has a
   * `convertColumn` step, decided by the host from the stored versions.
   * `from` pins the version the caller saw as current; the host refuses if the
   * app has moved on.
   */
  | { type: 'undoTo'; version: number; from?: number }
  | { type: 'cleanUp'; keep: number }
  | { type: 'exportTemplate'; includeRecords?: boolean }
  | { type: 'importTemplate'; data: Template };

export type CommandType = Command['type'];

export interface Plan {
  summary: string;
  risky: boolean;
  /** Counts of values to archive, values that will not convert, rows in a removed model. */
  preview?: Record<string, unknown>;
  /** Methods whose code mentions a renamed field; their code is not rewritten. */
  affectedMethods?: string[];
}

export interface ExecuteOptions {
  author: string;
  approved?: boolean;
}

/** A template: the definition (and optionally the records) of an app. */
export interface Template {
  format: 1;
  exportedAt?: string;
  definition: AppDefinition;
  records?: Record<string, Record<string, unknown>[]>;
}

/**
 * Commands that must be approved. `importTemplate` is risky only when the
 * template carries method code (see {@link isRiskyCommand}); `undo` is risky
 * only when the stored version being undone has a `convertColumn` step, which
 * the host decides from the stored version (never from the caller), so it is
 * not in this set.
 */
export const RISKY_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>([
  'addMethod',
  'removeField',
  'removeModel',
  'extractModel',
  'mergeRecords',
  'changeFieldType',
  'setCalculation',
  'cleanUp',
]);

/** A migration step whose down path overwrites newer data with archived originals. */
export function overwritesOnUndo(step: Step): boolean {
  if (step.op === 'calculation')
    return (
      !!(step.from && !step.from.calculated) ||
      !!(step.to && !step.to.calculated)
    );
  return (
    step.op === 'convertColumn' ||
    step.op === 'loadRecords' ||
    step.op === 'extractModel' ||
    step.op === 'mergeRecords'
  );
}

/** Static risk of a command. `undo` is decided by the host from the stored version. */
export function isRiskyCommand(cmd: Command): boolean {
  if (RISKY_COMMANDS.has(cmd.type)) return true;
  if (cmd.type === 'loadRecords') return cmd.mode === 'upsert';
  if (cmd.type === 'importTemplate')
    return Object.values(cmd.data?.definition?.models ?? {}).some(
      (m) => Object.keys(m?.methods ?? {}).length > 0,
    );
  return false;
}

/**
 * Which commands change the app's definition, tables or history. A frozen host
 * (see `HostOptions.frozen`) refuses every one of them; only `exportTemplate`
 * reads. It is a total `Record` so that a new command cannot be added without
 * deciding which side it is on.
 */
export const STRUCTURAL_COMMANDS: Readonly<Record<CommandType, boolean>> = {
  defineReport: true,
  renameReport: true,
  removeReport: true,
  mergeRecords: true,
  extractModel: true,
  loadRecords: true,
  defineModel: true,
  addField: true,
  setCalculation: true,
  hideField: true,
  renameField: true,
  removeField: true,
  changeFieldType: true,
  removeModel: true,
  addMethod: true,
  enableRecipe: true,
  undo: true,
  undoTo: true,
  cleanUp: true,
  exportTemplate: false,
  importTemplate: true,
};

/** True unless the command is known to be read-only (an unknown type counts as structural). */
export function isStructuralCommand(cmd: { type?: unknown }): boolean {
  const type = cmd?.type;
  return !(
    typeof type === 'string' &&
    Object.hasOwn(STRUCTURAL_COMMANDS, type) &&
    STRUCTURAL_COMMANDS[type as CommandType] === false
  );
}

/** Generated app tools that delete records need approval. */
export function isRiskyTool(name: string): boolean {
  return /_delete$/.test(name);
}
