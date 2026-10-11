import {
  type CookbookEngine,
  canonical,
  createCookbookEngine,
  type EngineCatalog,
  type CommandResult as EngineCommandResult,
  type EngineState,
  isEmptyCookbook,
} from '@happyvertical/smrt-core/cookbook/engine';
import type { Cookbook, CookbookResult } from '../../cookbook/types.ts';
import { checkSchema, toolsFor } from './schemas.ts';
import {
  type BatchResult,
  type CommandError,
  type CommandName,
  type CommandResult,
  PLANNER_TAB_IDS,
  type PlannerCommand,
  type PlannerTabId,
  type PlanSnapshot,
  type RunOptions,
} from './types.ts';

/*
 * The planner as an adapter over smrt's cookbook engine
 * (`@happyvertical/smrt-core/cookbook/engine`). Every rule of the command set
 * (validation, revisions, ids, batches, undo, receipts, snapshots) lives in the
 * engine. This module owns only what is the planner's:
 *
 * - `focus`, the planner's tab and section (not part of the document);
 * - keeping the engine in step with an app whose UI edits the document between
 *   commands (`PlannerPort.read`): such an edit starts a new engine epoch at
 *   the next revision, and the undo history of the old one is closed;
 * - handing the engine's new document back to the app (`PlannerPort.write`);
 * - the planner's strict import check, run before the engine's.
 *
 * No runes and no module state: the browser controller and the headless
 * planner are both this, with different ports.
 */

/** How the controller reads and moves the planner's own view. */
export interface PlannerNavigation {
  getTab(): PlannerTabId | null;
  setTab(tab: PlannerTabId): void;
  /** Open a menu section's page; the host decides what that means. */
  setSection?(sectionId: string): void;
}

export interface PlannerControllerOptions {
  /** The planner tab, so `focus` and the snapshot follow the real UI. */
  navigation?: PlannerNavigation;
  /**
   * Called after a library cookbook was applied, so the app can regenerate its
   * sample records (they are not part of a cookbook), as the Cookbooks tab does.
   */
  onReplaced?: () => void;
}

/** Where the app keeps the document the engine edits. */
export interface PlannerPort {
  /**
   * The app's current document. Give it when something other than the engine
   * (the UI) can change the document: it is compared on every call, and a
   * difference is adopted as one manual edit.
   */
  read?(): unknown;
  /** The library cookbook the app was last set up from, if the app tracks it. */
  applied?(): string | null;
  /** The engine changed the document: put it where the app keeps it. */
  write?(
    cookbook: Cookbook,
    change: {
      /** The commands that ran (a batch lists each; an undo is `undo`). */
      commands: readonly string[];
      /**
       * A whole-app command ran (`apply_cookbook`, `import_cookbook`): take
       * everything from `cookbook`, page customisations included. Otherwise
       * the app's own page customisations are kept.
       */
      replaced: boolean;
      /** The library cookbook the engine records the plan as set up from. */
      applied: string | null;
      /** A library cookbook was just set up: select it and reset sample data. */
      libraryApplied: boolean;
    },
  ): void;
  /** The app's own check of an imported document (it may migrate or trim it). */
  prepareImport?(document: unknown): CookbookResult;
}

/** A value read and written by the adapter; reactive in the browser. */
export interface Cell<T> {
  get(): T;
  set(value: T): void;
}

/** A plain cell. */
export function cell<T>(initial: T): Cell<T> {
  let value = initial;
  return {
    get: () => value,
    set: (next) => {
      value = next;
    },
  };
}

/** What differs between the browser controller and plain Node. All optional. */
export interface AdapterEnv {
  /** Cells for state a snapshot shows; the browser passes `$state` ones. */
  section?: Cell<string | null>;
  tab?: Cell<PlannerTabId | null>;
  /** The first listener arrived / the last one left (the browser starts effects). */
  watch?: { start(): void; stop(): void };
}

/**
 * The planner as a headless object: typed commands in, a compact snapshot
 * out. The planner's own assistant, a host page, an MCP server and the CLI
 * all drive the app through this one seam.
 */
export interface PlannerController {
  /**
   * Run one command. Never throws: a bad command, unknown id or refused edit
   * comes back as `{ ok: false, error }` and leaves the app unchanged.
   */
  run(command: PlannerCommand, options?: RunOptions): CommandResult;
  /** Untyped form for commands that arrive as data (a model's tool call). */
  run(command: unknown, options?: RunOptions): CommandResult;
  /**
   * Run several commands all-or-nothing (the engine's `batch`): any failure
   * leaves the plan exactly as it was.
   */
  batch(batch: unknown): BatchResult;
  /** The current plan, read-only and compact. */
  snapshot(): PlanSnapshot;
  /**
   * Call `listener` with the current snapshot now and after every change,
   * whether a command or a manual edit made it. Returns the unsubscribe.
   */
  subscribe(listener: (snapshot: PlanSnapshot) => void): () => void;
}

/** The adapter plus the hooks the browser wrapper's effects need. */
export interface PlannerAdapter extends PlannerController {
  /** The plan as a cookbook document. */
  cookbook(): Cookbook;
  /** Undo the most recent undoable change; `not_found` when there is none. */
  undo(): CommandResult;
  /** The engine's state, to persist and resume from. */
  state(): EngineState;
  /** The tool definitions this plan validates against, `focus` included. */
  readonly tools: ReturnType<typeof toolsFor>;
  /** The atomic-batch tool definition. */
  readonly batchTool: CookbookEngine['batchTool'];
  /**
   * Build the snapshot and return its signature. Reading it subscribes an
   * effect to every store it is built from; it does not notify.
   */
  observe(): string;
  /** Tell listeners about the current snapshot if it changed since they heard. */
  deliver(): void;
}

export interface PlannerAdapterOptions {
  catalog: EngineCatalog;
  /** Start from this document (strictly checked; the call throws if invalid). */
  cookbook?: unknown;
  port?: PlannerPort;
  options?: PlannerControllerOptions;
  env?: AdapterEnv;
}

const err = (
  code: CommandError['code'],
  message: string,
  extra: Partial<CommandError> = {},
): CommandError => ({ code, message, ...extra });

const fail = (error: CommandError, id?: string): CommandResult => ({
  ok: false,
  ...(id !== undefined ? { id } : {}),
  error,
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const REPLACING = new Set(['apply_cookbook', 'import_cookbook']);
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** The document without `overviews`: page edits are not plan changes. */
function signature(doc: unknown, applied: string | null): string {
  if (!isObject(doc)) return JSON.stringify([applied, doc ?? null]);
  const { overviews: _overviews, ...rest } = doc;
  return JSON.stringify([applied, rest]);
}

export function createPlannerAdapter(
  config: PlannerAdapterOptions,
): PlannerAdapter {
  const { catalog, port, options = {}, env = {} } = config;
  const section = env.section ?? cell<string | null>(null);
  const tab = env.tab ?? cell<PlannerTabId | null>(null);
  const tools = toolsFor(catalog);
  const schemaOf = (name: CommandName) =>
    tools.find((tool) => tool.name === name)?.inputSchema as Record<
      string,
      unknown
    >;
  const focusSchema = schemaOf('focus');
  const undoSchema = schemaOf('undo');

  let engine: CookbookEngine;
  let lastKey = '';
  /** Why the app's document could not be adopted; commands fail until it can. */
  let syncError: string | null = null;
  /** Undo ids the outside has seen, by the engine's own id; closed on a new epoch. */
  let outward = new Map<string, string>();
  let inward = new Map<string, string>();
  let undoCounter = 0;
  const listeners = new Map<(snapshot: PlanSnapshot) => void, string>();

  const resolvedApplied = () => port?.applied?.() ?? null;
  const currentTab = () => options.navigation?.getTab() ?? tab.get();

  function start(): void {
    if (!port?.read) {
      // Headless: the given document is the plan, and a bad one is the caller's error.
      engine = createCookbookEngine(
        config.cookbook === undefined
          ? { catalog }
          : {
              catalog,
              state: {
                version: 1,
                revision: 0,
                applied: null,
                cookbook: config.cookbook as never,
                journal: [],
              },
            },
      );
      return;
    }
    const given = port.read();
    lastKey = signature(given, resolvedApplied());
    try {
      engine = createCookbookEngine({
        catalog,
        state: {
          version: 1,
          revision: 0,
          applied: resolvedApplied(),
          cookbook: given as never,
          journal: [],
        },
      });
    } catch (cause) {
      // The app's document is not one the engine accepts: start empty, say so.
      engine = createCookbookEngine({ catalog });
      syncError = message(cause);
    }
  }
  start();

  /** The app edited the document by hand: a new epoch, one revision on. */
  function adoptManualEdit(doc: unknown, key: string): void {
    const state = engine.state();
    try {
      engine = createCookbookEngine({
        catalog,
        state: {
          version: 1,
          revision: state.revision + 1,
          applied: resolvedApplied(),
          cookbook: doc as never,
          journal: state.journal,
        },
      });
      syncError = null;
    } catch (cause) {
      // Keep the engine as it was; commands answer `failed` until the document is valid.
      syncError = message(cause);
    }
    outward = new Map();
    inward = new Map();
    lastKey = key;
  }

  /** Compare the app's document with the engine's; adopt a difference. Never throws. */
  function sync(): void {
    if (!port?.read) return;
    try {
      const doc = port.read();
      const key = signature(doc, resolvedApplied());
      if (key === lastKey) return;
      adoptManualEdit(doc, key);
    } catch (cause) {
      syncError = message(cause);
    }
  }

  const syncFailureError = (): CommandError =>
    err(
      'failed',
      `The app's document is not one the planner can read (${syncError}). Fix it or reset the cookbook, then try again.`,
    );
  const syncFailure = (id?: string): CommandResult =>
    fail(syncFailureError(), id);

  function undoIdOut(inner: string | undefined): string | undefined {
    if (!inner) return undefined;
    let id = outward.get(inner);
    if (!id) {
      id = `undo-${++undoCounter}`;
      outward.set(inner, id);
      inward.set(id, inner);
    }
    return id;
  }

  /** Forget undo ids the engine no longer holds (used or past its cap). */
  function pruneUndoIds(live: readonly string[]): void {
    const keep = new Set(live);
    for (const [inner, id] of outward) {
      if (keep.has(inner)) continue;
      outward.delete(inner);
      inward.delete(id);
    }
  }

  const withView = (
    base: ReturnType<CookbookEngine['snapshot']>,
  ): PlanSnapshot => ({
    ...base,
    undo: base.undo.map((id) => undoIdOut(id) as string),
    focus: { tab: currentTab(), section: section.get() },
  });

  function build(): PlanSnapshot {
    const base = engine.snapshot();
    pruneUndoIds(base.undo);
    return withView(base);
  }

  /** The engine's document with the app's live page customisations. */
  function liveDocument(doc: Record<string, unknown>): Record<string, unknown> {
    if (!port?.read) return doc;
    try {
      const live = port.read();
      const overviews = isObject(live) ? live.overviews : undefined;
      const { overviews: _stale, ...rest } = doc;
      return canonical(
        (isObject(overviews) && Object.keys(overviews).length
          ? { ...rest, overviews }
          : rest) as never,
      ) as unknown as Record<string, unknown>;
    } catch {
      return doc;
    }
  }

  function decorate(result: EngineCommandResult): CommandResult {
    if (!result.ok) return result;
    const { receipt } = result;
    // A replay answers an earlier epoch's change: its undo id may now name another.
    const undoId = result.replayed ? undefined : undoIdOut(receipt.undoId);
    const { undoId: _drop, ...rest } = receipt;
    let data = result.data;
    if (
      receipt.name === 'export_cookbook' &&
      isObject(data) &&
      !result.replayed
    ) {
      const cookbook = liveDocument(data.cookbook as Record<string, unknown>);
      data = {
        ...data,
        cookbook,
        text: `${JSON.stringify(cookbook, null, 2)}\n`,
      };
    }
    return {
      ...result,
      ...(data !== undefined ? { data } : {}),
      snapshot: build(),
      receipt: { ...rest, ...(undoId ? { undoId } : {}) },
    } as CommandResult;
  }

  /** Hand the engine's document to the app after a change. */
  function commit(commands: readonly string[], appliedBefore: string | null) {
    if (!port?.write) return;
    const applied = engine.snapshot().app.cookbook;
    const libraryApplied =
      commands.includes('apply_cookbook') ||
      (applied !== null && applied !== appliedBefore);
    port.write(engine.cookbook() as never, {
      commands,
      replaced: commands.some((name) => REPLACING.has(name)),
      applied,
      libraryApplied,
    });
    if (port.read) lastKey = signature(port.read(), resolvedApplied());
    if (libraryApplied) options.onReplaced?.();
  }

  function deliver(): void {
    if (!listeners.size) return;
    sync();
    const current = build();
    const full = JSON.stringify(current);
    for (const [listener, last] of listeners) {
      if (last === full) continue;
      listeners.set(listener, full);
      listener(current);
    }
  }

  /** `id`, `expectedRevision` and stray keys, checked as the engine checks them. */
  function checkEnvelope(
    raw: Record<string, unknown>,
    runOptions: RunOptions,
  ): CommandError | null {
    for (const key of Object.keys(raw)) {
      if (!['name', 'input', 'id', 'expectedRevision'].includes(key)) {
        return err('invalid_input', `${key} is not part of a command.`, {
          path: key,
        });
      }
    }
    const { id } = raw;
    if (
      id !== undefined &&
      !(typeof id === 'string' && id.length > 0 && id.length <= 200)
    ) {
      return err(
        'invalid_input',
        'id must be a non-empty string of at most 200 characters.',
        { path: 'id' },
      );
    }
    const expected = raw.expectedRevision ?? runOptions.expectedRevision;
    if (
      expected !== undefined &&
      !(Number.isInteger(expected) && (expected as number) >= 0)
    ) {
      return err('invalid_input', 'expectedRevision must be a whole number.', {
        path: 'expectedRevision',
      });
    }
    return null;
  }

  function runFocus(
    raw: Record<string, unknown>,
    runOptions: RunOptions,
  ): CommandResult {
    const bad = checkEnvelope(raw, runOptions);
    const id = typeof raw.id === 'string' ? raw.id : undefined;
    if (bad) return fail(bad, id);
    const expected = raw.expectedRevision ?? runOptions.expectedRevision;
    const input = (raw.input ?? {}) as { tab?: PlannerTabId; section?: string };
    const problem = checkSchema(focusSchema, input);
    if (problem)
      return fail(err('invalid_input', problem, { path: 'input' }), id);
    const revision = engine.snapshot().revision;
    if (expected !== undefined && expected !== revision) {
      return fail(
        err(
          'conflict',
          `The plan is at revision ${revision}, not ${expected}. Read the snapshot and try again.`,
          {
            details: { expectedRevision: expected, currentRevision: revision },
          },
        ),
        id,
      );
    }
    if (input.section !== undefined) {
      const known = build().sections.some((s) => s.id === input.section);
      if (!known) {
        return fail(
          err('not_found', `No menu section "${input.section}".`, {
            path: 'input.section',
          }),
          id,
        );
      }
    }
    let changed = false;
    if (input.tab && PLANNER_TAB_IDS.includes(input.tab)) {
      changed ||= currentTab() !== input.tab;
      tab.set(input.tab);
      options.navigation?.setTab(input.tab);
    }
    if (input.section !== undefined) {
      changed ||= section.get() !== input.section;
      section.set(input.section);
      options.navigation?.setSection?.(input.section);
    }
    const result: CommandResult = {
      ok: true,
      ...(id !== undefined ? { id } : {}),
      snapshot: build(),
      receipt: {
        name: 'focus',
        ...(id !== undefined ? { id } : {}),
        summary: '',
        changed,
        revisionBefore: revision,
        revisionAfter: revision,
      },
    };
    deliver();
    return result;
  }

  /** The planner's strict import check, before the engine's. */
  function prepareImport(
    raw: Record<string, unknown>,
  ): { raw: Record<string, unknown>; dropped?: string[] } | CommandResult {
    const input = raw.input;
    if (!port?.prepareImport || !isObject(input)) return { raw };
    const checked = port.prepareImport(input.document);
    if (!checked.ok) {
      return fail(
        err('invalid_input', checked.error, { path: 'input.document' }),
        raw.id as string | undefined,
      );
    }
    return {
      raw: { ...raw, input: { ...input, document: checked.cookbook } },
      dropped: checked.dropped,
    };
  }

  /**
   * Replacing a whole app needs `replace: true` unless the app holds nothing.
   * The engine checks its own copy, which can lack page customisations the app
   * has (they are edited outside the plan). Before such a command, if the app
   * holds something the engine's copy does not, adopt the app's document (same
   * revision) so the engine's own refusal, in its own order of checks, is right.
   */
  function alignForReplace(names: readonly unknown[]): void {
    if (
      !port?.read ||
      !names.some((n) => typeof n === 'string' && REPLACING.has(n))
    ) {
      return;
    }
    try {
      const app = port.read();
      if (
        isEmptyCookbook(engine.cookbook()) &&
        !isEmptyCookbook(app as never)
      ) {
        const state = engine.state();
        engine = createCookbookEngine({
          catalog,
          state: {
            version: 1,
            revision: state.revision,
            applied: resolvedApplied(),
            cookbook: app as never,
            journal: state.journal,
          },
        });
        outward = new Map();
        inward = new Map();
        lastKey = signature(app, resolvedApplied());
      }
    } catch (cause) {
      syncError = message(cause);
    }
  }

  function run(command: unknown, runOptions: RunOptions = {}): CommandResult {
    try {
      sync();
      if (syncError) {
        return syncFailure(
          isObject(command) && typeof command.id === 'string'
            ? command.id
            : undefined,
        );
      }
      if (!isObject(command)) {
        return decorate(engine.run(command, runOptions));
      }
      if (command.name === 'focus') return runFocus(command, runOptions);
      alignForReplace([command.name]);
      if (syncError) {
        return syncFailure(
          typeof command.id === 'string' ? command.id : undefined,
        );
      }
      let raw: Record<string, unknown> = command;
      let dropped: string[] | undefined;
      if (command.name === 'import_cookbook') {
        const prepared = prepareImport(command);
        if ('ok' in prepared) return prepared;
        raw = prepared.raw;
        dropped = prepared.dropped;
      }
      const appliedBefore = engine.snapshot().app.cookbook;
      const keepTheme = themeToKeep(raw);
      const result = keepTheme
        ? runKeepingTheme(raw, runOptions, keepTheme)
        : decorate(engine.run(raw, runOptions));
      if (!result.ok) return result;
      if (!result.replayed && result.receipt.changed) {
        commit([String(raw.name)], appliedBefore);
      }
      let finished = result;
      if (dropped?.length) {
        finished = {
          ...result,
          receipt: {
            ...result.receipt,
            warnings: [
              ...(result.receipt.warnings ?? []),
              ...dropped.map((note) => `Not imported: ${note}`),
            ],
          },
        };
      }
      deliver();
      return finished.ok ? { ...finished, snapshot: build() } : finished;
    } catch (cause) {
      return fail(err('failed', message(cause)));
    }
  }

  /**
   * Applying a library cookbook that sets no theme keeps the person's own look
   * (as the Cookbooks tab does): the preset, brand colour and colour scheme
   * (the font is not carried; `set_theme` has no font). Returns the patch.
   */
  function themeToKeep(
    raw: Record<string, unknown>,
  ): Record<string, unknown> | undefined {
    const input = raw.input;
    if (raw.name !== 'apply_cookbook' || !isObject(input)) return undefined;
    const book = catalog.cookbooks?.find((c) => c.id === input.id);
    if (!book || (book.document as { theme?: unknown }).theme) return undefined;
    const theme = engine.cookbook().theme;
    if (!theme) return undefined;
    const patch: Record<string, unknown> = {};
    if (theme.preset) patch.preset = theme.preset;
    if (theme.custom?.primary) patch.primary = theme.custom.primary;
    if (theme.colorScheme) patch.colorScheme = theme.colorScheme;
    return Object.keys(patch).length ? patch : undefined;
  }

  function runKeepingTheme(
    raw: Record<string, unknown>,
    runOptions: RunOptions,
    patch: Record<string, unknown>,
  ): CommandResult {
    const batch = engine.batch({
      ...(raw.id !== undefined ? { id: raw.id } : {}),
      expectedRevision: raw.expectedRevision ?? runOptions.expectedRevision,
      commands: [raw, { name: 'set_theme', input: patch }].map(
        ({ id: _id, expectedRevision: _rev, ...command }) => command,
      ),
    });
    if (!batch.ok) {
      const cause = (
        batch.error.details as { cause?: CommandError } | undefined
      )?.cause;
      return fail(
        batch.error.code === 'batch_failed' && cause ? cause : batch.error,
        raw.id as string | undefined,
      );
    }
    const first = batch.results[0];
    const undoId = batch.replayed ? undefined : undoIdOut(batch.receipt.undoId);
    return {
      ...first,
      ...(batch.id !== undefined ? { id: batch.id } : {}),
      ...(batch.replayed ? { replayed: true } : {}),
      snapshot: build(),
      receipt: {
        ...first.receipt,
        ...(batch.id !== undefined ? { id: batch.id } : {}),
        revisionBefore: batch.receipt.revisionBefore,
        revisionAfter: batch.receipt.revisionAfter,
        changed: batch.receipt.changed,
        ...(undoId ? { undoId } : {}),
      },
    } as CommandResult;
  }

  function batch(input: unknown): BatchResult {
    try {
      sync();
      if (syncError) {
        return {
          ok: false,
          error: syncFailureError(),
          snapshot: build(),
        };
      }
      const commands =
        isObject(input) && Array.isArray(input.commands) ? input.commands : [];
      alignForReplace(commands.map((c) => (isObject(c) ? c.name : undefined)));
      if (syncError) {
        return { ok: false, error: syncFailureError(), snapshot: build() };
      }
      const appliedBefore = engine.snapshot().app.cookbook;
      const result = engine.batch(input);
      if (!result.ok) {
        return { ...result, snapshot: build() } as BatchResult;
      }
      if (!result.replayed && result.receipt.changed) {
        commit(
          commands.map((c) => String((c as { name?: unknown })?.name)),
          appliedBefore,
        );
      }
      const undoId = result.replayed
        ? undefined
        : undoIdOut(result.receipt.undoId);
      const { undoId: _drop, ...receipt } = result.receipt;
      const current = build();
      const out = {
        ...result,
        snapshot: current,
        receipt: { ...receipt, ...(undoId ? { undoId } : {}) },
        results: result.results.map(
          (item) =>
            ({
              ...item,
              snapshot: result.replayed ? current : withView(item.snapshot),
            }) as Extract<CommandResult, { ok: true }>,
        ),
      } as BatchResult;
      deliver();
      return out;
    } catch (cause) {
      return {
        ok: false,
        error: err('failed', message(cause)),
        snapshot: build(),
      };
    }
  }

  function untranslate(raw: unknown): unknown {
    if (!isObject(raw) || raw.name !== 'undo' || !isObject(raw.input))
      return raw;
    const id = raw.input.undoId;
    if (typeof id !== 'string') return raw;
    return { ...raw, input: { ...raw.input, undoId: inward.get(id) ?? '' } };
  }

  /** The engine's refusal names its own undo id; say the one the caller sent. */
  function reword(result: CommandResult, given: string): CommandResult {
    if (result.ok || result.error.code !== 'not_found') return result;
    const inner = inward.get(given);
    return inner
      ? {
          ...result,
          error: {
            ...result.error,
            message: result.error.message.replace(`"${inner}"`, `"${given}"`),
          },
        }
      : result;
  }

  const runWithUndo: PlannerController['run'] = (
    command: unknown,
    runOptions?: RunOptions,
  ) => {
    // An undo id from an earlier epoch (or never issued) names nothing.
    if (
      isObject(command) &&
      command.name === 'undo' &&
      isObject(command.input)
    ) {
      const given = command.input.undoId;
      if (
        typeof given === 'string' &&
        checkSchema(undoSchema, command.input) === null
      ) {
        sync();
        build();
        if (!inward.has(given)) {
          return fail(
            err('not_found', `Nothing to undo for "${given}".`, {
              path: 'input.undoId',
            }),
            command.id as string | undefined,
          );
        }
        return reword(run(untranslate(command), runOptions), given);
      }
    }
    return run(untranslate(command), runOptions);
  };

  return {
    run: runWithUndo,
    batch,
    snapshot() {
      sync();
      return build();
    },
    cookbook() {
      sync();
      return liveDocument(engine.cookbook() as never) as never;
    },
    undo() {
      sync();
      const last = build().undo.at(-1);
      if (!last) {
        return fail(err('not_found', 'Nothing to undo.'));
      }
      return runWithUndo({ name: 'undo', input: { undoId: last } });
    },
    state: () => engine.state(),
    get tools() {
      return tools;
    },
    get batchTool() {
      return engine.batchTool;
    },
    observe() {
      sync();
      return JSON.stringify(build());
    },
    deliver,
    subscribe(listener) {
      env.watch?.start();
      sync();
      const current = build();
      listeners.set(listener, JSON.stringify(current));
      listener(current);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) env.watch?.stop();
      };
    },
  };
}
