import type {
  CommandError as EngineCommandError,
  CommandInputs as EngineCommandInputs,
  CommandReceipt as EngineCommandReceipt,
  PlanSnapshot as EnginePlanSnapshot,
  ExportData,
  RecipeChanges,
  RunOptions,
} from '@happyvertical/smrt-core/cookbook/engine';

/*
 * The planner command set is smrt's cookbook command engine
 * (`@happyvertical/smrt-core/cookbook/engine`, #3753) plus `focus`, the one
 * command that is about the planner's own view and not the document. Types,
 * errors, receipts and the snapshot are the engine's; this file only adds what
 * the planner puts on top. `docs/inference-host.md` lists the differences from
 * the v1 command set the planner shipped before the engine.
 */

export { COOKBOOK_COMMANDS_VERSION as PLANNER_COMMANDS_VERSION } from '@happyvertical/smrt-core/cookbook/engine';
export type { ExportData, RecipeChanges, RunOptions };

/** The planner's tabs, in order. Navigation only; never part of the cookbook. */
export const PLANNER_TAB_IDS = [
  'cookbooks',
  'recipes',
  'features',
  'layout',
  'settings',
  'export',
] as const;
export type PlannerTabId = (typeof PLANNER_TAB_IDS)[number];

/** Input of each command, keyed by the command's (tool) name. */
export interface CommandInputs extends EngineCommandInputs {
  /** Move the planner's focus to a tab and/or a section. Not a document change. */
  focus: { tab?: PlannerTabId; section?: string };
}

export type CommandName = keyof CommandInputs;

/** One command: its name and input. The unit `controller.run` takes. */
export type PlannerCommand = {
  [N in CommandName]: {
    name: N;
    input: CommandInputs[N];
    /** Retry key: a repeated id returns the first receipt and applies nothing. */
    id?: string;
    /** Refuse with `conflict` unless the plan is still at this revision. */
    expectedRevision?: number;
  };
}[CommandName];

/** Why a command did not run (the engine's codes). */
export type CommandError = EngineCommandError;
export type CommandErrorCode = EngineCommandError['code'];

/** The engine's snapshot, plus where the planner is looking. */
export interface PlanSnapshot extends EnginePlanSnapshot {
  /** Where the planner is looking; not saved. */
  focus: { tab: PlannerTabId | null; section: string | null };
}

/** The engine's receipt; its `name` may also be `focus`. */
export interface CommandReceipt extends Omit<EngineCommandReceipt, 'name'> {
  name: CommandName;
}

export type CommandResult =
  | {
      ok: true;
      id?: string;
      /** True when this is the stored result of an earlier run of the same id. */
      replayed?: boolean;
      snapshot: PlanSnapshot;
      receipt: CommandReceipt;
      /** Extra output: `export_cookbook` returns the file, `validate` the diagnostics. */
      data?: unknown;
    }
  | { ok: false; id?: string; replayed?: boolean; error: CommandError };

/** Several commands applied all-or-nothing (`engine.batch`). */
export type BatchResult =
  | {
      ok: true;
      id?: string;
      replayed?: boolean;
      snapshot: PlanSnapshot;
      receipt: {
        id?: string;
        count: number;
        changed: boolean;
        revisionBefore: number;
        revisionAfter: number;
        undoId?: string;
      };
      results: Extract<CommandResult, { ok: true }>[];
    }
  | {
      ok: false;
      id?: string;
      replayed?: boolean;
      error: CommandError;
      snapshot: PlanSnapshot;
    };
