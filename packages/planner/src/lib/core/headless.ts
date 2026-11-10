import { parseCookbookWith } from '../cookbook/parse.ts';
import type { Cookbook } from '../cookbook/types.ts';
import {
  createPlannerAdapter,
  type PlannerAdapter,
} from '../planner/commands/adapter.ts';
import { engineCatalog, restrictCatalog } from '../planner/commands/catalog.ts';
import type { CommandTool } from '../planner/commands/schemas.ts';
import type {
  BatchResult,
  CommandResult,
  PlannerCommand,
  PlanSnapshot,
  RunOptions,
} from '../planner/commands/types.ts';
import type { PromptCatalog } from './catalog.ts';

export interface HeadlessPlannerOptions {
  /**
   * Restrict the recipes and library cookbooks this plan may name (the same
   * shape `buildHostPrompt` takes). Ids outside it fail validation as
   * `invalid_input`, exactly as a bad enum value does. Default: the whole
   * library.
   */
  catalog?: PromptCatalog;
}

/**
 * One plan held in plain objects, driven by the same commands as the browser
 * planner. Runs in plain Node; any number may coexist.
 */
export interface HeadlessPlanner {
  /**
   * Run one command: same names, input schemas, validation, error codes and
   * receipts as the browser controller. Never throws.
   */
  run(command: PlannerCommand, options?: RunOptions): CommandResult;
  /** Untyped form for commands that arrive as data (a model's tool call). */
  run(command: unknown, options?: RunOptions): CommandResult;
  /** Several commands, all or nothing (the engine's `batch`). */
  batch(batch: unknown): BatchResult;
  /** The current plan, read-only and compact. */
  snapshot(): PlanSnapshot;
  /** The plan as a cookbook document (what `export_cookbook` writes). */
  cookbook(): Cookbook;
  /**
   * Undo the most recent undoable change. `not_found` when there is none; the
   * command `undo` with an explicit `undoId` is available through `run`.
   */
  undo(): CommandResult;
  /** Call `listener` with the snapshot now and after every command. */
  subscribe(listener: (snapshot: PlanSnapshot) => void): () => void;
  /** The command tools this plan validates against (a restricted catalog narrows the enums). */
  readonly tools: readonly CommandTool[];
}

/**
 * A planner with no UI, no runes and no module state: the command set over a
 * plain-object plan, for a Node server (an MCP server holds one per plan id).
 * It is smrt's cookbook command engine (`createCookbookEngine`) behind the
 * planner's names, plus `focus`.
 *
 * `cookbook` is the starting document; it goes through the strict import
 * check and the call throws on a document that fails it. Everything after that
 * reports errors through `run`'s result instead.
 */
export function createHeadlessPlanner(
  cookbook?: Cookbook,
  options: HeadlessPlannerOptions = {},
): HeadlessPlanner {
  let initial: Cookbook | undefined;
  if (cookbook !== undefined) {
    const parsed = parseCookbookWith(cookbook);
    if (!parsed.ok) throw new Error(parsed.error);
    initial = parsed.cookbook;
  }
  const base = engineCatalog();
  const adapter: PlannerAdapter = createPlannerAdapter({
    catalog: options.catalog ? restrictCatalog(base, options.catalog) : base,
    cookbook: initial,
    port: { prepareImport: (document) => parseCookbookWith(document) },
  });
  return {
    run: adapter.run,
    batch: adapter.batch,
    snapshot: adapter.snapshot,
    subscribe: adapter.subscribe,
    cookbook: adapter.cookbook,
    undo: adapter.undo,
    get tools() {
      return adapter.tools;
    },
  };
}
