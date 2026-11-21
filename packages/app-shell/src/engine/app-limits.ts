// Per-app caps (#5198): what one app may hold and do, enforced by the engine
// from limits the host injects (`HostOptions.appLimits`). No limits injected
// means no check and no query: the desktop is unchanged. Plan-derived values
// are the shell's job (a later slice); this file only enforces what it is given.
import { AppError } from './errors.ts';

/** Caps of one app. Every field is optional; an absent one is unlimited. */
export interface AppLimits {
  /** Most models the app may define (shipped recipe tables are not counted). */
  maxModels?: number;
  /** Most records across all the app's models. */
  maxRows?: number;
  /** Most records in any one model. */
  maxRowsPerModel?: number;
  /** Most method runs in one period; needs `methodRunPeriodMs`. */
  maxMethodRuns?: number;
  /** Length of the method-run period in ms (a rolling window from its first run). */
  methodRunPeriodMs?: number;
}

export type AppLimitName =
  | 'maxModels'
  | 'maxRows'
  | 'maxRowsPerModel'
  | 'maxMethodRuns';

/**
 * A cap refused the call. An `AppError`, so a caller sees it as the owner's
 * own mistake to act on, never a crash; the message names the cap and numbers.
 */
export class AppLimitError extends AppError {
  readonly cap: AppLimitName;
  readonly limit: number;
  readonly current: number;
  readonly requested: number;
  constructor(
    cap: AppLimitName,
    limit: number,
    current: number,
    requested: number,
    message: string,
  ) {
    super(`app limit reached (${cap}): ${message}`);
    this.name = 'AppLimitError';
    this.cap = cap;
    this.limit = limit;
    this.current = current;
    this.requested = requested;
  }
}

const NAMES = [
  'maxModels',
  'maxRows',
  'maxRowsPerModel',
  'maxMethodRuns',
  'methodRunPeriodMs',
] as const;

/** Refuse a malformed limits object before any app opens. */
export function assertAppLimits(limits: AppLimits): AppLimits {
  for (const k of NAMES) {
    const v = limits[k];
    if (v !== undefined && (!Number.isInteger(v) || v < 0))
      throw new AppError(`appLimits.${k} must be a whole number, 0 or more`);
  }
  if (limits.maxMethodRuns !== undefined && !limits.methodRunPeriodMs)
    throw new AppError(
      'appLimits.maxMethodRuns needs appLimits.methodRunPeriodMs (1 or more)',
    );
  return limits;
}

const n = (v: number) => v.toLocaleString('en-US');
const records = (v: number) => `${n(v)} record${v === 1 ? '' : 's'}`;

/** One model of the app and the table its records live in. */
export interface CapModel {
  model: string;
  label: string;
  table: string;
}

/**
 * Counting: one `COUNT(*)` per table, cached. The cache is moved by the
 * engine's own single creates and removes and dropped (`invalidate`) after
 * anything that changes rows in bulk or outside the engine's methods (a REST
 * or tool call, an import, a method, a migration), so the next check recounts.
 * That is the same query on SQLite and PostgreSQL, one per table per
 * invalidation, never a scan per write.
 */
export class AppCaps {
  readonly limits: AppLimits;
  private cache: Map<string, number> | null = null;
  private windowStart = 0;
  private runs = 0;

  private models: () => CapModel[];
  private countTable: (table: string, h: unknown) => Promise<number>;
  private clock: () => number;

  constructor(
    limits: AppLimits,
    models: () => CapModel[],
    countTable: (table: string, h: unknown) => Promise<number>,
    clock: () => number = Date.now,
  ) {
    this.limits = assertAppLimits(limits);
    this.models = models;
    this.countTable = countTable;
    this.clock = clock;
  }

  get rowsCapped() {
    return (
      this.limits.maxRows !== undefined ||
      this.limits.maxRowsPerModel !== undefined
    );
  }

  invalidate() {
    this.cache = null;
  }

  /** Records per table now; `fresh` reads through `h` and skips the cache. */
  async counts(h: unknown, fresh = false): Promise<Map<string, number>> {
    if (!fresh && this.cache) return this.cache;
    const out = new Map<string, number>();
    for (const m of this.models())
      if (!out.has(m.table))
        out.set(m.table, await this.countTable(m.table, h));
    if (!fresh) this.cache = out;
    return out;
  }

  noteAdded(model: string) {
    const t = this.models().find((m) => m.model === model)?.table;
    if (this.cache && t) this.cache.set(t, (this.cache.get(t) ?? 0) + 1);
  }

  noteRemoved(model: string) {
    const t = this.models().find((m) => m.model === model)?.table;
    if (this.cache && t)
      this.cache.set(t, Math.max(0, (this.cache.get(t) ?? 0) - 1));
  }

  /** Refuse when adding `add` (records per model) would pass a row cap. */
  async checkAdd(add: Record<string, number>, h: unknown, fresh = false) {
    if (!this.rowsCapped) return;
    const adding = Object.values(add).reduce((a, b) => a + b, 0);
    if (adding <= 0) return;
    const counts = await this.counts(h, fresh);
    const models = this.models();
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const { maxRows, maxRowsPerModel } = this.limits;
    if (maxRowsPerModel !== undefined)
      for (const [model, k] of Object.entries(add)) {
        const m = models.find((x) => x.model === model);
        const have = m ? (counts.get(m.table) ?? 0) : 0;
        if (k > 0 && have + k > maxRowsPerModel)
          throw new AppLimitError(
            'maxRowsPerModel',
            maxRowsPerModel,
            have,
            k,
            `${m?.label ?? model} holds ${records(have)} of the ${n(maxRowsPerModel)} allowed per model; adding ${n(k)} would pass the limit`,
          );
      }
    if (maxRows !== undefined && total + adding > maxRows)
      throw new AppLimitError(
        'maxRows',
        maxRows,
        total,
        adding,
        `this app holds ${records(total)} of the ${n(maxRows)} allowed; adding ${n(adding)} would pass the limit`,
      );
  }

  /**
   * After a migration's data steps (inside its transaction): refuse a result
   * over a cap that GREW the app. An app already over (a plan that shrank)
   * can still run a step that adds nothing.
   */
  async checkGrowth(before: Map<string, number>, h: unknown) {
    if (!this.rowsCapped) return;
    const after = await this.counts(h, true);
    const sum = (m: Map<string, number>) =>
      [...m.values()].reduce((a, b) => a + b, 0);
    const { maxRows, maxRowsPerModel } = this.limits;
    if (maxRowsPerModel !== undefined)
      for (const m of this.models()) {
        const a = after.get(m.table) ?? 0;
        const b = before.get(m.table) ?? 0;
        if (a > maxRowsPerModel && a > b)
          throw new AppLimitError(
            'maxRowsPerModel',
            maxRowsPerModel,
            b,
            a - b,
            `${m.label} would hold ${records(a)}, over the ${n(maxRowsPerModel)} allowed per model; nothing was changed`,
          );
      }
    if (
      maxRows !== undefined &&
      sum(after) > maxRows &&
      sum(after) > sum(before)
    )
      throw new AppLimitError(
        'maxRows',
        maxRows,
        sum(before),
        sum(after) - sum(before),
        `this app would hold ${records(sum(after))}, over the ${n(maxRows)} allowed; nothing was changed`,
      );
  }

  /** Count one method run against the period, or refuse it. */
  checkMethodRun() {
    const { maxMethodRuns, methodRunPeriodMs } = this.limits;
    if (maxMethodRuns === undefined || !methodRunPeriodMs) return;
    const t = this.clock();
    if (!this.windowStart || t - this.windowStart >= methodRunPeriodMs) {
      this.windowStart = t;
      this.runs = 0;
    }
    if (this.runs >= maxMethodRuns)
      throw new AppLimitError(
        'maxMethodRuns',
        maxMethodRuns,
        this.runs,
        1,
        `${n(this.runs)} of the ${n(maxMethodRuns)} method runs allowed in this period are used; the period renews in ${Math.ceil((this.windowStart + methodRunPeriodMs - t) / 1000)} s`,
      );
    this.runs++;
  }

  /** Refuse a model added past the cap. `prior` is the model count before. */
  checkModels(count: number, prior: number) {
    const { maxModels } = this.limits;
    if (maxModels !== undefined && count > maxModels && count > prior)
      throw new AppLimitError(
        'maxModels',
        maxModels,
        prior,
        count - prior,
        `this app has ${n(prior)} of the ${n(maxModels)} models allowed; adding ${n(count - prior)} would pass the limit`,
      );
  }
}
