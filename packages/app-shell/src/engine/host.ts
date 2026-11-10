// The host: owns the version history (through a VersionStore) and the data
// directory, and manages the user app, which runs as its own runtime in a
// worker thread. Every definition change starts a fresh app runtime from the
// new definition and swaps it in once it is ready; if it fails to start, the
// old one keeps running and the change is refused.
//
// The host touches only `dataDir`: app.db, snapshots/*.db, and the archives
// inside app.db. Plain files, no symlinks.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Command,
  type ExecuteOptions,
  isRiskyCommand,
  isRiskyTool,
  isStructuralCommand,
  overwritesOnUndo,
  type Plan,
  type Template,
} from './commands.ts';
import {
  type AppDefinition,
  builtInFields,
  describeApp,
  EMPTY_APP,
  type FieldDef,
  FORMAT,
  type MethodDef,
  type Migration,
  RECIPES,
  refuseChanges,
  restRouteAllowed,
  type Step,
  snake,
  tableFor,
  toolNamesFor,
  validate,
} from './definition.ts';
import { type DraftMarker, readDraftMarker, sameDir } from './draft.ts';
import { ApprovalRequiredError, EngineError } from './errors.ts';
import { checkSyntax } from './sandbox.ts';
import type { VersionRecord, VersionStore } from './store.ts';
import { AppCallError, AppWorker } from './worker-handle.ts';
import type { BootInfo, WorkerOp } from './worker-protocol.ts';

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export interface HostOptions {
  store: VersionStore;
  /** The worker entry. Defaults to `./app-worker.ts` or `.js` next to this module. */
  workerUrl?: URL | string;
  /**
   * Start frozen: every structural command is refused (see
   * {@link AppHost.setFrozen}). Records, reports, the app's own tools and REST
   * routes, and `exportTemplate` keep working.
   */
  frozen?: boolean;
  /**
   * Approve risky commands, `_delete` tools and REST `DELETE` without being
   * asked. For a DRAFT host only: `open` refuses it unless `dataDir` is a draft
   * directory made by `forkDraft` (it holds the engine's marker, naming a
   * different live directory). It is read once, here, into a private field:
   * there is no setter, so it cannot be turned on later or for the live host.
   */
  autoApprove?: boolean;
}

export interface ChangeResult {
  version: number;
  summary: string;
  statements: string[];
  snapshot: string | null;
  appRestartMs: number;
  affectedMethods?: string[];
  converted?: number;
  emptied?: number;
  undid?: string;
}

export interface CleanUpResult {
  purgedVersions: number[];
  values: number;
  tables: number;
  /** Old migration/schema snapshot files removed. */
  snapshots: number;
}

export type ExecuteResult = ChangeResult | CleanUpResult | Template;

export interface MethodResult {
  result: unknown;
  writes: unknown[];
  applied: number;
  snapshot: string | null;
}

export interface ToolResult {
  content: unknown;
  isError: boolean;
  structuredContent?: unknown;
}

export interface RestResult {
  status: number;
  contentType: string;
  body: string;
}

export interface VersionSummary {
  version: number;
  parent: number | null;
  author: string;
  summary: string;
  createdAt: string;
  purged: boolean;
  current: boolean;
}

/** A command, understood: what it would do, and how to do it. */
interface Analysis {
  plan: Plan;
  apply: (author: string) => Promise<ExecuteResult>;
}

function defaultWorkerUrl(): URL {
  for (const f of ['./app-worker.ts', './app-worker.js']) {
    const u = new URL(f, import.meta.url);
    if (existsSync(fileURLToPath(u))) return u;
  }
  throw new EngineError('app-worker is missing next to the engine', 'refused');
}

const MAX_TEMPLATE_RECORDS = 100_000;
/** Method code an import may carry: all of it is shown for approval. */
const MAX_REVIEW_CODE_CHARS = 200_000;
const isObj = (v: unknown): v is Row =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export class AppHost extends EventEmitter {
  def: AppDefinition = EMPTY_APP;
  version = 0;
  readonly dataDir: string;
  lastSwapMs = 0;
  private store: VersionStore;
  private workerUrl: URL | string;
  private app!: AppWorker;
  private closed = false;
  #autoApprove = false;
  private frozenNow = false;
  /** Set when this host is a draft copy (its directory holds the draft marker). */
  readonly draft: DraftMarker | null;
  /** Record/tool/REST calls currently inside the worker. */
  private inflight = 0;
  private idleWaiters: (() => void)[] = [];
  /** Changes are applied one at a time. Work inside the queue must not wait on it. */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(dataDir: string, opts: HostOptions) {
    super();
    this.dataDir = dataDir;
    this.store = opts.store;
    this.workerUrl = opts.workerUrl ?? defaultWorkerUrl();
    this.frozenNow = opts.frozen === true;
    this.#autoApprove = opts.autoApprove === true;
    this.draft = readDraftMarker(dataDir);
  }

  static async open(dataDir: string, opts: HostOptions): Promise<AppHost> {
    if (opts.autoApprove) {
      const marker = readDraftMarker(dataDir);
      if (!marker || sameDir(marker.liveDir, dataDir))
        throw new EngineError(
          'autoApprove is for draft copies only; this directory is not one',
          'refused',
        );
    }
    mkdirSync(join(dataDir, 'snapshots'), { recursive: true });
    const host = new AppHost(dataDir, opts);
    await host.boot();
    return host;
  }

  private async boot() {
    let cur = await this.store.current();
    if (cur === null) {
      await this.store.append({
        version: 0,
        parent: null,
        author: 'engine',
        summary: 'empty app',
        definition: EMPTY_APP,
        migration: null,
        createdAt: now(),
      });
      await this.store.setCurrent(0);
      cur = 0;
    }
    const rec = await this.store.get(cur);
    if (!rec)
      throw new EngineError(
        `version ${cur} is missing from the store`,
        'not_found',
      );
    const errs = validate(rec.definition);
    if (errs.length)
      throw new EngineError(
        `the stored definition is invalid: ${errs.join('; ')}`,
      );
    if (this.draft && !(await this.store.get(this.draft.baseVersion)))
      throw new EngineError(
        `the draft's base version ${this.draft.baseVersion} is missing from its store`,
        'not_found',
      );
    this.def = rec.definition;
    this.version = cur;
    this.app = this.spawn(this.def, this.version);
    await this.app.ready;
  }

  private spawn(def: AppDefinition, version: number, migration?: Migration) {
    return new AppWorker(this.workerUrl, {
      dataDir: this.dataDir,
      def,
      version,
      migration,
    });
  }

  // ---------- the change queue ----------

  private run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new EngineError('the host is closed', 'refused'));
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  /**
   * Start an app runtime on `def`; swap it in only if it comes up. With a
   * migration the old runtime is stopped first, so nothing writes while tables
   * change; if the new one fails, the migration rolled back and the old
   * definition is started again.
   */
  private async swap(
    def: AppDefinition,
    version: number,
    migration?: Migration,
  ) {
    const t0 = performance.now();
    const migrating = !!migration?.steps.length;
    if (migrating) await this.app.retire();
    const next = this.spawn(def, version, migration);
    let booted: BootInfo;
    try {
      booted = await next.ready;
    } catch (e) {
      await next.terminate();
      if (migrating) {
        this.app = this.spawn(this.def, this.version);
        await this.app.ready.catch(() => {}); // surfaced later by the dead worker
      }
      throw new EngineError(
        `the app did not start with this change, so it was not applied: ${(e as Error).message}`,
        'migration_failed',
      );
    }
    const old = this.app;
    this.app = next;
    if (!migrating) void old.retire();
    this.lastSwapMs = Math.round(performance.now() - t0);
    return { ...booted, swapMs: this.lastSwapMs };
  }

  /**
   * Swap to `next`, then persist. If persisting fails the app is put back
   * where the store still says it is.
   */
  private async transition(
    next: AppDefinition,
    nextVersion: number,
    migration: Migration | undefined,
    persist: () => Promise<void>,
  ) {
    const swapped = await this.swap(next, nextVersion, migration);
    try {
      await persist();
    } catch (e) {
      const back: Migration | undefined = migration?.steps.length
        ? {
            steps: migration.steps,
            direction: migration.direction === 'up' ? 'down' : 'up',
            version: migration.version,
          }
        : undefined;
      try {
        await this.swap(this.def, this.version, back);
      } catch {
        // restartApp() can retry; the original error is what matters
      }
      throw e;
    }
    this.def = next;
    this.version = nextVersion;
    return swapped;
  }

  /** Validate, start the new app runtime, record the version. Every change takes this path. */
  private async applyChange(
    next: AppDefinition,
    summary: string,
    author: string,
    steps: Step[] = [],
    converting = new Set<string>(),
  ): Promise<ChangeResult> {
    const errs = [
      ...validate(next),
      ...refuseChanges(this.def, next, converting),
    ];
    if (errs.length) throw new EngineError(errs.join('\n'));
    const v = (await this.store.maxVersion()) + 1;
    const parent = this.version;
    const migration: Migration | undefined = steps.length
      ? { steps, direction: 'up', version: v }
      : undefined;
    const swapped = await this.transition(next, v, migration, async () => {
      await this.store.append({
        version: v,
        parent,
        author,
        summary,
        definition: next,
        migration: steps.length ? { steps } : null,
        createdAt: now(),
      });
      await this.store.setCurrent(v);
    });
    this.emit('changed', { version: v, summary });
    return {
      version: v,
      summary,
      statements: swapped.statements,
      snapshot: swapped.snapshot,
      appRestartMs: swapped.swapMs,
    };
  }

  // ---------- commands ----------

  /** What a command would do, without changing anything. */
  plan(cmd: Command): Promise<Plan> {
    return this.run(async () => {
      this.refuseIfFrozen(cmd);
      return (await this.analyse(cmd)).plan;
    });
  }

  /** True while structural commands are refused. */
  get frozen() {
    return this.frozenNow;
  }

  /**
   * Freeze or thaw the host. Frozen, every command in `STRUCTURAL_COMMANDS`
   * (and `plan` of it) is refused with code `refused`; nothing about records
   * changes. The shell freezes the live host while a draft is open.
   */
  setFrozen(frozen: boolean) {
    this.frozenNow = frozen;
  }

  private refuseIfFrozen(cmd: { type?: unknown }) {
    if (this.frozenNow && isStructuralCommand(cmd))
      throw new EngineError(
        `the app is frozen while a draft is open, so '${String(cmd?.type)}' is refused; make the change in the draft`,
        'refused',
      );
  }

  /**
   * Apply a command. A risky one throws {@link ApprovalRequiredError} unless
   * `approved` is true, and then nothing has changed.
   */
  execute(cmd: Command, opts: ExecuteOptions): Promise<ExecuteResult> {
    if (!opts || typeof opts.author !== 'string' || !opts.author)
      return Promise.reject(new EngineError('execute needs an author'));
    return this.run(async () => {
      this.refuseIfFrozen(cmd);
      const a = await this.analyse(cmd);
      if (a.plan.risky && opts.approved !== true && !this.#autoApprove)
        throw new ApprovalRequiredError(a.plan);
      return a.apply(opts.author);
    });
  }

  private clone(): AppDefinition {
    return structuredClone(this.def);
  }

  private model(name: string) {
    if (!Object.hasOwn(this.def.models, name))
      throw new EngineError(`no model ${name}`, 'not_found');
    return this.def.models[name];
  }

  /** Where an own field of `model` is stored. */
  private storage(model: string, field: string) {
    const md = this.model(model);
    if (Object.hasOwn(builtInFields(model, md), field))
      throw new EngineError(`${model}.${field} is built in`, 'refused');
    if (!Object.hasOwn(md.fields, field))
      throw new EngineError(`no field ${model}.${field}`, 'not_found');
    return {
      table: tableFor(model, md),
      column: snake(field),
      fd: md.fields[field],
      md,
    };
  }

  /** Methods (of any model) whose code mentions `name`; their code is not rewritten. */
  private methodsMentioning(name: string): string[] {
    const re = new RegExp(`\\b${name}\\b`);
    return Object.entries(this.def.models).flatMap(([m, md]) =>
      Object.entries(md.methods ?? {})
        .filter(([, meth]) => re.test(meth.code))
        .map(([n]) => `${m}.${n}`),
    );
  }

  private async analyse(cmd: Command): Promise<Analysis> {
    const risky = isRiskyCommand(cmd);
    const change = (
      summary: string,
      d: AppDefinition,
      extra: {
        preview?: Record<string, unknown>;
        affectedMethods?: string[];
        steps?: Step[];
        converting?: Set<string>;
        after?: (r: ChangeResult) => ChangeResult;
      } = {},
    ): Analysis => ({
      plan: {
        summary,
        risky,
        ...(extra.preview ? { preview: extra.preview } : {}),
        ...(extra.affectedMethods?.length
          ? { affectedMethods: extra.affectedMethods }
          : {}),
      },
      apply: async (author) => {
        const r = await this.applyChange(
          d,
          summary,
          author,
          extra.steps,
          extra.converting,
        );
        return extra.after ? extra.after(r) : r;
      },
    });

    switch (cmd.type) {
      case 'defineModel': {
        if (Object.hasOwn(this.def.models, cmd.name))
          throw new EngineError(`${cmd.name} already exists; use addField`);
        const d = this.clone();
        d.models[cmd.name] = {
          ...(cmd.label ? { label: cmd.label } : {}),
          fields: Object.fromEntries(
            Object.entries(cmd.fields ?? {}).map(([k, v]) => [k, shown(v)]),
          ),
          methods: {},
        };
        this.assertValid(d);
        return change(`define ${cmd.name}`, d);
      }
      case 'addField': {
        const md = this.model(cmd.model);
        if (Object.hasOwn(builtInFields(cmd.model, md), cmd.field))
          throw new EngineError(
            `${cmd.model}.${cmd.field} is built in`,
            'refused',
          );
        if (md.fields[cmd.field] && !md.fields[cmd.field].hidden)
          throw new EngineError(`${cmd.model}.${cmd.field} already exists`);
        const d = this.clone();
        d.models[cmd.model].fields[cmd.field] = shown(cmd.definition);
        this.assertValid(d);
        return change(`add ${cmd.model}.${cmd.field}`, d);
      }
      case 'hideField': {
        const st = this.storage(cmd.model, cmd.field);
        if (st.fd.hidden)
          throw new EngineError(`${cmd.model}.${cmd.field} is already hidden`);
        const d = this.clone();
        d.models[cmd.model].fields[cmd.field].hidden = true;
        return change(`hide ${cmd.model}.${cmd.field}`, d);
      }
      case 'renameField': {
        const st = this.storage(cmd.model, cmd.from);
        if (
          Object.hasOwn(st.md.fields, cmd.to) ||
          Object.hasOwn(builtInFields(cmd.model, st.md), cmd.to)
        )
          throw new EngineError(`${cmd.model}.${cmd.to} already exists`);
        const d = this.clone();
        // Keep field order: rebuild the object with the new key in place.
        d.models[cmd.model].fields = Object.fromEntries(
          Object.entries(d.models[cmd.model].fields).map(([k, v]) => [
            k === cmd.from ? cmd.to : k,
            v,
          ]),
        );
        this.assertValid(d);
        return change(`rename ${cmd.model}.${cmd.from} -> ${cmd.to}`, d, {
          steps: [
            {
              op: 'renameColumn',
              table: st.table,
              from: st.column,
              to: snake(cmd.to),
            },
          ],
          affectedMethods: this.methodsMentioning(cmd.from),
          after: (r) => ({
            ...r,
            affectedMethods: this.methodsMentioning(cmd.from),
          }),
        });
      }
      case 'removeField': {
        const st = this.storage(cmd.model, cmd.field);
        const valuesArchived = await this.callApp<number>(
          'countValues',
          st.table,
          st.column,
        );
        const d = this.clone();
        delete d.models[cmd.model].fields[cmd.field];
        this.assertValid(d);
        return change(`remove ${cmd.model}.${cmd.field}`, d, {
          preview: {
            model: cmd.model,
            field: cmd.field,
            valuesArchived,
            note: 'The column is dropped; its values are archived so undo can restore them until cleanUp removes the archive.',
          },
          affectedMethods: this.methodsMentioning(cmd.field),
          steps: [
            {
              op: 'dropColumn',
              table: st.table,
              key: 'id',
              column: st.column,
              type: st.fd.type,
            },
          ],
        });
      }
      case 'changeFieldType': {
        const st = this.storage(cmd.model, cmd.field);
        const to: FieldDef = { ...st.fd, ...cmd.to, hidden: false };
        if (cmd.to.type !== 'choice' && !cmd.to.choices) delete to.choices;
        if (cmd.to.type !== 'reference' && !cmd.to.ref) delete to.ref;
        const pv = await this.callApp<{
          rows: number;
          withValue: number;
          convertible: number;
          failing: unknown[];
          failingCount: number;
        }>('previewConversion', st.table, 'id', st.column, to);
        const d = this.clone();
        d.models[cmd.model].fields[cmd.field] = shown(to);
        this.assertValid(d);
        return change(
          `change ${cmd.model}.${cmd.field} ${st.fd.type} -> ${to.type}`,
          d,
          {
            preview: {
              model: cmd.model,
              field: cmd.field,
              from: st.fd.type,
              to: to.type,
              ...pv,
              note: 'Values that do not convert become empty; all original values are archived so undo restores them.',
            },
            affectedMethods: this.methodsMentioning(cmd.field),
            steps: [
              {
                op: 'convertColumn',
                table: st.table,
                key: 'id',
                column: st.column,
                from: st.fd,
                to,
              },
            ],
            converting: new Set([`${cmd.model}.${cmd.field}`]),
            after: (r) => ({
              ...r,
              converted: pv.convertible,
              emptied: pv.failingCount,
            }),
          },
        );
      }
      case 'removeModel': {
        const md = this.model(cmd.model);
        if (md.extends)
          throw new EngineError(
            `${cmd.model} belongs to a recipe; its table is shared with the shipped model`,
            'refused',
          );
        const table = tableFor(cmd.model, md);
        const rows = await this.callApp<number>('countRows', table);
        const d = this.clone();
        delete d.models[cmd.model];
        this.assertValid(d);
        return change(`remove model ${cmd.model}`, d, {
          preview: {
            model: cmd.model,
            rows,
            note: 'The table is moved aside (renamed), not deleted, so undo restores it until cleanUp removes it.',
          },
          steps: [
            {
              op: 'archiveTable',
              table,
              archivedAs: `_archived_${table}_${Date.now()}`,
            },
          ],
        });
      }
      case 'addMethod': {
        this.model(cmd.model);
        const problem = await checkSyntax(cmd.method?.code ?? '');
        if (problem) throw new EngineError(`method does not parse: ${problem}`);
        const d = this.clone();
        const existed = !!d.models[cmd.model].methods?.[cmd.name];
        d.models[cmd.model].methods ??= {};
        (d.models[cmd.model].methods as Record<string, MethodDef>)[cmd.name] =
          cmd.method;
        this.assertValid(d);
        return change(
          `${existed ? 'replace' : 'add'} method ${cmd.model}.${cmd.name}()`,
          d,
          {
            preview: {
              model: cmd.model,
              method: cmd.name,
              description: cmd.method.description,
              params: cmd.method.params ?? {},
              code: cmd.method.code,
            },
          },
        );
      }
      case 'enableRecipe': {
        const recipe = Object.hasOwn(RECIPES, cmd.recipe)
          ? RECIPES[cmd.recipe]
          : undefined;
        if (!recipe) throw new EngineError(`unknown recipe '${cmd.recipe}'`);
        if (this.def.recipes.includes(cmd.recipe))
          throw new EngineError(`${cmd.recipe} is already on`);
        const d = this.clone();
        for (const [name, rm] of Object.entries(recipe.models)) {
          if (d.models[name]) throw new EngineError(`${name} already exists`);
          // The app-subclass rule: an empty app model extending the shipped one.
          d.models[name] = {
            label: name,
            extends: rm.parent,
            fields: {},
            methods: {},
          };
        }
        d.recipes.push(cmd.recipe);
        this.assertValid(d);
        return change(`enable ${cmd.recipe}`, d);
      }
      case 'undo':
        return this.analyseUndo(cmd.version);
      case 'cleanUp':
        return this.analyseCleanUp(cmd.keep);
      case 'exportTemplate':
        return {
          plan: { summary: 'export the app as a template', risky: false },
          apply: () => this.exportTemplate(!!cmd.includeRecords),
        };
      case 'importTemplate':
        return this.analyseImport(cmd.data, risky);
      default:
        throw new EngineError(
          `unknown command ${(cmd as { type?: string }).type}`,
        );
    }
  }

  private assertValid(d: AppDefinition) {
    const errs = validate(d);
    if (errs.length) throw new EngineError(errs.join('\n'));
  }

  private async analyseUndo(pin?: number): Promise<Analysis> {
    const rec = await this.store.get(this.version);
    if (!rec || rec.parent == null)
      throw new EngineError('nothing to undo', 'refused');
    if (pin !== undefined && pin !== rec.version)
      throw new EngineError(
        `the app has changed since this undo was asked for (now at version ${rec.version}); ask again`,
        'refused',
      );
    if (rec.migration?.purged)
      throw new EngineError(
        `can't undo "${rec.summary}": its archived data was cleaned up`,
        'refused',
      );
    const parent = await this.store.get(rec.parent);
    if (!parent)
      throw new EngineError(`version ${rec.parent} is missing`, 'not_found');
    // Undo is the safety net, so it is immediate, except where going back
    // overwrites newer data: a convertColumn step restores each row's original
    // value, replacing whatever was written to that column since. Decided here
    // from the stored version, never from the caller.
    const steps = rec.migration?.steps ?? [];
    const converts = steps.filter(overwritesOnUndo);
    const risky = converts.length > 0;
    let preview: Record<string, unknown> = {
      version: rec.version,
      steps: steps.length,
    };
    if (risky) {
      const counts = await this.callApp<
        { table: string; column: string; replaced: number }[]
      >('countOverwrites', rec.version, steps);
      const fields = counts.map((c) => {
        const where = this.locate(rec.definition, c.table, c.column);
        return { ...where, rows: c.replaced };
      });
      preview = {
        ...preview,
        fields,
        replaced: fields.reduce((n, f) => n + f.rows, 0),
        note: 'Going back restores the original value of every row in these fields. Values written since the type change are replaced.',
      };
    }
    return {
      plan: {
        summary: `undo: ${rec.summary}`,
        risky,
        preview,
      },
      apply: async () => {
        const migration: Migration | undefined = rec.migration?.steps.length
          ? {
              steps: rec.migration.steps,
              direction: 'down',
              version: rec.version,
            }
          : undefined;
        const swapped = await this.transition(
          parent.definition,
          parent.version,
          migration,
          () => this.store.setCurrent(parent.version),
        );
        const summary = `undo: ${rec.summary}`;
        this.emit('changed', { version: parent.version, summary });
        return {
          version: parent.version,
          summary,
          undid: rec.summary,
          statements: swapped.statements,
          snapshot: swapped.snapshot,
          appRestartMs: swapped.swapMs,
        };
      },
    };
  }

  /** The model and field stored in `table.column` under `def`. */
  private locate(def: AppDefinition, table: string, column: string) {
    for (const [model, md] of Object.entries(def.models))
      if (tableFor(model, md) === table)
        for (const f of Object.keys(md.fields))
          if (snake(f) === column) return { model, field: f };
    return { model: table, field: column };
  }

  /** The chain from the current version back to the root, newest first. */
  private async chain(): Promise<VersionRecord[]> {
    const out: VersionRecord[] = [];
    let v: number | null = this.version;
    while (v != null) {
      const r = await this.store.get(v);
      if (!r) break;
      out.push(r);
      v = r.parent;
    }
    return out;
  }

  private async analyseCleanUp(keep: number): Promise<Analysis> {
    if (!Number.isInteger(keep) || keep < 0)
      throw new EngineError('keep must be a whole number, zero or more');
    const chain = await this.chain();
    const old = chain
      .slice(keep)
      .filter((r) => r.migration?.steps.length && !r.migration.purged);
    const versions = old.map((r) => r.version);
    const tables = old.flatMap((r) =>
      (r.migration?.steps ?? []).flatMap((s) =>
        s.op === 'archiveTable' ? [s.archivedAs] : [],
      ),
    );
    const counts = await this.callApp<{ values: number; tables: number }>(
      'countArchives',
      versions,
      tables,
    );
    // Snapshots taken before the newest purged change belong to changes that
    // can no longer be undone.
    const cutoff = Date.parse(chain[keep]?.createdAt ?? '');
    return {
      plan: {
        summary: `clean up: keep the last ${keep} changes undoable`,
        risky: true,
        preview: {
          versions,
          archivedValues: counts.values,
          archivedTables: counts.tables,
          note: 'Those changes can no longer be undone.',
        },
      },
      apply: async () => {
        const purged = await this.callApp<{ values: number; tables: number }>(
          'purgeArchives',
          versions,
          tables,
        );
        for (const v of versions) await this.store.markPurged(v);
        const snapshots = Number.isFinite(cutoff)
          ? await this.callApp<number>('pruneSnapshots', cutoff)
          : 0;
        return { purgedVersions: versions, ...purged, snapshots };
      },
    };
  }

  // ---------- templates ----------

  private async exportTemplate(includeRecords: boolean): Promise<Template> {
    const out: Template = {
      format: FORMAT,
      exportedAt: now(),
      definition: this.def,
    };
    if (includeRecords) {
      const records: Record<string, Row[]> = {};
      for (const m of Object.keys(this.def.models))
        records[m] = await this.callApp<Row[]>('list', m, MAX_TEMPLATE_RECORDS);
      out.records = records;
    }
    return structuredClone(out);
  }

  private async analyseImport(
    data: Template,
    risky: boolean,
  ): Promise<Analysis> {
    if (!isObj(data) || data.format !== FORMAT)
      throw new EngineError(
        `unknown template format '${String((data as unknown as Row)?.format)}'`,
      );
    const errs = validate(data.definition);
    if (errs.length)
      throw new EngineError(`the template is invalid: ${errs.join('; ')}`);
    if (this.version !== 0 || Object.keys(this.def.models).length)
      throw new EngineError('import needs an empty app', 'refused');
    const def = structuredClone(data.definition);
    // The approval shows every method in full: what is approved is what runs.
    const methods: {
      model: string;
      name: string;
      description: string;
      params: Record<string, unknown>;
      code: string;
    }[] = [];
    let codeChars = 0;
    for (const [m, md] of Object.entries(def.models))
      for (const [n, meth] of Object.entries(md.methods ?? {})) {
        const problem = await checkSyntax(meth.code);
        if (problem)
          throw new EngineError(`${m}.${n}() does not parse: ${problem}`);
        codeChars += meth.code.length;
        methods.push({
          model: m,
          name: n,
          description: meth.description,
          params: meth.params ?? {},
          code: meth.code,
        });
      }
    if (codeChars > MAX_REVIEW_CODE_CHARS)
      throw new EngineError(
        `the template carries too much code to review (${codeChars} characters, at most ${MAX_REVIEW_CODE_CHARS}); import it in smaller parts`,
        'refused',
      );
    let records: Record<string, Row[]> | undefined;
    let total = 0;
    if (data.records !== undefined) {
      if (!isObj(data.records))
        throw new EngineError('template records must be an object');
      records = {};
      for (const [m, rows] of Object.entries(data.records)) {
        if (
          !Object.hasOwn(def.models, m) ||
          !Array.isArray(rows) ||
          rows.some((r) => !isObj(r))
        )
          throw new EngineError(`template records for '${m}' are not valid`);
        total += rows.length;
        records[m] = rows as Row[];
      }
      if (total > MAX_TEMPLATE_RECORDS)
        throw new EngineError('the template has too many records');
    }
    return {
      plan: {
        summary: 'import template',
        risky,
        preview: { models: Object.keys(def.models), methods, records: total },
      },
      apply: async (author) => {
        const r = await this.applyChange(def, 'import template', author);
        if (records && total) {
          await this.callApp('importRecords', records);
          this.emit('records', { model: null });
        }
        return r;
      },
    };
  }

  // ---------- the running app ----------

  /** Talk to the app. Callers inside the change queue use this; others use onApp. */
  private async callApp<T>(op: WorkerOp, ...args: unknown[]): Promise<T> {
    try {
      return await this.app.call<T>(op, ...args);
    } catch (e) {
      if (e instanceof AppCallError) {
        if (e.user) throw new EngineError(e.message, 'invalid');
        throw new EngineError(e.message, 'refused');
      }
      throw e;
    }
  }

  private async onApp<T>(op: WorkerOp, ...args: unknown[]): Promise<T> {
    // Never talk to an app that is being replaced: wait until the queue is
    // idle AND no change was queued while waiting. The check and the call below
    // run in one synchronous step, so no change can start in between.
    for (;;) {
      const q = this.queue;
      await q;
      if (q === this.queue) break;
    }
    if (this.closed) throw new EngineError('the host is closed', 'refused');
    this.inflight++;
    try {
      return await this.callApp<T>(op, ...args);
    } finally {
      if (--this.inflight === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const w of waiters) w();
      }
    }
  }

  list(model: string, limit = 200) {
    return this.onApp<Row[]>('list', model, limit);
  }
  get(model: string, id: string) {
    return this.onApp<Row>('get', model, id);
  }
  async create(model: string, data: Row) {
    const r = await this.onApp<Row>('create', model, data);
    this.emit('records', { model });
    return r;
  }
  async update(model: string, id: string, data: Row) {
    const r = await this.onApp<Row>('update', model, id, data);
    this.emit('records', { model });
    return r;
  }
  async remove(model: string, id: string) {
    const r = await this.onApp<{ deleted: string }>('remove', model, id);
    this.emit('records', { model });
    return r;
  }

  async runMethod(
    model: string,
    method: string,
    id: string | null = null,
    params: Row = {},
  ) {
    const out = await this.onApp<MethodResult>(
      'runMethod',
      model,
      method,
      id,
      params,
    );
    if (out.applied) this.emit('records', { model });
    return out;
  }

  /** The app's own generated MCP tools. */
  appTools() {
    return this.onApp<
      { name: string; description?: string; inputSchema?: unknown }[]
    >('tools');
  }

  /** Call one of the app's generated tools. A delete needs `approved: true`. */
  async callAppTool(
    name: string,
    args: Row = {},
    opts: { approved?: boolean } = {},
  ) {
    if (isRiskyTool(name) && opts.approved !== true && !this.#autoApprove)
      throw new ApprovalRequiredError({
        summary: `call ${name}`,
        risky: true,
        preview: { tool: name, args },
      });
    const r = await this.onApp<ToolResult>('callTool', name, args);
    if (!r.isError) {
      const model =
        Object.entries(this.def.models).find(([m, md]) =>
          toolNamesFor(m, md).includes(name),
        )?.[0] ?? null;
      this.emit('records', { model });
    }
    return r;
  }

  /** The worker's generated REST routes, passed through. A DELETE needs `approved: true`. */
  async rest(
    req: { method: string; url: string; body?: string },
    opts: { approved?: boolean } = {},
  ) {
    const method = req.method.toUpperCase();
    // Only the app's own collection routes are served (see restRouteAllowed);
    // checked before the gate so a reserved route is never even an approval.
    if (!restRouteAllowed(this.def, req.url))
      return {
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Not found' }),
      } satisfies RestResult;
    if (method === 'DELETE' && opts.approved !== true && !this.#autoApprove)
      throw new ApprovalRequiredError({
        summary: `DELETE ${req.url}`,
        risky: true,
        preview: { method, url: req.url },
      });
    const r = await this.onApp<RestResult>('rest', { ...req, method });
    if (method !== 'GET' && method !== 'HEAD' && r.status < 400)
      this.emit('records', { model: null });
    return r;
  }

  describe() {
    return describeApp(this.def, this.version);
  }

  async versions(): Promise<VersionSummary[]> {
    return (await this.store.list()).map((r) => ({
      version: r.version,
      parent: r.parent,
      author: r.author,
      summary: r.summary,
      createdAt: r.createdAt,
      purged: !!r.migration?.purged,
      current: r.version === this.version,
    }));
  }

  /** Restart the app runtime on the same definition (e.g. after a crash). */
  restartApp() {
    return this.run(async () => {
      const s = await this.swap(this.def, this.version);
      this.emit('changed', { version: this.version, summary: 'app restarted' });
      return { appRestartMs: s.swapMs };
    });
  }

  /** Stop the app thread as a crash would. For tests and for the shell's own watchdogs. */
  async killApp() {
    await this.app.terminate();
  }

  get appAlive() {
    return this.app.alive;
  }

  async close() {
    await this.queue;
    this.closed = true;
    await this.app.terminate();
  }
}

/** A field as stored in the definition: visible unless hidden is set later. */
function shown(fd: FieldDef): FieldDef {
  const { hidden: _hidden, ...rest } = fd;
  return rest;
}
