import { validateCookbook } from '../validate.js';
import {
  adopt,
  execute,
  libraryName,
  type Outcome,
  type PlanState,
} from './commands.js';
import { DEFAULT_APP_NAME, DEFAULT_COLOR_SCHEME } from './defaults.js';
import {
  clone,
  describeTheme,
  emptyCookbook,
  readSettings,
  same,
} from './document.js';
import { buildNav } from './nav.js';
import {
  buildBatchTool,
  buildCommandTools,
  type CommandSchemas,
  checkSchema,
  commandSchemas,
} from './schemas.js';
import {
  type BatchResult,
  COOKBOOK_COMMANDS_VERSION,
  type CommandBatch,
  type CommandError,
  type CommandName,
  type CommandResult,
  type CommandTool,
  type EngineCatalog,
  type EngineState,
  type JournalEntry,
  type JsonSchema,
  type PlanSnapshot,
  type RunOptions,
} from './types.js';

export interface CookbookEngineOptions {
  catalog: EngineCatalog;
  /** Start from this document (strictly checked; the call throws if invalid). */
  cookbook?: unknown;
  /** Resume from a saved {@link EngineState} (wins over `cookbook`). */
  state?: EngineState;
  /** How many command ids are remembered for retries; default 500. */
  maxJournal?: number;
  /** How many undo entries are kept; default 20. */
  maxUndo?: number;
}

/**
 * The cookbook command engine: typed, versioned commands over one cookbook
 * document, held in plain objects. Never throws from `run`/`batch`; every
 * refusal is a typed error and leaves the document untouched.
 */
export interface CookbookEngine {
  /**
   * Run one command (`{ name, input, id?, expectedRevision? }`). A repeated
   * `id` returns the first result with `replayed: true` and applies nothing.
   */
  run(command: unknown, options?: RunOptions): CommandResult;
  /**
   * Run several commands all-or-nothing. On any failure the state is exactly
   * as before and the error names the failing command.
   */
  batch(batch: CommandBatch | unknown): BatchResult;
  /** The compact plan state, cheap enough for a model prompt. */
  snapshot(): PlanSnapshot;
  /** The document (a copy). */
  cookbook(): ReturnType<typeof clone<PlanState['doc']>>;
  /** Serializable state to persist and resume from, retries included. */
  state(): EngineState;
  /** Call `listener` with the snapshot now and after every change. */
  subscribe(listener: (snapshot: PlanSnapshot) => void): () => void;
  /** Command tool definitions (JSON Schema inputs), enums narrowed to the catalog. */
  readonly tools: readonly CommandTool[];
  /** The atomic-batch tool definition. */
  readonly batchTool: {
    name: 'run_batch';
    description: string;
    inputSchema: JsonSchema;
  };
}

interface UndoEntry {
  before: PlanState;
  /** What the change left; undo is a conflict while the plan differs from it. */
  after: PlanState;
}

const err = (
  code: CommandError['code'],
  message: string,
  extra: Pick<CommandError, 'path' | 'details'> = {},
): CommandError => ({ code, message, ...extra });

const fingerprint = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return 'unserializable';
  }
};

type Parsed =
  | { ok: true; name: CommandName; input: Record<string, unknown> }
  | { ok: false; error: CommandError };

function readCommand(
  value: unknown,
  schemas: CommandSchemas,
  extraKeys: readonly string[],
): Parsed {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      error: err('unknown_command', 'A command is an object: { name, input }.'),
    };
  }
  const record = value as Record<string, unknown>;
  const { name, input = {} } = record;
  if (typeof name !== 'string' || !Object.hasOwn(schemas, name)) {
    return {
      ok: false,
      error: err('unknown_command', `Unknown command ${JSON.stringify(name)}.`),
    };
  }
  for (const key of Object.keys(record)) {
    if (key !== 'name' && key !== 'input' && !extraKeys.includes(key)) {
      return {
        ok: false,
        error: err('invalid_input', `${key} is not part of a command.`, {
          path: key,
        }),
      };
    }
  }
  const problem = checkSchema(schemas[name as CommandName], input);
  if (problem) {
    return {
      ok: false,
      error: err('invalid_input', problem.message, { path: problem.path }),
    };
  }
  return {
    ok: true,
    name: name as CommandName,
    input: input as Record<string, unknown>,
  };
}

const checkId = (id: unknown): CommandError | null =>
  id === undefined ||
  (typeof id === 'string' && id.length > 0 && id.length <= 200)
    ? null
    : err(
        'invalid_input',
        'id must be a non-empty string of at most 200 characters.',
        { path: 'id' },
      );

const checkRevision = (value: unknown): CommandError | null =>
  value === undefined || (Number.isInteger(value) && (value as number) >= 0)
    ? null
    : err('invalid_input', 'expectedRevision must be a whole number.', {
        path: 'expectedRevision',
      });

export function createCookbookEngine(
  options: CookbookEngineOptions,
): CookbookEngine {
  const { catalog } = options;
  const schemas = commandSchemas(catalog);
  const tools = buildCommandTools(catalog);
  const batchTool = buildBatchTool(catalog);
  const maxJournal = options.maxJournal ?? 500;
  const maxUndo = options.maxUndo ?? 20;

  let current: PlanState;
  let revision = 0;
  const journal = new Map<string, JournalEntry>();

  if (options.state) {
    const saved = options.state;
    const checked = validateCookbook(saved.cookbook);
    if (!checked.ok)
      throw new Error(`Invalid saved cookbook: ${checked.errors.join('; ')}`);
    if (!Number.isInteger(saved.revision) || saved.revision < 0) {
      throw new Error('Invalid saved revision.');
    }
    current = {
      doc: adopt(catalog, checked.cookbook),
      applied: saved.applied ?? null,
    };
    revision = saved.revision;
    for (const entry of saved.journal ?? [])
      journal.set(entry.id, clone(entry));
  } else if (options.cookbook !== undefined) {
    const checked = validateCookbook(options.cookbook);
    if (!checked.ok)
      throw new Error(`Invalid cookbook: ${checked.errors.join('; ')}`);
    current = { doc: adopt(catalog, checked.cookbook), applied: null };
  } else {
    current = { doc: adopt(catalog, emptyCookbook()), applied: null };
  }

  const undos = new Map<string, UndoEntry>();
  let undoIds: string[] = [];
  let undoCounter = 0;
  const listeners = new Map<(s: PlanSnapshot) => void, number>();

  function snapshotOf(state: PlanState, rev: number): PlanSnapshot {
    const { doc } = state;
    const byId = new Map(catalog.recipes.map((r) => [r.id, r]));
    const settings = readSettings(catalog, doc);
    const exposed = new Set(
      catalog.models.filter((m) => m.exposed !== false).map((m) => m.id),
    );
    return {
      version: COOKBOOK_COMMANDS_VERSION,
      revision: rev,
      app: {
        name:
          doc.name ?? libraryName(catalog, state.applied) ?? DEFAULT_APP_NAME,
        description: doc.description ?? null,
        cookbook: state.applied,
      },
      recipes: doc.recipes.flatMap((id) => {
        const recipe = byId.get(id);
        return recipe ? [{ id, label: recipe.label }] : [];
      }),
      features: doc.features.filter((id) => exposed.has(id)),
      unavailable: [
        ...doc.recipes.filter((id) => !byId.has(id)),
        ...doc.features.filter((id) => !exposed.has(id)),
      ],
      settings: {
        currency: settings.currency,
        taxRate: Number((settings.taxRate * 100).toFixed(4)),
        paymentTerms: settings.paymentTerms,
      },
      theme: {
        text: describeTheme(doc.theme),
        preset: doc.theme?.preset ?? null,
        primary: doc.theme?.custom?.primary ?? null,
        colorScheme: doc.theme?.colorScheme ?? DEFAULT_COLOR_SCHEME,
      },
      sections: buildNav(catalog, doc).map((s) => ({
        id: s.id,
        label: s.label,
        hidden: s.hidden,
        items: s.items.map((i) => ({
          id: i.id,
          label: i.label,
          hidden: i.hidden,
        })),
      })),
      policies: doc.policies.length,
      undo: [...undoIds],
    };
  }

  const snapshot = () => snapshotOf(current, revision);

  function notify(): void {
    for (const [listener, last] of listeners) {
      if (last === revision) continue;
      listeners.set(listener, revision);
      listener(snapshot());
    }
  }

  function remember(
    id: string | undefined,
    print: string,
    result: CommandResult | BatchResult,
  ) {
    if (id === undefined) return;
    journal.set(id, { id, fingerprint: print, result: clone(result) });
    while (journal.size > maxJournal) {
      const oldest = journal.keys().next().value;
      if (oldest === undefined) break;
      journal.delete(oldest);
    }
  }

  function replay<R extends CommandResult | BatchResult>(
    id: string | undefined,
    print: string,
  ): R | CommandResult | null {
    if (id === undefined) return null;
    const hit = journal.get(id);
    if (!hit) return null;
    if (hit.fingerprint !== print) {
      return {
        ok: false,
        id,
        error: err(
          'id_reuse',
          `The id "${id}" was already used for a different command.`,
          {
            path: 'id',
          },
        ),
      };
    }
    return { ...(clone(hit.result) as R), replayed: true };
  }

  function recordUndo(before: PlanState, after: PlanState): string {
    const undoId = `undo-${++undoCounter}`;
    undos.set(undoId, { before: clone(before), after: clone(after) });
    undoIds = [...undoIds, undoId].slice(-maxUndo);
    for (const key of [...undos.keys()])
      if (!undoIds.includes(key)) undos.delete(key);
    return undoId;
  }

  const changedBetween = (a: PlanState, b: PlanState) =>
    a.applied !== b.applied || !same(a.doc, b.doc);

  function toSuccess(
    id: string | undefined,
    name: CommandName,
    outcome: Extract<Outcome, { ok: true }>,
    revisionBefore: number,
    revisionAfter: number,
    snap: PlanSnapshot,
    undoId?: string,
  ): Extract<CommandResult, { ok: true }> {
    return {
      ok: true,
      ...(id !== undefined ? { id } : {}),
      snapshot: snap,
      receipt: {
        name,
        ...(id !== undefined ? { id } : {}),
        summary: revisionAfter !== revisionBefore ? outcome.summary : '',
        changed: revisionAfter !== revisionBefore,
        revisionBefore,
        revisionAfter,
        ...(undoId ? { undoId } : {}),
        ...(outcome.changes ? { changes: outcome.changes } : {}),
        ...(outcome.warnings ? { warnings: outcome.warnings } : {}),
      },
      ...(outcome.data !== undefined ? { data: outcome.data } : {}),
    };
  }

  function runUndo(
    id: string | undefined,
    input: { undoId: string; force?: boolean },
  ): CommandResult {
    const entry = undos.get(input.undoId);
    if (!entry) {
      return {
        ok: false,
        ...(id !== undefined ? { id } : {}),
        error: err('not_found', `Nothing to undo for "${input.undoId}".`, {
          path: 'input.undoId',
        }),
      };
    }
    if (!input.force && changedBetween(current, entry.after)) {
      return {
        ok: false,
        ...(id !== undefined ? { id } : {}),
        error: err(
          'conflict',
          'The plan changed since; send force: true to undo anyway.',
          {
            details: { currentRevision: revision },
          },
        ),
      };
    }
    const before = revision;
    const restored = clone(entry.before);
    const changed = changedBetween(current, restored);
    current = restored;
    if (changed) revision += 1;
    undos.delete(input.undoId);
    undoIds = undoIds.filter((u) => u !== input.undoId);
    const result = toSuccess(
      id,
      'undo',
      { ok: true, state: current, summary: 'Undone.' },
      before,
      revision,
      snapshot(),
    );
    notify();
    return result;
  }

  function run(command: unknown, runOptions: RunOptions = {}): CommandResult {
    try {
      const raw =
        command && typeof command === 'object' && !Array.isArray(command)
          ? (command as Record<string, unknown>)
          : undefined;
      const id = raw?.id as string | undefined;
      const idProblem = checkId(id);
      if (idProblem) return { ok: false, error: idProblem };
      const expected = (raw?.expectedRevision ?? runOptions.expectedRevision) as
        | number
        | undefined;
      const revProblem = checkRevision(expected);
      if (revProblem)
        return {
          ok: false,
          ...(id !== undefined ? { id } : {}),
          error: revProblem,
        };

      const print = fingerprint({
        name: raw?.name,
        input: raw?.input ?? {},
        expectedRevision: expected,
      });
      const replayed = replay<CommandResult>(id, print);
      if (replayed) return replayed as CommandResult;

      const finish = (result: CommandResult) => {
        remember(id, print, result);
        return result;
      };
      const withId = (error: CommandError): CommandResult => ({
        ok: false,
        ...(id !== undefined ? { id } : {}),
        error,
      });

      const parsed = readCommand(command, schemas, ['id', 'expectedRevision']);
      if (!parsed.ok) return finish(withId(parsed.error));
      if (expected !== undefined && expected !== revision) {
        return finish(
          withId(
            err(
              'conflict',
              `The plan is at revision ${revision}, not ${expected}. Read the snapshot and try again.`,
              {
                details: {
                  expectedRevision: expected,
                  currentRevision: revision,
                },
              },
            ),
          ),
        );
      }
      if (parsed.name === 'undo') {
        return finish(
          runUndo(id, parsed.input as { undoId: string; force?: boolean }),
        );
      }
      const before = current;
      const outcome = execute(
        catalog,
        before,
        parsed.name,
        parsed.input as never,
      );
      if (!outcome.ok) return finish(withId(outcome.error));
      const revisionBefore = revision;
      const changed = changedBetween(before, outcome.state);
      let undoId: string | undefined;
      if (changed) {
        current = outcome.state;
        revision += 1;
        undoId = recordUndo(before, outcome.state);
      }
      const result = finish(
        toSuccess(
          id,
          parsed.name,
          outcome,
          revisionBefore,
          revision,
          snapshot(),
          undoId,
        ),
      );
      notify();
      return result;
    } catch (cause) {
      return {
        ok: false,
        error: err(
          'failed',
          cause instanceof Error ? cause.message : String(cause),
        ),
      };
    }
  }

  function batch(input: CommandBatch | unknown): BatchResult {
    const unchanged = (error: CommandError, id?: string): BatchResult => ({
      ok: false,
      ...(id !== undefined ? { id } : {}),
      error,
      snapshot: snapshot(),
    });
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return unchanged(
          err('invalid_input', 'A batch is an object: { commands }.'),
        );
      }
      const raw = input as Record<string, unknown>;
      const id = raw.id as string | undefined;
      const idProblem = checkId(id);
      if (idProblem) return unchanged(idProblem);
      const revProblem = checkRevision(raw.expectedRevision);
      if (revProblem) return unchanged(revProblem, id);
      const print = fingerprint({
        commands: raw.commands,
        expectedRevision: raw.expectedRevision,
      });
      const replayed = replay<BatchResult>(id, print);
      if (replayed) {
        return 'results' in replayed || 'snapshot' in replayed
          ? (replayed as BatchResult)
          : unchanged(
              (replayed as Extract<CommandResult, { ok: false }>).error,
              id,
            );
      }
      const finish = (result: BatchResult) => {
        remember(id, print, result);
        return result;
      };

      const commands = raw.commands;
      if (
        !Array.isArray(commands) ||
        commands.length === 0 ||
        commands.length > 50
      ) {
        return finish(
          unchanged(
            err(
              'invalid_input',
              'commands must be a list of 1 to 50 commands.',
              { path: 'commands' },
            ),
            id,
          ),
        );
      }
      const expected = raw.expectedRevision as number | undefined;
      if (expected !== undefined && expected !== revision) {
        return finish(
          unchanged(
            err(
              'conflict',
              `The plan is at revision ${revision}, not ${expected}. Read the snapshot and try again.`,
              {
                details: {
                  expectedRevision: expected,
                  currentRevision: revision,
                },
              },
            ),
            id,
          ),
        );
      }

      const failAt = (index: number, name: unknown, cause: CommandError) =>
        finish(
          unchanged(
            err(
              'batch_failed',
              `Command ${index + 1} (${String(name)}) failed: ${cause.message}`,
              {
                path: `commands[${index}]`,
                details: { index, cause },
              },
            ),
            id,
          ),
        );

      // Everything runs on a working copy; the live state is replaced once, at the end.
      const base = current;
      const baseRevision = revision;
      let working = base;
      let rev = baseRevision;
      const results: Extract<CommandResult, { ok: true }>[] = [];
      for (const [index, command] of commands.entries()) {
        const parsed = readCommand(command, schemas, []);
        if (!parsed.ok)
          return failAt(
            index,
            (command as { name?: unknown })?.name,
            parsed.error,
          );
        if (parsed.name === 'undo') {
          return failAt(
            index,
            'undo',
            err('invalid_input', 'undo cannot run inside a batch.'),
          );
        }
        const outcome = execute(
          catalog,
          working,
          parsed.name,
          parsed.input as never,
        );
        if (!outcome.ok) return failAt(index, parsed.name, outcome.error);
        const before = rev;
        if (changedBetween(working, outcome.state)) rev += 1;
        working = outcome.state;
        results.push(
          toSuccess(
            undefined,
            parsed.name,
            outcome,
            before,
            rev,
            snapshotOf(working, rev),
          ),
        );
      }
      const changed = rev !== baseRevision;
      let undoId: string | undefined;
      if (changed) {
        current = working;
        revision = rev;
        undoId = recordUndo(base, working);
        // The batch's one undo restores the state before all of it.
        for (const r of results) if (r.receipt.changed) delete r.receipt.undoId;
      }
      const result = finish({
        ok: true,
        ...(id !== undefined ? { id } : {}),
        snapshot: snapshot(),
        receipt: {
          ...(id !== undefined ? { id } : {}),
          count: results.length,
          changed,
          revisionBefore: baseRevision,
          revisionAfter: rev,
          ...(undoId ? { undoId } : {}),
        },
        results,
      });
      notify();
      return result;
    } catch (cause) {
      return unchanged(
        err('failed', cause instanceof Error ? cause.message : String(cause)),
      );
    }
  }

  return {
    run: run as CookbookEngine['run'],
    batch,
    snapshot,
    cookbook: () => clone(current.doc),
    state: () => ({
      version: COOKBOOK_COMMANDS_VERSION,
      revision,
      applied: current.applied,
      cookbook: clone(current.doc),
      journal: [...journal.values()].map((entry) => clone(entry)),
    }),
    subscribe(listener) {
      listeners.set(listener, revision);
      listener(snapshot());
      return () => {
        listeners.delete(listener);
      };
    },
    tools,
    batchTool,
  };
}
