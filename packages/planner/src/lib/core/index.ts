/**
 * The planner without a UI: what a Node server needs to implement the host
 * contract (`docs/inference-host.md`). Rune-free and importable by plain Node,
 * no Vite and no Svelte compiler.
 *
 * - command tool schemas and input types, and the `PlanSnapshot` type;
 * - `buildHostPrompt`: the system prompt and messages for one chat call;
 * - `replySchema` / `buildReplySchema`: the JSON Schema of the model's answer;
 * - `parseHostReply`: validate that answer into the response body;
 * - `parseHostRequest`: validate the request body;
 * - the library catalog (recipes and cookbooks) the prompt is built from;
 * - `createHeadlessPlanner`: the command set over a plain-object plan (many may
 *   coexist): smrt's cookbook command engine behind the planner's names, the
 *   same commands, validation and snapshots as the browser controller.
 *
 * The browser controller (`createPlannerController`) is not here: it drives
 * the UI's stores and lives in `./commands` (Svelte source).
 *
 * @module
 */

export {
  HOST_HISTORY_CHARS,
  HOST_HISTORY_TURNS,
  HOST_MESSAGE_CHARS,
  HOST_WIRE_VERSION,
  type HostRequest,
} from '../inference/host.ts';
export {
  buildCommandTools,
  COMMAND_NAMES,
  type CommandTool,
  checkSchema,
  commandSchemas,
  commandTools,
  type JsonSchema,
} from '../planner/commands/schemas.ts';
export {
  type BatchResult,
  type CommandError,
  type CommandErrorCode,
  type CommandInputs,
  type CommandName,
  type CommandReceipt,
  type CommandResult,
  type ExportData,
  PLANNER_COMMANDS_VERSION,
  PLANNER_TAB_IDS,
  type PlannerCommand,
  type PlannerTabId,
  type PlanSnapshot,
  type RecipeChanges,
  type RunOptions,
} from '../planner/commands/types.ts';
export {
  type CookbookBrief,
  defaultCatalog,
  getLibraryCookbook,
  getRecipe,
  type LibraryCookbook,
  libraryCookbooks,
  type PromptCatalog,
  type Recipe,
  recipes,
  recipesById,
} from './catalog.ts';
export {
  createHeadlessPlanner,
  type HeadlessPlanner,
  type HeadlessPlannerOptions,
} from './headless.ts';
export {
  buildHostPrompt,
  type HostPrompt,
  type HostPromptInput,
  type HostTurn,
} from './prompt.ts';
export {
  buildReplySchema,
  type HostReply,
  type ParsedHostReply,
  parseHostReply,
  replySchema,
} from './reply.ts';
export { type HostRequestParse, parseHostRequest } from './request.ts';
