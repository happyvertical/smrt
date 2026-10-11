/**
 * Cookbook command engine, contract v1 (#3753).
 *
 * Plain data in, plain data out: no SvelteKit, browser storage, planner
 * singleton or inference dependency, and no Node imports, so the same engine
 * runs in a browser planner, a CLI, an MCP server or a website. Adapters own
 * navigation/focus, persistence and transport; the engine owns the document.
 */
import type { Cookbook, RecipeDefinition } from '@happyvertical/smrt-types';

/**
 * The command set version. A change an older client could not send or read
 * bumps it; adding a command or an optional field does not.
 */
export const COOKBOOK_COMMANDS_VERSION = 1;

/** The part of a manifest recipe the engine reads (a `RecipeDefinition` fits). */
export type EngineRecipe = Pick<
  RecipeDefinition,
  'id' | 'label' | 'models' | 'nav' | 'requires'
> &
  Partial<
    Pick<RecipeDefinition, 'requiresAny' | 'group' | 'section' | 'options'>
  >;

/** One field of a catalog model, for `set_policy` and settings defaults. */
export interface EngineField {
  name: string;
  /** System fields (id, timestamps) cannot be given a policy. */
  system?: boolean;
  /** The field's own starting value, so a setting equal to it writes no row. */
  default?: unknown;
}

/** One catalog model. Same shape as smrt-svelte's `CookbookModelInfo`, plus fields. */
export interface EngineModel {
  /** Qualified name, `@scope/pkg:Class`. */
  id: string;
  name: string;
  /** Package id used in item ids: `commerce` for `@happyvertical/smrt-commerce`. */
  packageId: string;
  description?: string;
  /** Has an API, MCP or CLI surface; only exposed models can be added as features. */
  exposed?: boolean;
  /** When given, `set_policy` rejects a field not listed. */
  fields?: readonly EngineField[];
}

/** A ready-made cookbook the catalog offers (a library entry). */
export interface EngineLibraryCookbook {
  id: string;
  name: string;
  document: Cookbook;
}

/** Which model fields each app setting is the default of. */
export type SettingTargets = Record<
  'currency' | 'taxRate' | 'paymentTerms',
  readonly { model: string; field: string }[]
>;

/**
 * Everything the engine resolves ids against, as data: recipes and models from
 * published manifests, optionally a library of cookbooks. Nothing here is
 * bundled with the engine.
 */
export interface EngineCatalog {
  recipes: readonly EngineRecipe[];
  models: readonly EngineModel[];
  cookbooks?: readonly EngineLibraryCookbook[];
  /** Movable shell item ids resolved by the host (`dock:`, `slot:`, recipe, or host ids). */
  placementItems?: readonly string[];
  /** Theme preset names; default {@link DEFAULT_THEME_PRESETS}. */
  themePresets?: readonly string[];
  /** ISO 4217 codes; default any three capital letters. */
  currencies?: readonly string[];
  /** Default {@link COMMERCE_SETTING_TARGETS}. */
  settingTargets?: SettingTargets;
}

/** Input of each command, keyed by the command's (tool) name. */
export interface CommandInputs {
  /** Switch recipes on, with everything they `require`. */
  add_recipes: { ids: string[] };
  /** Switch recipes off; ones another recipe needs are kept (and reported). */
  remove_recipes: { ids: string[] };
  /** Add models no recipe covers, by qualified name. */
  add_features: { ids: string[] };
  remove_features: { ids: string[] };
  /** Add the recipes and features of a library cookbook to what is there. */
  add_cookbook: { id: string };
  /** Remove what a library cookbook added (recipes others need are kept). */
  remove_cookbook: { id: string };
  /** Select a library cookbook, replacing the app (needs `replace` if non-empty). */
  apply_cookbook: { id: string; replace?: boolean };
  /** Import a cookbook document, replacing the app (needs `replace` if non-empty). */
  import_cookbook: { document: unknown; replace?: boolean };
  /** App settings; tax rate in percent, 0 to 100. */
  set_settings: { currency?: string; taxRate?: number; paymentTerms?: string };
  /** Set (or clear with null) one field's policy row. App scope. */
  set_policy: {
    model: string;
    field: string;
    defaultValue?: unknown;
    visibility?: 'basic' | 'advanced' | 'hidden' | null;
    label?: string | null;
    help?: string | null;
  };
  set_theme: {
    preset?: string;
    primary?: string;
    colorScheme?: 'light' | 'dark' | 'system';
  };
  reset_theme: Record<string, never>;
  /** Name (and describe) the app; null clears. */
  set_name: { name?: string | null; description?: string | null };
  rename_section: { id: string; label: string };
  /** `null` restores the entry's own name. */
  rename_item: { id: string; label: string | null };
  hide: { id: string };
  show: { id: string };
  /** Check the current document and report typed diagnostics. Changes nothing. */
  validate: Record<string, never>;
  /** The cookbook as `<name>.cookbook.json` text. Changes nothing. */
  export_cookbook: { name?: string };
  /** Undo an earlier change by the `undoId` its receipt carried. */
  undo: { undoId: string; force?: boolean };
}

export type CommandName = keyof CommandInputs;

/** A command as a client sends it. */
export type CookbookCommand = {
  [N in CommandName]: {
    name: N;
    input: CommandInputs[N];
    /** Retry key: a repeated id returns the first receipt and applies nothing. */
    id?: string;
    /** Refuse with `conflict` unless the plan is still at this revision. */
    expectedRevision?: number;
  };
}[CommandName];

/** Stable strings a client can switch on. */
export type CommandErrorCode =
  | 'unknown_command'
  | 'invalid_input'
  | 'not_found'
  /** A destructive command needs `replace: true` (or `force: true`). */
  | 'confirmation_required'
  /** The plan moved on since the caller looked (`expectedRevision`, undo). */
  | 'conflict'
  /** A command id was reused with a different command. */
  | 'id_reuse'
  /** An atomic batch failed; `details.index` names the command, nothing applied. */
  | 'batch_failed'
  | 'failed';

export interface CommandError {
  code: CommandErrorCode;
  message: string;
  /** Where the problem is, as a path into the input (`input.ids[1]`). */
  path?: string;
  details?: Record<string, unknown>;
}

/** What a recipe/feature command did, after `requires` ran. */
export interface RecipeChanges {
  added: string[];
  removed: string[];
  /** Asked to remove, but another recipe still needs them. */
  kept: string[];
}

export interface PlanSnapshot {
  version: typeof COOKBOOK_COMMANDS_VERSION;
  /** Counts applied changes; equal histories give equal revisions. */
  revision: number;
  app: { name: string; description: string | null; cookbook: string | null };
  recipes: { id: string; label: string }[];
  features: string[];
  /** Recipe and feature ids this catalog lacks; kept on export. */
  unavailable: string[];
  settings: { currency: string; taxRate: number; paymentTerms: string };
  theme: {
    text: string;
    preset: string | null;
    primary: string | null;
    colorScheme: string;
  };
  sections: {
    id: string;
    label: string;
    hidden: boolean;
    items: { id: string; label: string; hidden: boolean }[];
  }[];
  policies: number;
  /** Undo ids still available, newest last. */
  undo: string[];
}

export interface CommandReceipt {
  name: CommandName;
  /** The command id, when one was sent. */
  id?: string;
  summary: string;
  changed: boolean;
  revisionBefore: number;
  revisionAfter: number;
  undoId?: string;
  changes?: RecipeChanges;
  /** Non-fatal notes (an import's legacy `$schema` migration). */
  warnings?: string[];
}

export type CommandResult =
  | {
      ok: true;
      id?: string;
      /** True when this is the stored result of an earlier run of the same id. */
      replayed?: boolean;
      snapshot: PlanSnapshot;
      receipt: CommandReceipt;
      data?: unknown;
    }
  | { ok: false; id?: string; replayed?: boolean; error: CommandError };

export interface RunOptions {
  expectedRevision?: number;
}

/** Several commands applied all-or-nothing. */
export interface CommandBatch {
  id?: string;
  commands: readonly unknown[];
  expectedRevision?: number;
}

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
      /** One result per command, in order. */
      results: Extract<CommandResult, { ok: true }>[];
    }
  | {
      ok: false;
      id?: string;
      replayed?: boolean;
      error: CommandError;
      /** The state is exactly as before the batch. */
      snapshot: PlanSnapshot;
    };

/** One diagnostic from `validate`. */
export interface Diagnostic {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
}

export interface ValidateData {
  ok: boolean;
  diagnostics: Diagnostic[];
}

export interface ExportData {
  fileName: string;
  text: string;
  cookbook: Cookbook;
}

/** A journal row: enough to answer a retry of `id` after a restart. */
export interface JournalEntry {
  id: string;
  fingerprint: string;
  result: CommandResult | BatchResult;
}

/** The engine's whole state as plain JSON, to persist and resume from. */
export interface EngineState {
  version: typeof COOKBOOK_COMMANDS_VERSION;
  revision: number;
  /** The library cookbook the plan was last set up from, if any. */
  applied: string | null;
  cookbook: Cookbook;
  journal: JournalEntry[];
}

export interface JsonSchema {
  [key: string]: unknown;
}

/** One command as an LLM or MCP tool definition. */
export interface CommandTool {
  name: CommandName;
  description: string;
  inputSchema: JsonSchema;
}
