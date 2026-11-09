// Builder operations are commands. `plan` says what one would do without
// changing anything; `execute` applies it. Risky commands are refused unless
// the caller passes `approved: true`: the lowest-layer enforcement of the
// approval gate (a preview only advises).
import type { AppDefinition, FieldDef, MethodDef } from './definition.ts';

export type Command =
  | {
      type: 'defineModel';
      name: string;
      label?: string;
      fields?: Record<string, FieldDef>;
    }
  | { type: 'addField'; model: string; field: string; definition: FieldDef }
  | { type: 'hideField'; model: string; field: string }
  | { type: 'renameField'; model: string; from: string; to: string }
  | { type: 'removeField'; model: string; field: string }
  | { type: 'changeFieldType'; model: string; field: string; to: FieldDef }
  | { type: 'removeModel'; model: string }
  | { type: 'addMethod'; model: string; name: string; method: MethodDef }
  | { type: 'enableRecipe'; recipe: string }
  | { type: 'undo' }
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
 * template carries method code (see {@link isRiskyCommand}).
 */
export const RISKY_COMMANDS: ReadonlySet<CommandType> = new Set<CommandType>([
  'addMethod',
  'removeField',
  'removeModel',
  'changeFieldType',
  'cleanUp',
]);

export function isRiskyCommand(cmd: Command): boolean {
  if (RISKY_COMMANDS.has(cmd.type)) return true;
  if (cmd.type === 'importTemplate')
    return Object.values(cmd.data?.definition?.models ?? {}).some(
      (m) => Object.keys(m?.methods ?? {}).length > 0,
    );
  return false;
}

/** Generated app tools that delete records need approval. */
export function isRiskyTool(name: string): boolean {
  return /_delete$/.test(name);
}
