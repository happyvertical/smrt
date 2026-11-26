import { createHash, randomUUID } from 'node:crypto';
// The host: owns the version history (through a VersionStore) and the data
// directory, and manages the user app, which runs as its own runtime in a
// worker thread. Every definition change starts a fresh app runtime from the
// new definition and swaps it in once it is ready; if it fails to start, the
// old one keeps running and the change is refused.
//
// The host touches only `dataDir`: app.db, snapshots/*.db, and the archives
// inside app.db. Plain files, no symlinks.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseRuntimeReportSpec,
  type RuntimeReportSpec,
} from '@happyvertical/smrt-reports';
import type { AppLimits } from './app-limits.ts';
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
import { assertLoadBounds, type LoadPreview } from './data-migrations.ts';
import {
  type AppClaim,
  acquireAppOwnership,
  assertDatabaseConfig,
  type ClaimOptions,
  claimAppDatabase,
  copySuffix,
  type DatabaseConfig,
  dialectFor,
  type EngineDialect,
  type HostDatabase,
  SQLITE,
  sideSchemaName,
  withSchemaAdmin,
} from './db/index.ts';
import {
  acquireOwnership,
  awaitFenceHolders,
  DEFAULT_LOCK_TIMEOUT_MS,
  deleteMeta,
  dropSchema,
  forkSchema,
  holdFence,
  listSideSchemas,
  markPublished,
  readDumpHeader,
  readMeta,
  readPublished,
  restoreDump,
  revokeSchema,
  type SqlDatabase,
  schemaExists,
  swapSchemas,
  writeMeta,
} from './db/postgres-copy.ts';
import { assertSchemaName, isSideSchema } from './db/schema-name.ts';
import {
  type AppDefinition,
  builtInFields,
  describeApp,
  EMPTY_APP,
  type FieldDef,
  FORMAT,
  isValidFieldName,
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
import {
  fieldDependents,
  rewriteExpression,
  rewriteReports,
} from './dependents.ts';
import {
  checkDraftPath,
  type DraftMarker,
  readDraftMarker,
  removeDraftDirectory,
  sameDir,
  writeDraftMarker,
} from './draft.ts';
import {
  ApprovalRequiredError,
  CapacityError,
  ClaimLostError,
  EngineError,
  NoPrincipalError,
  PermissionDeniedError,
  StaleFenceError,
} from './errors.ts';
import type { ExtractPreview } from './extract-model.ts';
import { WORKBOOK_LOOKUP, WORKBOOK_ROW } from './import-bookkeeping.ts';
import type { MergePreview } from './merge-records.ts';
import {
  introducedCode,
  METHOD_CODE_DENIED,
  type MethodCodeGate,
  methodCodeMessage,
  methodCodeTarget,
} from './method-code.ts';
import {
  type EnginePrincipal,
  mintSystemPrincipal,
  requireOwnerPrincipal,
  requirePrincipal,
  tenantFor,
} from './principal.ts';
import {
  archivedTables,
  assertNoAside,
  canonical,
  chainDigest,
  type DefinitionDiff,
  type DraftChain,
  diffDefinitions,
  dropAside,
  listMethods,
  makeRehearsalDir,
  moveAside,
  type PublishJournal,
  type PublishMethod,
  publishHappened,
  readJournal,
  reconcilePublish,
  removeJournal,
  removeRehearsal,
  restoreAside,
  writeJournal,
} from './publish.ts';
import {
  type AppReportResult,
  type ReportOptions,
  titleField,
} from './reports.ts';
import { checkSyntax } from './sandbox.ts';
import { resolveSnapshot } from './snapshots.ts';
import type { VersionRecord, VersionStore } from './store.ts';
import { AppCallError, AppWorker, type WorkerLimits } from './worker-handle.ts';
import type { BootInfo, WorkerOp } from './worker-protocol.ts';

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();

export interface HostOptions {
  store: VersionStore;
  /**
   * The tenant of the app (#5188). Every call into the app carries a principal
   * of this tenant and a call for another is refused, on every backend. The
   * shell sets it from the holder: the tenant in cloud, and on the desktop the
   * installation's one tenant (the store's pin). Default: the desktop tenant.
   */
  tenantId?: string;
  /** The worker entry. Defaults to `./app-worker.ts` or `.js` next to this module. */
  workerUrl?: URL | string;
  /**
   * V8 memory limits of each app worker thread. Default: a 16 MiB young
   * generation and a 512 MiB old generation (see `DEFAULT_WORKER_LIMITS`).
   */
  workerLimits?: WorkerLimits;
  /**
   * Per-app caps (#5198): models, records, method runs. A call over a cap is
   * refused with an `AppLimitError` message naming the cap and the numbers.
   * Absent: unlimited, as on the desktop.
   */
  appLimits?: AppLimits;
  /**
   * Whether the app's tenant may run app-authored method code (#5194). Asked
   * on the host before each call that would run method code and before a
   * change that adds or changes it; refused without a "yes". Absent: allowed
   * with no lookup (the desktop). A draft forked from this host inherits it.
   */
  methodCode?: MethodCodeGate;
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
  /**
   * The database the app runs on (see `DatabaseConfig`). Default: SQLite in
   * `dataDir`, as the desktop does. A PostgreSQL config needs its schema; one
   * without it refuses to open. The host owns a PGlite client it was given
   * only in the sense of serving it to workers: closing it stays the caller's.
   */
  database?: DatabaseConfig;
  /**
   * PostgreSQL only: how long a schema swap (publish, snapshot restore) waits
   * for another session's lock on the app's tables before it gives up and
   * changes nothing. Default 5000 ms.
   */
  swapLockTimeoutMs?: number;
  /**
   * PostgreSQL server only (#5470): bounds of the claim's transactions and its
   * heartbeat. Defaults: 5 s lock wait, 10 s statement, 10 s idle in a
   * transaction, a heartbeat every 5 s.
   */
  claimOptions?: ClaimOptions;
  /**
   * Tests only: a claim over an in-process PGlite (see `unprovenClaim`) in
   * place of the one a PostgreSQL server host makes itself. Production PGlite
   * hosts have none. On a DRAFT host: the live host's claim, lent (#5486): the
   * draft's change and undo store writes run on it, and the draft never
   * releases it.
   */
  claim?: AppClaim;
  /**
   * Allow a claimed LIVE host whose version store cannot commit inside the
   * claim's transaction (it has no `commitIn`). Refused otherwise, since such a
   * store could not be fenced. For tests and for the portable import's
   * throwaway start-up, which has no shell store.
   */
  allowUnfencedStore?: boolean;
}

/**
 * Where a copy of the live data sits while it is worked on: a directory's
 * `app.db` (SQLite) or a schema of the live app's database (PostgreSQL).
 */
interface CopyPlace {
  dir: string;
  /** PostgreSQL: the copy's own database config (same server, its own schema). */
  database?: DatabaseConfig;
}

const schemaOf = (c: DatabaseConfig) => (c.kind === 'sqlite' ? '' : c.schema);

export interface ForkDraftOptions {
  /**
   * The new draft's version store, EMPTY. `forkDraft` seeds it with a copy of
   * the live current version (the draft's BASE record, same version number)
   * and points `current` at it; every draft version after that has a higher
   * number. The base record is not a draft version.
   */
  store: VersionStore;
}

/** Where a publish is, for `PublishOptions.onStage` (tests inject failures there). */
export type PublishStage =
  | 'copied'
  | 'rehearsed'
  | 'snapshotted'
  | 'journaled'
  | 'retired'
  | 'moved-aside'
  | 'swapped'
  | 'respawned'
  | 'committed';

export interface PublishDataStep {
  op: 'loadRecords' | 'extractModel' | 'mergeRecords';
  model: string;
  mode?: 'insert' | 'upsert';
  counts: Record<string, unknown>;
}

export interface PublishVersionPreview {
  /** The number this version gets in live. */
  version: number;
  /** Its number in the draft. */
  draftVersion: number;
  author: string;
  summary: string;
  steps: Step[];
  dataSteps?: PublishDataStep[];
  /** The SQL the rehearsal ran for it. */
  statements: string[];
}

/** What a publish would do, from a rehearsal on a fresh copy of the current live data. */
export interface PublishPreview {
  /** Pass this as `PublishOptions.expect`; publish refuses if the draft's chain no longer matches. */
  digest: string;
  risky: true;
  fromVersion: number;
  toVersion: number;
  versions: PublishVersionPreview[];
  /** Recorded column renames, resolved against each command's definitions. */
  fieldRenames?: {
    model: string;
    from: string;
    to: string;
    fromLabel: string;
    toLabel: string;
  }[];
  /** Live's current definition against the draft's final one. */
  definition: DefinitionDiff;
  /** Archived values and tables the changes create (what undo restores from). */
  archives: { values: number; tables: number };
  /** EVERY method of the final definition, in full, marked added/changed/unchanged. */
  methods: PublishMethod[];
}

export interface PublishOptions {
  author: string;
  /** Required: a publish is always risky. Only the shell's approval sets it. */
  approved?: boolean;
  /** The `digest` of the preview the owner saw. */
  expect: string;
  /** Tags the history summaries: "[draft: <name>] <summary>". */
  draftName?: string;
  /**
   * Called after each stage; throwing aborts and rolls back as if that stage
   * had failed. For tests. After `committed` the publish is final: errors are ignored.
   */
  onStage?: (stage: PublishStage) => void | Promise<void>;
}

export interface PublishResult {
  /** The version live is on now. */
  version: number;
  /** The versions the publish added, oldest first. */
  versions: number[];
  summary: string;
  /** The retained copy of the data as it was before (snapshots/…-migrate-prepublish.db). */
  snapshot: string;
  archives: { values: number; tables: number };
  appRestartMs: number;
}

export interface ChangeResult {
  version: number;
  summary: string;
  statements: string[];
  snapshot: string | null;
  appRestartMs: number;
  affectedMethods?: string[];
  loadCounts?: LoadPreview;
  skipped?: number;
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

/**
 * The split worker bundle (`tools/bundle-worker.mjs`, #5213): next to the
 * compiled engine or in the source tree (tests). Absent until built.
 * It is the package's `worker-bundle/`, outside `dist/`: never published.
 * A host whose engine copy is inlined in its own build passes `near`, the
 * published `engine/worker` URL, to find the package's `dist/`.
 */
export function bundledWorkerUrl(
  near: URL | string = import.meta.url,
): URL | null {
  for (const f of [
    '../../worker-bundle/app-worker.js', // dist/engine/ and src/engine/ alike
  ]) {
    const u = new URL(f, near);
    if (existsSync(fileURLToPath(u))) return u;
  }
  return null;
}

/** `SMRT_APP_SHELL_WORKER=bundle` selects the bundled worker (a host's `workerUrl` wins). */
export function wantsBundledWorker(): boolean {
  return process.env.SMRT_APP_SHELL_WORKER === 'bundle';
}

function defaultWorkerUrl(): URL {
  if (wantsBundledWorker()) {
    const bundled = bundledWorkerUrl();
    if (!bundled)
      throw new EngineError(
        'SMRT_APP_SHELL_WORKER=bundle but the worker bundle is not built (run the package build)',
        'refused',
      );
    return bundled;
  }
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

/** `_app_meta` keys of a claimed host's change journal (#5486). */
const CHANGE_KEY = 'change';
const APPLIED_KEY = 'applied';
const REVERSED_KEY = 'reversed';

/**
 * What a claimed host writes before it changes the app (#5486): which change
 * this is, so a reopen can finish it (roll the store forward) or say it never
 * landed. `committed` is set by the change's own store transaction.
 */
interface ChangeKey {
  id: string;
  from: number;
  to: number;
  /** The forward change's version record; null for an undo step. */
  record: VersionRecord | null;
  /** The approval that asked for it, when it ran under one. */
  request: string | null;
  /** Step `index` of `of` when the change is one step of an `undoTo`. */
  part?: { index: number; of: number };
  committed?: boolean;
  /**
   * What a reopen decided, kept (with the key) until the shell has settled the
   * approval that asked for it (`acknowledgeRecovery`): a failed open or a
   * stopped process in between must not lose the outcome.
   */
  decided?: 'applied' | 'not-applied';
}

/** What the reopen decided about the change an earlier host left in flight. */
export interface RecoveredChange {
  id: string;
  request: string | null;
  outcome: 'applied' | 'not-applied';
  /** One step of a longer undo: the outcome says nothing about the whole of it. */
  partial: boolean;
}

const UNKNOWN_CHANGE =
  'this host lost its claim on the app while a change was running, so whether the change took effect is unknown; reopen the app and check before repeating it.';

/** Did the server itself answer (a SQLSTATE that is not a connection failure)? */
function serverAnswered(e: unknown): boolean {
  const code = String((e as { code?: unknown } | undefined)?.code ?? '');
  return /^[0-9A-Z]{5}$/.test(code) && !/^(08|57P)/.test(code);
}

export class AppHost extends EventEmitter {
  def: AppDefinition = EMPTY_APP;
  version = 0;
  readonly dataDir: string;
  /** The tenant of the app (#5188): the only tenant a call's principal may name. */
  readonly tenantId: string;
  /** The engine's own authority in this tenant; never leaves this class. */
  readonly #system: EnginePrincipal;
  lastSwapMs = 0;
  private store: VersionStore;
  private workerUrl: URL | string;
  private workerLimits: WorkerLimits | undefined;
  private appLimits: AppLimits | undefined;
  private methodCode: MethodCodeGate | undefined;
  private database: DatabaseConfig;
  private dialect: EngineDialect;
  private releaseDatabase?: () => Promise<void>;
  /** PostgreSQL server: the claim this live host's swap and store commits run on (#5470). */
  private claim?: AppClaim;
  /** A draft host: the live host's claim, lent for its store writes; never released here (#5486). */
  private borrowed?: AppClaim;
  private unlisten?: () => void;
  private claimLost: Error | null = null;
  /** The approval a running command was asked under (the queue runs one at a time; #5486). */
  private currentRequest: string | null = null;
  /** The step of an `undoTo` that is running (journaled with its change). */
  private currentPart: { index: number; of: number } | null = null;
  /** What boot decided about a change an earlier host left in flight; the shell settles its approval. */
  recoveredChange: RecoveredChange | null = null;
  /** `changed`, emitted once the host is open and its owner can listen (a rolled-forward change). */
  private recoveredEvent: { version: number; summary: string } | null = null;
  private readonly allowUnfencedStore: boolean;
  /**
   * What the chosen database cannot do yet, said plainly, for the shell to
   * show the owner (and a publish whose journal could not be marked finished).
   * Empty: PostgreSQL has every undo point SQLite has (#5187).
   */
  readonly notices: string[] = [];
  private lockTimeoutMs: number;
  private app!: AppWorker;
  private closed = false;
  #autoApprove = false;
  private frozenNow = false;
  /** What boot did about an interrupted publish: `rolled-back` put the old data back. */
  recovery: 'none' | 'rolled-forward' | 'rolled-back' = 'none';
  /** Set when this host is a draft copy (its directory holds the draft marker). */
  readonly draft: DraftMarker | null;
  /** Record/tool/REST calls currently inside the worker (see {@link drainInflight}). */
  private inflight = 0;
  private idleWaiters: (() => void)[] = [];
  /** Changes are applied one at a time. Work inside the queue must not wait on it. */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    dataDir: string,
    opts: HostOptions,
    database: HostDatabase,
    borrowed?: AppClaim,
  ) {
    super();
    this.dataDir = dataDir;
    this.tenantId = tenantFor(opts.tenantId, database.config.kind);
    this.#system = mintSystemPrincipal(this.tenantId);
    this.database = database.config;
    this.dialect = dialectFor(database.config);
    this.releaseDatabase = database.release;
    this.claim = database.claim;
    this.allowUnfencedStore = opts.allowUnfencedStore === true;
    this.claim?.onLost((e) => this.loseClaim(e));
    this.borrowed = borrowed;
    this.unlisten = this.borrowed?.onLost((e) => this.loseClaim(e));
    this.lockTimeoutMs = opts.swapLockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.store = opts.store;
    this.workerUrl = opts.workerUrl ?? defaultWorkerUrl();
    this.workerLimits = opts.workerLimits;
    // The method-run window belongs to the host, not to a worker: a swap must
    // not renew the period. Always this host's own (a draft does not share live's).
    this.appLimits = opts.appLimits && {
      ...opts.appLimits,
      methodRunState: new Float64Array(new SharedArrayBuffer(16)),
    };
    this.methodCode = opts.methodCode;
    this.frozenNow = opts.frozen === true;
    this.#autoApprove = opts.autoApprove === true;
    this.draft = readDraftMarker(dataDir);
  }

  static async open(dataDir: string, opts: HostOptions): Promise<AppHost> {
    // 0 turns lock_timeout off (a dump or swap would wait forever); a fraction
    // floors to 0 and a negative or NaN makes the server refuse the setting.
    // Refuse before anything is opened or claimed.
    const lockMs = opts.swapLockTimeoutMs;
    if (lockMs !== undefined && (!Number.isInteger(lockMs) || lockMs < 1))
      throw new EngineError(
        'swapLockTimeoutMs must be a whole number of ms, 1 or more',
        'refused',
      );
    if (opts.autoApprove) {
      const marker = readDraftMarker(dataDir);
      if (!marker || sameDir(marker.liveDir, dataDir))
        throw new EngineError(
          'autoApprove is for draft copies only; this directory is not one',
          'refused',
        );
    }
    mkdirSync(join(dataDir, 'snapshots'), { recursive: true });
    if (opts.database) assertDatabaseConfig(opts.database);
    let config: DatabaseConfig = opts.database ?? SQLITE;
    // A draft on PostgreSQL lives in a schema of its own, named in its marker:
    // the caller passes the live app's config, the schema comes from here.
    const marker = readDraftMarker(dataDir);
    if (marker?.schema) {
      if (config.kind === 'sqlite')
        throw new EngineError(
          "this draft lives on PostgreSQL; open it with the live app's database config",
          'refused',
        );
      if (
        !marker.liveSchema ||
        marker.liveSchema !== config.schema ||
        !isSideSchema(marker.schema, marker.liveSchema, 'd')
      )
        throw new EngineError(
          `the draft marker in ${dataDir} names ${marker.schema}, which is not a draft schema of ${config.schema}; not trusting it`,
          'refused',
        );
      config = { ...config, schema: assertSchemaName(marker.schema) };
    } else if (marker && config.kind !== 'sqlite')
      throw new EngineError(
        'this draft is a SQLite copy; it cannot open on PostgreSQL',
        'refused',
      );
    // A live host owns its app's side schemas (start-up recovery and the sweep
    // drop them): claim the app before anything is touched, so a second host
    // on the same schema refuses instead of dropping the first one's copies.
    // A draft lives in a schema of its own and is claimed by its live host.
    const claim = marker
      ? undefined
      : (opts.claim ??
        (await claimAppDatabase(config, {
          // The swap and the drops wait up to the host's lock timeout; the
          // claim's own statement limit must not cut that wait short.
          lockTimeoutMs: opts.swapLockTimeoutMs,
          statementTimeoutMs: Math.max(
            10_000,
            (opts.swapLockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS) + 5_000,
          ),
          ...opts.claimOptions,
        })));
    const database: HostDatabase = {
      config,
      release: claim ? () => claim.release() : undefined,
      claim,
    };
    let made: AppHost | undefined;
    try {
      const host = new AppHost(
        dataDir,
        opts,
        database,
        marker ? opts.claim : undefined,
      );
      made = host;
      await host.boot();
      const recovered = host.recoveredEvent;
      host.recoveredEvent = null;
      if (recovered) setImmediate(() => host.emit('changed', recovered));
      return host;
    } catch (e) {
      // A draft that never opened must not stay subscribed to the lent claim.
      made?.unlisten?.();
      await claim?.release();
      throw e;
    }
  }

  private async boot() {
    // PostgreSQL: take ownership first (#5190). Advancing the generation
    // fences every worker of an earlier host, so nothing of theirs can commit
    // while this start-up recovers, sweeps and opens the app.
    // With a claim (#5470) every step here is a claim transaction, so a host
    // whose claim died bumps and drops nothing.
    if (this.claim) await this.checkClaimedStore();
    // A live host bumps on its own claim; a draft on the live host's lent one
    // (#5486): either way a host without a claim bumps and drops nothing.
    const fence = this.fenceClaim
      ? await acquireOwnership(
          this.fenceClaim.admin,
          schemaOf(this.database),
          this.lockTimeoutMs,
        )
      : await acquireAppOwnership(this.database, this.lockTimeoutMs);
    if (fence !== undefined)
      this.database = { ...this.database, fence } as DatabaseConfig;
    let cur = await this.store.current();
    // Finish or undo a publish a crash interrupted, before the app opens. On
    // PostgreSQL the schemas are put right first, while the journal still
    // says what was going on. A boot-time undo moves the store's current
    // version, so it is read again.
    const journal = readJournal(this.dataDir);
    let atomicOutcome: 'rolled-forward' | 'rolled-back' | null = null;
    if (journal?.pg) {
      const r = await this.reconcilePgPublish(journal, cur);
      cur = r.current;
      atomicOutcome = r.atomic;
    }
    this.recovery = reconcilePublish(this.dataDir, cur);
    if (atomicOutcome) this.recovery = atomicOutcome;
    // A change an earlier host left between its migration and its store write.
    if (this.fenced) cur = await this.reconcileChange(cur);
    // A crash outside the journal's window (a rehearsal or a restore that
    // never got to swap) leaves a side schema: drop the app's own.
    if (this.onServer && !this.draft) await this.sweepSideSchemas();
    if (cur === null) {
      const seed: VersionRecord = {
        version: 0,
        parent: null,
        author: 'engine',
        summary: 'empty app',
        definition: EMPTY_APP,
        migration: null,
        createdAt: now(),
      };
      if (this.fenced) {
        // The first version is a store write like any other: under the claim.
        const schema = schemaOf(this.database);
        await (this.fenceClaim as AppClaim).transaction(async (tx) => {
          await holdFence(tx, schema, this.fence as number);
          await this.store.commitIn?.(tx, [seed], 0, null);
        });
      } else {
        await this.store.append(seed);
        await this.store.setCurrent(0);
      }
      cur = 0;
    }
    const rec = await this.store.get(cur);
    if (!rec)
      throw new EngineError(
        `version ${cur} is missing from the store`,
        'not_found',
      );
    const errs = validate(rec.definition, rec.definition);
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

  /**
   * Settle the change an earlier host of this app left in flight (#5486), by
   * its journal alone, in one claim transaction. Returns the store's current
   * version after it.
   * - `committed`: it landed. Nothing to write.
   * - `applied` is its id, and the store and the data's version are where the
   *   change started and ended: its migration committed but the store write
   *   never did, so the store rolls forward.
   * - no `applied` and the data and the store are both at its start: it never
   *   landed.
   * - anything else: left as it is, with a notice.
   * The journal is removed either way (a fork or a snapshot copies it).
   */
  private async reconcileChange(cur: number | null): Promise<number | null> {
    const schema = schemaOf(this.database);
    const store = this.store;
    let current = cur;
    let outcome: 'applied' | 'not-applied' | 'undecided' | null = null;
    let found: ChangeKey | null = null;
    let forward = false;
    await (this.fenceClaim as AppClaim).transaction(async (tx) => {
      await holdFence(tx, schema, this.fence as number);
      const meta = await readMeta(tx, schema, [
        CHANGE_KEY,
        APPLIED_KEY,
        REVERSED_KEY,
        'version',
      ]);
      if (meta[CHANGE_KEY] === undefined) {
        await deleteMeta(tx, schema, [APPLIED_KEY, REVERSED_KEY]);
        return;
      }
      try {
        found = JSON.parse(meta[CHANGE_KEY]) as ChangeKey;
      } catch {
        found = null;
      }
      const data = meta.version === undefined ? null : Number(meta.version);
      if (!found) outcome = 'undecided';
      else if (found.decided) outcome = found.decided;
      else if (found.committed) outcome = 'applied';
      else if (meta[REVERSED_KEY] === found.id) outcome = 'not-applied';
      else if (
        meta[APPLIED_KEY] === found.id &&
        found.from === cur &&
        data === found.to
      ) {
        await store.commitIn?.(
          tx,
          found.record ? [found.record] : [],
          found.to,
          found.from,
        );
        current = found.to;
        forward = true;
        outcome = 'applied';
      } else if (
        meta[APPLIED_KEY] !== found.id &&
        data === found.from &&
        cur === found.from
      )
        outcome = 'not-applied';
      else outcome = 'undecided';
      const f = found as ChangeKey | null;
      if (f?.request && (outcome === 'applied' || outcome === 'not-applied')) {
        // Decided for an approval: keep the journal until it is acknowledged.
        await writeMeta(
          tx,
          schema,
          CHANGE_KEY,
          JSON.stringify({ ...f, decided: outcome }),
        );
        await deleteMeta(tx, schema, [APPLIED_KEY, REVERSED_KEY]);
      } else
        await deleteMeta(tx, schema, [CHANGE_KEY, APPLIED_KEY, REVERSED_KEY]);
    });
    if (outcome === 'undecided')
      this.notices.push(
        'A change was running when this app last stopped and could not be settled either way; check the version history.',
      );
    const f = found as ChangeKey | null;
    if (f?.request && (outcome === 'applied' || outcome === 'not-applied'))
      this.recoveredChange = {
        id: f.id,
        request: f.request,
        outcome,
        // The last step landing, or the first not landing, decides the whole undo.
        partial:
          !!f.part &&
          !(outcome === 'applied' && f.part.index === f.part.of - 1) &&
          !(outcome === 'not-applied' && f.part.index === 0),
      };
    if (forward && f)
      this.recoveredEvent = {
        version: f.to,
        summary: f.record?.summary ?? 'recovered change',
      };
    return current;
  }

  /**
   * The shell settled the approval of `recoveredChange` (or found nothing to
   * settle): drop the journal that kept its outcome (#5486). A failure leaves
   * it for the next open, which settles again.
   */
  async acknowledgeRecovery(id: string): Promise<void> {
    if (!this.fenced || this.claimLost) return;
    const schema = schemaOf(this.database);
    await (this.fenceClaim as AppClaim).transaction(async (tx) => {
      await holdFence(tx, schema, this.fence as number);
      const raw = (await readMeta(tx, schema, [CHANGE_KEY]))[CHANGE_KEY];
      try {
        const k = raw ? (JSON.parse(raw) as ChangeKey) : null;
        if (k?.id === id && k.decided)
          await deleteMeta(tx, schema, [CHANGE_KEY]);
      } catch {
        /* an unreadable journal is the next open's notice */
      }
    });
    if (this.recoveredChange?.id === id) this.recoveredChange = null;
  }

  /** Connections parked by `retireApp` for the next worker; see there. */
  private spare: (() => void) | null = null;

  private spawn(def: AppDefinition, version: number, migration?: Migration) {
    const worker = new AppWorker(this.workerUrl, {
      tenantId: this.tenantId,
      dataDir: this.dataDir,
      def,
      version,
      migration,
      limits: this.workerLimits,
      appLimits: this.appLimits,
      database: this.database,
      lockTimeoutMs: this.lockTimeoutMs,
      ...(this.spare ? { reservation: this.spare } : {}),
    });
    this.spare = null; // taken over: the new worker returns it when it exits
    return worker;
  }

  /**
   * Stop the app worker for a replacement, keeping its pool's share of the
   * connection budget (#5464): between the retire and the respawn nothing else
   * on the server can take it, so the replacement (or the rollback to the old
   * app) cannot be refused for lack of connections and leave no worker.
   */
  private async retireApp() {
    this.keepBudget(this.app);
    await this.app.retire();
  }

  /** Park the connections of `w` (about to be stopped) for the next worker. */
  private keepBudget(w: AppWorker | undefined) {
    if (w) this.spare ??= w.surrenderBudget();
  }

  /** Give back connections parked for a worker that will not come. */
  private releaseSpare() {
    const r = this.spare;
    this.spare = null;
    r?.();
  }

  // ---------- the change queue ----------

  private run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new EngineError('the host is closed', 'refused'));
    if (this.claimLost) return Promise.reject(this.claimLost);
    // Re-check when the work starts: a discard or close that ran ahead of this
    // item on the queue must refuse it, not let it restart a worker on the
    // removed directory (#5122).
    const guarded = () =>
      this.closed
        ? Promise.reject(new EngineError('the host is closed', 'refused'))
        : this.claimLost
          ? Promise.reject(this.claimLost)
          : fn();
    const p = this.queue.then(guarded, guarded);
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
    /**
     * A claimed host's change in flight (#5486): `change` is the forward
     * swap's intent id; `reverse` marks the change's own reverse. In flight a
     * lost claim or an unknown outcome never respawns the old worker.
     */
    flight?: { change?: string; reverse?: boolean },
  ) {
    const t0 = performance.now();
    const migrating = !!migration?.steps.length;
    if (migrating) await this.retireApp();
    let next: AppWorker | undefined;
    let booted: BootInfo;
    try {
      next = this.spawn(def, version, migration);
      booted = await next.ready;
      if (flight?.change && this.claimLost) {
        // The claim died while the new worker booted: it must not serve.
        await next.terminate().catch(() => {});
        throw await this.abandonChange();
      }
    } catch (e) {
      if (e instanceof ClaimLostError && e.details?.outcome === 'unknown')
        throw e;
      let respawn = true;
      // The reverse never boots the old worker on data it could not put back.
      let unknown = !!flight?.reverse;
      try {
        if (next) {
          this.keepBudget(next);
          await next.terminate();
        }
        if (migrating) {
          if (flight?.reverse) respawn = false;
          else if (flight?.change) {
            // #5486: did the migration commit? Bump the generation (waiting
            // for its transaction) and read; only "no" is safe to respawn on.
            respawn = !this.claimLost && (await this.notApplied(flight.change));
            unknown = !respawn;
          }
          if (respawn) {
            this.app = this.spawn(this.def, this.version);
            await this.app.ready.catch(() => {});
            this.app.settleBudget();
          }
        } else if (flight?.change && !this.claimLost) {
          // No steps: the old worker never stopped, so no bump. But the new
          // worker's boot may have committed with its reply lost: wait for it
          // to end and read what it left.
          unknown = !(await this.notCommitted(flight.change));
        }
      } finally {
        this.releaseSpare();
      }
      if (unknown || (flight && this.claimLost))
        throw await this.abandonChange(e);
      if (e instanceof CapacityError) throw e;
      if (
        e instanceof EngineError &&
        (e.code === 'refused' || e.code === 'stale_fence')
      )
        throw e;
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
    /** The records the store commits with this change; a claimed host (#5486) writes them under its claim. */
    records?: VersionRecord[],
  ) {
    if (this.fenced && records)
      return this.transitionClaimed(next, nextVersion, migration, records);
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

  /**
   * A change on a claimed host (#5486). S = the store's current version, D =
   * the data's version, g = this host's generation.
   *   P0  claim tx: proof, fence = g, compare S = p, write `change`.
   *   M   the worker's migration (g-fenced; a migrating one also writes `applied`).
   *   T_c claim tx: proof, fence = g, record the version and move S p -> v.
   * A host that dies between M and T_c leaves D = v, S = p: the next open
   * reads `change` and `applied` and rolls the store forward (`reconcileChange`).
   * From P0 on, a lost claim or an unknown outcome stops the host (it never
   * respawns an old worker on data that may have moved) and says so.
   */
  private async transitionClaimed(
    next: AppDefinition,
    nextVersion: number,
    migration: Migration | undefined,
    records: VersionRecord[],
  ) {
    const claim = this.fenceClaim as AppClaim;
    const store = this.store;
    const schema = schemaOf(this.database);
    const from = this.version;
    const change: ChangeKey = {
      id: randomUUID(),
      from,
      to: nextVersion,
      record: records[0] ?? null,
      request: this.currentRequest,
      ...(this.currentPart ? { part: this.currentPart } : {}),
    };
    await claim.transaction(async (tx) => {
      await holdFence(tx, schema, this.fence as number);
      // A decided outcome nobody has acknowledged yet must not be overwritten.
      const prior = (await readMeta(tx, schema, [CHANGE_KEY]))[CHANGE_KEY];
      let unsettled: ChangeKey | null = null;
      try {
        const k = prior ? (JSON.parse(prior) as ChangeKey) : null;
        if (k?.decided) unsettled = k;
      } catch {
        /* an unreadable journal is overwritten as before */
      }
      if (unsettled)
        throw new EngineError(
          `an earlier interrupted change${unsettled.request ? ` (approval ${unsettled.request})` : ''} has not been settled yet; reopen the app`,
          'refused',
        );
      await store.commitIn?.(tx, [], from, from);
      await writeMeta(tx, schema, CHANGE_KEY, JSON.stringify(change));
    });
    const migrating = !!migration?.steps.length;
    // Every claimed change journals `applied` in its worker's boot transaction
    // (one with the migration's steps and the version), steps or not.
    const swapped = await this.swap(
      next,
      nextVersion,
      {
        steps: [],
        direction: 'up',
        version: nextVersion,
        ...migration,
        intent: change.id,
      },
      { change: change.id },
    );
    let done = false;
    try {
      await claim.transaction(async (tx) => {
        await holdFence(tx, schema, this.fence as number);
        await store.commitIn?.(tx, records, nextVersion, from);
        await writeMeta(
          tx,
          schema,
          CHANGE_KEY,
          JSON.stringify({ ...change, committed: true }),
        );
        done = true;
      });
    } catch (e) {
      // Refused (no COMMIT sent) or answered by the server (rolled back), with
      // the claim still proven: nothing committed and nobody else can have
      // moved the app, so the migration is reversed under the same claim.
      // Anything else (a lost claim, a reply that never came) is unknown.
      const proven = !claim.lost;
      if (!proven || (done && !serverAnswered(e)))
        throw await this.abandonChange(e);
      const back: Migration = {
        steps: migration?.steps ?? [],
        direction: migration?.direction === 'up' ? 'down' : 'up',
        version: migration?.version ?? nextVersion,
        intent: change.id,
        reverse: true,
      };
      await this.swap(this.def, this.version, back, { reverse: true });
      throw e;
    }
    this.def = next;
    this.version = nextVersion;
    return swapped;
  }

  /**
   * Did the in-flight migration of change `id` commit? Takes ownership (bumps
   * the generation, which waits for any transaction of the migration still
   * open and fences it out) and reads `applied` in that same transaction, so
   * the answer is final. True only for "no", with the new generation adopted;
   * an error or "yes" means the old worker must not come back.
   */
  private async notApplied(id: string): Promise<boolean> {
    const claim = this.fenceClaim;
    if (!claim) return false;
    try {
      const schema = schemaOf(this.database);
      let applied = false;
      const fence = await acquireOwnership(
        claim.admin,
        schema,
        this.lockTimeoutMs,
        async (tx) => {
          applied =
            (await readMeta(tx, schema, [APPLIED_KEY]))[APPLIED_KEY] === id;
        },
      );
      this.database = { ...this.database, fence } as DatabaseConfig;
      return !applied;
    } catch {
      return false;
    }
  }

  /** A swap with no steps failed: did its boot commit anyway? True only for a definite "no". */
  private async notCommitted(id: string): Promise<boolean> {
    const claim = this.fenceClaim;
    if (!claim) return false;
    try {
      const schema = schemaOf(this.database);
      return await claim.transaction(async (tx) => {
        await awaitFenceHolders(tx, schema);
        return (await readMeta(tx, schema, [APPLIED_KEY]))[APPLIED_KEY] !== id;
      });
    } catch {
      return false;
    }
  }

  /**
   * A change of this host has an unknown outcome (or the claim died under
   * it): stop serving, end the claim's session (so nothing of it can still
   * commit) and tell the caller. The next open settles what happened.
   */
  private async abandonChange(cause?: unknown): Promise<ClaimLostError> {
    const unknown = new ClaimLostError(UNKNOWN_CHANGE, { outcome: 'unknown' });
    unknown.cause = cause;
    if (!this.claimLost) {
      this.claimLost = new ClaimLostError(
        'this host stopped serving the app after a change whose outcome is unknown; reopen the app. This call wrote nothing.',
      );
      this.emit('claim-lost', this.claimLost);
    }
    await this.app?.terminate().catch(() => {});
    await this.claim?.release().catch(() => {});
    return unknown;
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
      ...validate(next, this.def),
      ...refuseChanges(this.def, next, converting, (t) =>
        this.dialect.columnType(t),
      ),
    ];
    if (errs.length) throw new EngineError(errs.join('\n'));
    await this.requireMethodCodeFor(this.def, next);
    const v = (await this.store.maxVersion()) + 1;
    const parent = this.version;
    const migration: Migration | undefined = steps.length
      ? { steps, direction: 'up', version: v }
      : undefined;
    const record: VersionRecord = {
      version: v,
      parent,
      author,
      summary,
      definition: next,
      migration: steps.length ? { steps } : null,
      createdAt: now(),
    };
    const swapped = await this.transition(
      next,
      v,
      migration,
      async () => {
        await this.store.append(record);
        await this.store.setCurrent(v);
      },
      [record],
    );
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
    try {
      if (cmd.type === 'loadRecords') assertLoadBounds(cmd);
      cmd = structuredClone(cmd);
    } catch (e) {
      return Promise.reject(e);
    }
    return this.run(async () => {
      this.refuseIfFrozen(cmd);
      await this.drainInflight();
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

  /**
   * Repair tables a workbook import left with its bookkeeping columns
   * (`workbookRow`, `workbookLookup`) required: records the owner adds have no
   * workbook row, so Add and Edit failed. Loosens only those flags, as
   * ordinary versioned conversions (nothing is emptied, undo restores them),
   * and keeps a hidden field hidden. Nothing happens on a draft or a frozen
   * host (a draft's base version must not move); the shell calls it again once
   * live thaws. Returns how many fields were repaired.
   */
  repairLegacyImport(): Promise<number> {
    if (this.draft || this.frozenNow) return Promise.resolve(0);
    return this.run(async () => {
      if (this.frozenNow) return 0;
      await this.drainInflight();
      let repaired = 0;
      for (const [model, md] of Object.entries(this.def.models)) {
        if (md.extends) continue;
        for (const field of [WORKBOOK_ROW, WORKBOOK_LOOKUP]) {
          const fd = this.def.models[model].fields[field];
          if (!fd?.required || fd.calculated) continue;
          const hidden = !!fd.hidden;
          await (
            await this.analyse({
              type: 'changeFieldType',
              model,
              field,
              to: { type: fd.type, required: false },
            })
          ).apply('engine');
          if (hidden)
            await (
              await this.analyse({ type: 'hideField', model, field })
            ).apply('engine');
          repaired++;
        }
      }
      return repaired;
    });
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
  execute(
    principal: EnginePrincipal,
    cmd: Command,
    opts: ExecuteOptions,
  ): Promise<ExecuteResult> {
    try {
      // First: nothing is cloned, queued or read for a caller who may not.
      requireOwnerPrincipal(principal, this.tenantId);
      if (cmd.type === 'loadRecords') assertLoadBounds(cmd);
      cmd = structuredClone(cmd);
    } catch (e) {
      return Promise.reject(e);
    }
    opts = { ...opts };
    if (!opts || typeof opts.author !== 'string' || !opts.author)
      return Promise.reject(new EngineError('execute needs an author'));
    return this.run(async () => {
      this.refuseIfFrozen(cmd);
      await this.drainInflight();
      const a = await this.analyse(cmd);
      if (a.plan.risky && opts.approved !== true && !this.#autoApprove)
        throw new ApprovalRequiredError(a.plan);
      if (
        opts.reviewedPreview &&
        [
          'loadRecords',
          'extractModel',
          'mergeRecords',
          'setCalculation',
          'removeField',
          'changeFieldType',
        ].includes(cmd.type)
      ) {
        const grew = (current: unknown, reviewed: unknown): boolean => {
          if (typeof current === 'number')
            return current > (typeof reviewed === 'number' ? reviewed : 0);
          if (!current || typeof current !== 'object' || Array.isArray(current))
            return false;
          return Object.entries(current).some(([key, value]) =>
            grew(
              value,
              reviewed && typeof reviewed === 'object'
                ? (reviewed as Record<string, unknown>)[key]
                : undefined,
            ),
          );
        };
        const keys =
          cmd.type === 'loadRecords'
            ? ['insert', 'update']
            : cmd.type === 'extractModel'
              ? ['rows', 'create', 'matched', 'distinct', 'folded']
              : cmd.type === 'mergeRecords'
                ? ['removed', 'references']
                : cmd.type === 'removeField'
                  ? ['valuesArchived']
                  : ['rows', 'withValue', 'convertible', 'failingCount'];
        if (
          keys.some((key) =>
            grew(a.plan.preview?.[key], opts.reviewedPreview?.[key]),
          )
        )
          throw new ApprovalRequiredError(a.plan);
      }
      this.currentRequest = opts.request ?? null;
      try {
        return await a.apply(opts.author);
      } finally {
        this.currentRequest = null;
      }
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
      case 'mergeRecords': {
        const preview = await this.callApp<MergePreview>('previewMerge', cmd);
        return change(
          `merge ${cmd.merge.length} ${cmd.model} records into ${cmd.keep}`,
          this.clone(),
          {
            preview: { ...preview },
            steps: [{ op: 'mergeRecords', command: structuredClone(cmd) }],
          },
        );
      }
      case 'extractModel': {
        const st = this.storage(cmd.model, cmd.field);
        if (
          st.fd.hidden ||
          st.fd.calculated ||
          !['text', 'choice'].includes(st.fd.type) ||
          cmd.into === cmd.model
        )
          throw new EngineError(
            'extractModel needs a visible writable text or choice field and a different target model',
          );
        this.refuseDependents(cmd.model, cmd.field);
        const d = this.clone();
        const title =
          cmd.titleField ??
          (d.models[cmd.into] ? titleField(d, cmd.into) : 'name');
        if (!title) throw new EngineError('extract target needs a title field');
        if (!d.models[cmd.into])
          d.models[cmd.into] = {
            titleField: title,
            fields: { [title]: { type: 'text', required: true } },
          };
        d.models[cmd.model].fields[cmd.field] = {
          type: 'reference',
          ref: cmd.into,
          label: st.fd.label,
          required: st.fd.required,
        };
        this.assertValid(d);
        const command = { ...cmd, titleField: title };
        const preview = await this.callApp<ExtractPreview>(
          'previewExtract',
          command,
        );
        return change(`extract ${cmd.model}.${cmd.field} into ${cmd.into}`, d, {
          preview: { ...preview },
          steps: [
            { op: 'extractModel', command, from: st.fd, seed: randomUUID() },
          ],
        });
      }
      case 'loadRecords': {
        const preview = await this.callApp<LoadPreview>('previewLoad', cmd);
        if (preview.rejected)
          throw new EngineError(
            `loadRecords rejected ${preview.rejected} rows; no rows loaded: ${preview.problems.map((p) => `row ${p.row + 1}${p.field ? ` ${p.field}` : ''}: ${p.reason}`).join('; ')}`,
          );
        const a = change(
          `load ${cmd.rows.length} ${cmd.model} records`,
          this.clone(),
          {
            preview: { ...preview },
            after: (r) => ({ ...r, loadCounts: preview }),
            steps: [
              {
                op: 'loadRecords',
                command: structuredClone(cmd),
                seed: randomUUID(),
                maxUpdates: preview.update,
              },
            ],
          },
        );
        a.plan.risky = true;
        return a;
      }
      case 'defineReport': {
        if (!isValidFieldName(cmd.name))
          throw new EngineError('invalid report name');
        const d = this.clone();
        d.reports ??= {};
        d.reports[cmd.name] = cmd.definition;
        this.assertValid(d);
        const compiled = await this.callApp<{ spec: RuntimeReportSpec }>(
          'compileReport',
          cmd.definition.spec,
        );
        d.reports[cmd.name] = { ...cmd.definition, spec: compiled.spec };
        return change(`define report ${cmd.name}`, d);
      }
      case 'renameReport': {
        if (!isValidFieldName(cmd.to))
          throw new EngineError('invalid report name');
        if (!Object.hasOwn(this.def.reports ?? {}, cmd.from))
          throw new EngineError('unknown report');
        if (Object.hasOwn(this.def.reports ?? {}, cmd.to))
          throw new EngineError('report already exists');
        const d = this.clone();
        const reports = d.reports ?? {};
        reports[cmd.to] = reports[cmd.from];
        delete reports[cmd.from];
        this.assertValid(d);
        return change(`rename report ${cmd.from} -> ${cmd.to}`, d);
      }
      case 'removeReport': {
        if (!Object.hasOwn(this.def.reports ?? {}, cmd.name))
          throw new EngineError('unknown report');
        const d = this.clone();
        delete d.reports?.[cmd.name];
        return change(`remove report ${cmd.name}`, d);
      }
      case 'defineModel': {
        if (Object.hasOwn(this.def.models, cmd.name))
          throw new EngineError(`${cmd.name} already exists; use addField`);
        const d = this.clone();
        d.models[cmd.name] = {
          ...(cmd.label ? { label: cmd.label } : {}),
          ...(cmd.titleField ? { titleField: cmd.titleField } : {}),
          fields: Object.fromEntries(
            Object.entries(cmd.fields ?? {}).map(([k, v]) => [k, shown(v)]),
          ),
          methods: {},
        };
        this.assertValid(d);
        const steps: Step[] = [];
        let overwrite = false;
        for (const [field, fd] of Object.entries(d.models[cmd.name].fields)) {
          if (!fd.calculated) continue;
          const step = await this.calculationStep(
            tableFor(cmd.name),
            field,
            fd,
          );
          steps.push(step);
          overwrite ||= !!step.from;
        }
        const a = change(`define ${cmd.name}`, d, { steps });
        a.plan.risky ||= overwrite;
        return a;
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
        const step = cmd.definition.calculated
          ? await this.calculationStep(
              tableFor(cmd.model, md),
              cmd.field,
              cmd.definition,
              md.fields[cmd.field],
            )
          : undefined;
        const a = change(`add ${cmd.model}.${cmd.field}`, d, {
          steps: step ? [step] : [],
        });
        a.plan.risky ||= !!step?.from;
        return a;
      }
      case 'setCalculation': {
        const st = this.storage(cmd.model, cmd.field);
        if (st.fd.hidden || (cmd.calculated === null && !st.fd.calculated))
          throw new EngineError(
            'setCalculation needs a visible field with a calculation to clear',
          );
        const d = this.clone();
        if (cmd.calculated === null)
          delete d.models[cmd.model].fields[cmd.field].calculated;
        else d.models[cmd.model].fields[cmd.field].calculated = cmd.calculated;
        this.assertValid(d);
        const a = change(`set calculation ${cmd.model}.${cmd.field}`, d, {
          steps: [
            {
              op: 'calculation',
              table: st.table,
              column: st.column,
              from: st.fd,
              to: d.models[cmd.model].fields[cmd.field],
            },
          ],
          preview: {
            model: cmd.model,
            field: cmd.field,
            rows: await this.callApp<number>('countRows', st.table),
            withValue: await this.callApp<number>(
              'countValues',
              st.table,
              st.column,
            ),
            from: st.fd.calculated ?? null,
            to: cmd.calculated,
          },
        });
        a.plan.risky = true;
        return a;
      }
      case 'hideField': {
        const st = this.storage(cmd.model, cmd.field);
        this.refuseDependents(cmd.model, cmd.field);
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
        for (const fd of Object.values(d.models[cmd.model].fields))
          if (fd.calculated)
            fd.calculated = rewriteExpression(fd.calculated, cmd.from, cmd.to);
        if (d.models[cmd.model].titleField === cmd.from)
          d.models[cmd.model].titleField = cmd.to;
        rewriteReports(d, cmd.model, cmd.from, cmd.to);
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
        this.refuseDependents(cmd.model, cmd.field);
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
            st.fd.calculated
              ? { op: 'calculation', table: st.table, column: st.column }
              : {
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
        this.refuseDependents(cmd.model, cmd.field);
        const to: FieldDef = { ...st.fd, ...cmd.to, hidden: false };
        if (cmd.to.type !== 'choice' && !cmd.to.choices) delete to.choices;
        if (cmd.to.type !== 'reference' && !cmd.to.ref) delete to.ref;
        if (cmd.to.type !== 'money' && cmd.to.money === undefined)
          delete to.money;
        if (st.fd.calculated) {
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
                valuesArchived: 0,
                rows: await this.callApp<number>('countRows', st.table),
                withValue: await this.callApp<number>(
                  'countValues',
                  st.table,
                  st.column,
                ),
                note: 'The generated column is replaced; its values are derived.',
              },
              steps: [
                {
                  op: 'calculation',
                  table: st.table,
                  column: st.column,
                  from: st.fd,
                  to,
                },
              ],
              converting: new Set([`${cmd.model}.${cmd.field}`]),
              affectedMethods: this.methodsMentioning(cmd.field),
            },
          );
        }
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
        // Before the parser: unentitled code never reaches QuickJS here.
        if (this.methodCode)
          await this.requireMethodCode(`${cmd.model}.${cmd.name}()`);
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
      case 'undoTo':
        return this.analyseUndoTo(cmd.version, cmd.from);
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

  private async calculationStep(
    table: string,
    field: string,
    to: FieldDef,
    previous?: FieldDef,
  ): Promise<Extract<Step, { op: 'calculation' }>> {
    const info = await this.callApp<{
      type: string;
      generated: boolean;
    } | null>('columnInfo', table, snake(field));
    const { storageFamily, columnType } = this.dialect;
    if (info && storageFamily(info.type) !== storageFamily(columnType(to.type)))
      throw new EngineError(
        'existing column has a different storage family; change its type explicitly',
      );
    const family = info ? storageFamily(info.type) : '';
    const from: FieldDef | undefined =
      info && !info.generated
        ? (previous ?? {
            type:
              family === 'integer'
                ? 'integer'
                : family === 'real'
                  ? 'number'
                  : family === 'date'
                    ? 'date'
                    : family === 'boolean'
                      ? 'boolean'
                      : family === 'json'
                        ? 'json'
                        : 'text',
          })
        : undefined;
    return {
      op: 'calculation',
      table,
      column: snake(field),
      ...(from ? { from } : {}),
      to,
    };
  }

  private refuseDependents(model: string, field: string) {
    const deps = fieldDependents(this.def, model, field);
    if (deps.length)
      throw new EngineError(
        `${model}.${field} is used by: ${deps.join(', ')}`,
        'refused',
      );
  }

  private assertValid(d: AppDefinition) {
    const errs = validate(d, this.def);
    if (errs.length) throw new EngineError(errs.join('\n'));
  }

  private async analyseUndo(pin?: number): Promise<Analysis> {
    // The base of a draft is a live version: its archives are live's, not this copy's.
    if (this.draft && this.version === this.draft.baseVersion)
      throw new EngineError('nothing to undo in the draft', 'refused');
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
      undoKinds: this.undoKinds(rec),
      ...(await this.callApp<Record<string, unknown>>(
        'previewUndo',
        rec.version,
        steps,
        parent.definition,
      )),
    };
    if (risky) {
      const counts = await this.callApp<
        {
          table: string;
          column: string;
          replaced: number;
          originals?: number;
        }[]
      >('countOverwrites', rec.version, steps);
      const fields = counts.map((c) => {
        const where = this.locate(rec.definition, c.table, c.column);
        return { ...where, rows: c.replaced };
      });
      preview = {
        ...preview,
        fields,
        undoKinds: this.undoKinds(rec, counts),
        replaced: fields.reduce((n, f) => n + f.rows, 0),
        note: 'Undo restores archived values in the listed fields, removes command-created records and recreates records removed by a merge. Data-command undo refuses later edits to those fields, deleted rows and reused ids; other fields keep later edits. Restoring a cleared calculation refuses later edits to its writable values. Type conversions can replace newer values in the converted field.',
      };
    }
    return {
      plan: {
        summary: `undo: ${rec.summary}`,
        risky,
        preview,
      },
      apply: async () => {
        // Undo can bring back code a later version removed: same rule as a change.
        await this.requireMethodCodeFor(this.def, parent.definition);
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
          [],
        );
        const summary = `undo: ${rec.summary}${swapped.skipped ? `; skipped ${swapped.skipped} deleted referring records` : ''}`;
        this.emit('changed', { version: parent.version, summary });
        return {
          version: parent.version,
          summary,
          undid: rec.summary,
          ...(swapped.skipped ? { skipped: swapped.skipped } : {}),
          statements: swapped.statements,
          snapshot: swapped.snapshot,
          appRestartMs: swapped.swapMs,
        };
      },
    };
  }

  /**
   * Undo back to `target`: the same step as `undo`, repeated newest first, as
   * one command with one decision. Each step is its own consistent state (its
   * own swap and store write), so a failure part-way leaves the app at the
   * version it had reached, and says so.
   */
  private async analyseUndoTo(
    target: number,
    from?: number,
  ): Promise<Analysis> {
    if (!Number.isInteger(target))
      throw new EngineError('undoTo needs a version number');
    if (from !== undefined && from !== this.version)
      throw new EngineError(
        `the app has changed since this undo was asked for (now at version ${this.version}); ask again`,
        'refused',
      );
    if (target === this.version)
      throw new EngineError(
        `the app is already at version ${target}`,
        'refused',
      );
    const chain = await this.chain(); // newest first
    const at = chain.findIndex((r) => r.version === target);
    if (at < 0)
      throw new EngineError(
        `version ${target} is not in the history leading to version ${this.version}`,
        'refused',
      );
    if (this.draft && target < this.draft.baseVersion)
      throw new EngineError(
        'the draft cannot go back past its base',
        'refused',
      );
    const undone = chain.slice(0, at); // newest first
    const purged = undone.find((r) => r.migration?.purged);
    if (purged)
      throw new EngineError(
        `can't undo "${purged.summary}": its archived data was cleaned up`,
        'refused',
      );
    const converting = undone.filter((r) =>
      r.migration?.steps.some(overwritesOnUndo),
    );
    let preview: Record<string, unknown> = {
      to: target,
      versions: undone.map((r) => ({ version: r.version, summary: r.summary })),
      undoKinds: undone.flatMap((r) => this.undoKinds(r)),
      ...(await this.callApp<Record<string, unknown>>(
        'previewUndo',
        undone[0]?.version,
        undone[0]?.migration?.steps ?? [],
        chain[1]?.definition ?? this.def,
      )),
    };
    if (converting.length) {
      const fields: { model: string; field: string; rows: number }[] = [];
      const undoKinds: Record<string, unknown>[] = [];
      for (const r of converting) {
        const counts = await this.callApp<
          {
            table: string;
            column: string;
            replaced: number;
            originals?: number;
          }[]
        >('countOverwrites', r.version, r.migration?.steps ?? []);
        undoKinds.push(...this.undoKinds(r, counts));
        for (const c of counts)
          fields.push({
            ...this.locate(r.definition, c.table, c.column),
            rows: c.replaced,
          });
      }
      preview = {
        ...preview,
        fields,
        undoKinds,
        replaced: fields.reduce((n, f) => n + f.rows, 0),
        note: 'Undo restores archived values in the listed fields, removes command-created records and recreates records removed by a merge. Data-command undo refuses later edits to those fields, deleted rows and reused ids; other fields keep later edits. Restoring a cleared calculation refuses later edits to its writable values. Type conversions can replace newer values in the converted field.',
      };
    }
    const summary = `undo ${undone.length} change${undone.length === 1 ? '' : 's'} back to version ${target}`;
    return {
      plan: { summary, risky: converting.length > 0, preview },
      apply: async () => {
        const statements: string[] = [];
        let snapshot: string | null = null;
        let appRestartMs = 0;
        let skipped = 0;
        for (const [i, r] of undone.entries()) {
          try {
            this.currentPart = { index: i, of: undone.length };
            const step = await (await this.analyseUndo(r.version)).apply('');
            const c = step as ChangeResult;
            statements.push(...c.statements);
            snapshot = c.snapshot ?? snapshot;
            appRestartMs += c.appRestartMs;
            skipped += c.skipped ?? 0;
          } catch (e) {
            if (e instanceof ClaimLostError && e.details?.outcome === 'unknown')
              throw new ClaimLostError(
                `undid ${i} of ${undone.length} changes; the outcome of the next one is unknown; reopen the app and check before repeating it.`,
                { outcome: 'unknown' },
              );
            this.currentPart = null;
            const code = e instanceof EngineError ? e.code : 'migration_failed';
            throw new EngineError(
              `undid ${i} of ${undone.length} changes; the app is now at version ${this.version}: ${(e as Error).message}`,
              code,
            );
          }
        }
        this.currentPart = null;
        return {
          version: target,
          summary:
            summary +
            (skipped ? `; skipped ${skipped} deleted referring records` : ''),
          ...(skipped ? { skipped } : {}),
          undid: undone.map((r) => r.summary).join('; '),
          statements,
          snapshot,
          appRestartMs,
        };
      },
    };
  }

  private undoKinds(
    rec: VersionRecord,
    counts: {
      table: string;
      column: string;
      replaced: number;
      originals?: number;
    }[] = [],
  ) {
    const count = (column: string) =>
      counts
        .filter((c) => c.column === column)
        .reduce((n, c) => n + c.replaced, 0);
    const restoredValues = counts
      .filter((c) => !c.column.startsWith('('))
      .reduce((n, c) => n + (c.originals ?? c.replaced), 0);
    const references = counts
      .filter((c) => {
        const location = this.locate(rec.definition, c.table, c.column);
        return (
          rec.definition.models[location.model]?.fields[location.field]
            ?.type === 'reference'
        );
      })
      .reduce((n, c) => n + c.replaced, 0);
    return (rec.migration?.steps ?? []).flatMap<Record<string, unknown>>(
      (step) => {
        if (
          step.op === 'loadRecords' ||
          step.op === 'extractModel' ||
          step.op === 'mergeRecords'
        ) {
          const model = step.command.model;
          return [
            {
              kind: step.op,
              inserted: count('(remove created record)'),
              recreated: count('(recreate merged record)'),
              restoredValues,
              references,
              modelLabel: rec.definition.models[model]?.label ?? model,
              ...(step.op === 'extractModel'
                ? {
                    fieldLabel:
                      rec.definition.models[model]?.fields[step.command.field]
                        ?.label ?? step.command.field,
                  }
                : {}),
            },
          ];
        }
        if (step.op === 'calculation' || step.op === 'convertColumn') {
          return [
            {
              kind: step.op,
              ...this.locate(rec.definition, step.table, step.column),
              restoredValues: counts
                .filter(
                  (c) => c.table === step.table && c.column === step.column,
                )
                .reduce((n, c) => n + (c.originals ?? c.replaced), 0),
              calculationRestore: step.from?.calculated
                ? 'calculation'
                : 'values',
            },
          ];
        }
        return [];
      },
    );
  }

  /** The model and field stored in `table.column` under `def`. */
  private locate(def: AppDefinition, table: string, column: string) {
    for (const [model, md] of Object.entries(def.models))
      if (tableFor(model, md) === table)
        for (const f of Object.keys(md.fields))
          if (snake(f) === column)
            return {
              model,
              field: f,
              modelLabel: md.label ?? model,
              fieldLabel: md.fields[f].label ?? f,
            };
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

  /**
   * Mark purged versions in the store. On a fenced host this is one claim
   * transaction (proof, generation, then the rows), so a host that lost its
   * claim marks nothing (#5630); otherwise one write per version.
   */
  private async markPurged(versions: number[]) {
    const claim = this.fenceClaim;
    const store = this.store;
    if (claim && store.commitIn && store.markPurgedIn) {
      const schema = schemaOf(this.database);
      const fence = this.fence as number;
      await claim.transaction(async (tx) => {
        await holdFence(tx, schema, fence);
        await store.markPurgedIn?.(tx, versions);
      });
      return;
    }
    for (const v of versions) await store.markPurged(v);
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
        await this.markPurged(versions);
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
    if (Object.keys(def.reports ?? {}).length) {
      for (const report of Object.values(def.reports ?? {}))
        report.spec = parseRuntimeReportSpec(report.spec);
      // Plan against the imported registry, without touching app.db or creating tables.
      const worker = new AppWorker(this.workerUrl, {
        tenantId: this.tenantId,
        dataDir: this.dataDir,
        def,
        version: this.version,
        limits: this.workerLimits,
        appLimits: this.appLimits,
        validateOnly: true,
      });
      try {
        await worker.ready;
      } finally {
        await worker.terminate();
      }
    }
    // The approval shows every method in full: what is approved is what runs.
    const methods: {
      model: string;
      name: string;
      description: string;
      params: Record<string, unknown>;
      code: string;
    }[] = [];
    let codeChars = 0;
    await this.requireMethodCodeFor(EMPTY_APP, def);
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

  // ---------- PostgreSQL: copies of the app's schema ----------

  private get onServer() {
    return this.database.kind !== 'sqlite';
  }

  /** The app's database config, pointed at a new side schema (a draft, a rehearsal, an aside). */
  private sideDatabase(tag: 'd' | 'r' | 'o' | 'n'): DatabaseConfig {
    return {
      ...this.database,
      schema: sideSchemaName(schemaOf(this.database), tag),
    } as DatabaseConfig;
  }

  /**
   * The host's own schema work (swap, drop, revoke, sweep). A live host with a
   * claim runs it as claim transactions (#5470); every other host on a
   * connection of its own.
   */
  private admin<T>(work: (db: SqlDatabase) => Promise<T>): Promise<T> {
    const claim = this.fenceClaim;
    return claim ? work(claim.admin) : withSchemaAdmin(this.database, work);
  }

  /** The claim died: retire the worker; every call now refuses with the claim's error. */
  private loseClaim(e: Error) {
    this.claimLost = e;
    void this.app?.terminate().catch(() => {});
    // This host serves nothing more. Reopening the app (a new claim) is the
    // caller's: nothing listens for this event yet.
    this.emit('claim-lost', e);
  }

  /** Refuse to open on a claim whose store cannot be committed in it, or that cannot see it. */
  private async checkClaimedStore() {
    const store = this.store;
    if (this.draft) return;
    if (!store.commitIn || !store.reachable) {
      if (this.allowUnfencedStore) return;
      throw new EngineError(
        'this host holds a claim on its app, but its version store cannot commit inside the claim (no commitIn); it cannot be fenced. Not opening.',
        'refused',
      );
    }
    await store.current();
    const reach = store.reachable.bind(store);
    if (!(await this.claim?.transaction((tx) => reach(tx))))
      throw new EngineError(
        "the claim connection cannot see the version store's own app row, so it is on another database than the shell's; not opening",
        'refused',
      );
  }

  /** The error that lost this host's claim (#5470), or null: a lost host serves nothing. */
  get lostClaim(): Error | null {
    return this.claimLost;
  }

  /** The claim this host's change and undo store writes run on: its own, or a draft's lent one (#5486). */
  private get fenceClaim(): AppClaim | undefined {
    return this.claim ?? this.borrowed;
  }

  /** Do this host's change and undo store writes run on a claim (#5486)? */
  private get fenced() {
    return !!this.fenceClaim && !!this.store.commitIn;
  }

  /**
   * The claim a live host lends to its drafts (#5486), only when its store
   * writes are fenced; undefined for a draft and for every host without one.
   */
  get lendableClaim(): AppClaim | undefined {
    return this.fenced && !this.draft ? this.claim : undefined;
  }

  /**
   * Run `work` in one claim transaction: the claim's proof first, so a host
   * that lost its claim writes nothing (#5486). For the shell's own rows
   * (`adoptDraft`) on a host that has one; check `lendableClaim` first.
   */
  claimTransaction<T>(work: (tx: unknown) => Promise<T>): Promise<T> {
    if (!this.claim || this.draft)
      throw new EngineError(
        'this host has no claim of its own to run a transaction on',
        'refused',
      );
    return this.claim.transaction(work);
  }

  /** Does this host commit the store inside the swap's transaction (#5470)? */
  private get atomic() {
    return !!this.claim && !!this.store.commitIn;
  }

  /** A live copy of the app's schema (rows, keys, sequences, policies, ownership, grants). */
  private forkSchemaTo(target: string) {
    return withSchemaAdmin(this.database, (db) =>
      forkSchema(
        db,
        schemaOf(this.database),
        target,
        this.ownerBase(),
        this.lockTimeoutMs,
      ),
    );
  }

  /**
   * The ownership generation this host holds (#5190); `undefined` on SQLite,
   * which keeps its writer lease instead. Every worker it starts carries it.
   */
  get fence(): number | undefined {
    return this.database.kind === 'sqlite' ? undefined : this.database.fence;
  }

  /**
   * Replace the live schema by `next` (the live one goes to `aside`) in one
   * transaction, which also advances the ownership generation: this host
   * adopts the new one for the workers it starts next, and every worker that
   * still holds the old one is fenced out. The ownership check always runs, so
   * a host that lost ownership changes nothing, a rollback included: it must
   * find the generation its own swap produced. `maybeSwapped` (the forward
   * swap's reply was lost, so its generation was never adopted) expects the
   * one past the held one: the caller only gets here when this publish's own
   * aside (a name no other operation uses) exists, so that swap committed.
   */
  private async swapSchemasIn(
    next: string,
    aside: string,
    maybeSwapped = false,
    within?: (tx: any) => Promise<void>,
  ) {
    const { fence } = await this.admin((db) =>
      swapSchemas(
        db,
        {
          live: schemaOf(this.database),
          next,
          aside,
          owner: this.ownerBase(),
          expectFence:
            this.fence === undefined
              ? undefined
              : maybeSwapped
                ? this.fence + 1
                : this.fence,
          within,
        },
        this.lockTimeoutMs,
      ),
    );
    if (fence !== null)
      this.database = { ...this.database, fence } as DatabaseConfig;
  }

  /**
   * Drop a schema the swap moved aside: its privileges go first (a session
   * that still holds a plan on it fails instead of writing to data nobody
   * reads), then the schema. A failure leaves the aside for the next start.
   */
  private async dropAsideSchemaOrThrow(aside: string) {
    await this.admin((db) => revokeSchema(db, aside, this.ownerBase()));
    await this.dropSideSchemaOrThrow(aside);
  }

  /** Drop a side schema; a failure is left for the next start's cleanup unless `strict`. */
  private async dropSideSchema(
    schema: string,
    strict = false,
    expectFence?: number,
  ) {
    try {
      await this.dropSideSchemaOrThrow(schema, expectFence);
    } catch (e) {
      if (strict) throw e;
    }
  }

  /** The full schema name of the app the copies of this host belong to. */
  private ownerBase() {
    return schemaOf(this.database);
  }

  private dropSideSchemaOrThrow(schema: string, expectFence?: number) {
    // A draft drops its own schema, which its LIVE app owns.
    const owner =
      this.draft?.schema === schema && this.draft.liveSchema
        ? this.draft.liveSchema
        : this.ownerBase();
    if (!isSideSchema(schema, owner))
      throw new EngineError(
        `${schema} is not a side schema; only a draft, rehearsal, aside or restore schema is dropped here`,
        'refused',
      );
    return this.admin((db) =>
      dropSchema(db, schema, this.lockTimeoutMs, owner, expectFence),
    );
  }

  /** Drop rehearsal, aside and restore schemas of this app that nothing uses (run at start, before the app opens). */
  private async sweepSideSchemas() {
    const base = schemaOf(this.database);
    await this.admin(async (db) => {
      for (const n of await listSideSchemas(db, base, 'ron')) {
        // A rehearsal a crashed or terminated host left may still have a
        // session finishing its last statement: DROP SCHEMA can lose a
        // deadlock to it (40P01, the server's own victim pick). The drop is
        // idempotent and nothing was dropped, so try again; the session is
        // gone or done by then.
        for (let attempt = 1; ; attempt++) {
          try {
            await dropSchema(db, n, this.lockTimeoutMs, base);
            break;
          } catch (e) {
            if (attempt >= 4 || !isDeadlockError(e)) throw e;
            await new Promise((r) => setTimeout(r, 250 * attempt));
          }
        }
      }
    });
  }

  /**
   * A publish a crash interrupted: put the schemas right. The journal and the
   * store say which way: a journal marked `committed` (the store had the
   * versions before the old data was dropped) or a store at the published
   * version means only the old data's schema is left to remove, however many
   * edits followed; otherwise the old schema comes back and the rehearsal goes.
   */
  private async reconcilePgPublish(
    j: PublishJournal,
    current: number | null,
  ): Promise<{
    current: number | null;
    atomic: 'rolled-forward' | 'rolled-back' | null;
  }> {
    const pg = j.pg;
    if (!pg) return { current, atomic: null };
    if (pg.schema !== schemaOf(this.database))
      throw new EngineError(
        `the publish journal in ${this.dataDir} belongs to schema ${pg.schema}, not ${schemaOf(this.database)}; not guessing`,
        'refused',
      );
    for (const n of [pg.staging, pg.aside])
      if (!isSideSchema(n, pg.schema, 'ro'))
        throw new EngineError(
          `the publish journal names ${n}, which is not a side schema of ${pg.schema}; not touching it`,
          'refused',
        );
    const has = (db: SqlDatabase, n: string) =>
      db.transaction((tx) => schemaExists(tx, n));
    const drop = async (db: SqlDatabase, n: string) => {
      if (await has(db, n))
        await dropSchema(db, n, this.lockTimeoutMs, pg.schema);
    };
    if (j.atomic && this.claim && this.store.commitIn) {
      // #5470: the swap and the store were one transaction, so the schemas say
      // which way. The aside is there while the publish is not final; the
      // readiness record says whether its new worker was ever brought up (and
      // so may have served and been written to).
      const outcome = await this.admin(async (db) => {
        if (!(await has(db, pg.aside))) {
          await drop(db, pg.staging);
          return null;
        }
        if ((await readPublished(db, pg.schema)) === j.id) {
          await drop(db, pg.aside);
          await drop(db, pg.staging);
          return 'rolled-forward' as const;
        }
        // Nothing was served on the new data: can it start? If so it is
        // ready, whatever the crash interrupted; if not, undo the publish.
        if (current !== null && (await this.startsOn(current))) {
          await markPublished(db, pg.schema, j.id as string);
          await drop(db, pg.aside);
          await drop(db, pg.staging);
          return 'rolled-forward' as const;
        }
        await this.compensate(pg, j, current, false);
        await drop(db, pg.staging);
        return 'rolled-back' as const;
      });
      return {
        current:
          outcome === 'rolled-back' ? await this.store.current() : current,
        atomic: outcome,
      };
    }
    await this.admin(async (db) => {
      if (publishHappened(j, current)) {
        await drop(db, pg.aside);
        await drop(db, pg.staging);
      } else {
        if (await has(db, pg.aside)) {
          const swapped = await swapSchemas(
            db,
            {
              live: pg.schema,
              next: pg.aside,
              aside: pg.staging,
              owner: pg.schema,
              expectFence: this.fence,
            },
            this.lockTimeoutMs,
          );
          if (swapped.fence !== null)
            this.database = {
              ...this.database,
              fence: swapped.fence,
            } as DatabaseConfig;
        }
        await drop(db, pg.staging);
      }
    });
    return { current, atomic: null };
  }

  /** Does a worker start on `version`'s definition and the live data? (Boot recovery's readiness test.) */
  private async startsOn(version: number): Promise<boolean> {
    let worker: AppWorker | undefined;
    try {
      const rec = await this.store.get(version);
      if (!rec || validate(rec.definition, rec.definition).length) return false;
      worker = this.spawn(rec.definition, version);
      await worker.ready;
      return true;
    } catch {
      return false;
    } finally {
      await worker?.terminate().catch(() => {});
    }
  }

  /**
   * Undo a publish whose swap committed: swap the old data back and, in the
   * same claim transaction, point the store at the old version again and
   * reopen the draft the publish had marked published. `final` is the store's
   * current version now. Records the publish wrote stay as never-current
   * history, which keeps version numbers unique.
   */
  private async compensate(
    pg: { staging: string; aside: string },
    j: Pick<PublishJournal, 'oldVersion' | 'draftId' | 'numbers'>,
    final: number | null,
    maybeSwapped: boolean,
  ) {
    const store = this.store;
    await this.swapSchemasIn(pg.aside, pg.staging, maybeSwapped, async (tx) => {
      await store.commitIn?.(tx, [], j.oldVersion, final);
      if (
        j.draftId &&
        !(await store.reopenDraftIn?.(tx, j.draftId, j.numbers ?? []))
      )
        throw new EngineError(
          'the draft the publish marked published has changed since, so the publish cannot be undone safely; not touching it',
          'refused',
        );
    });
  }

  /**
   * PostgreSQL: put the data back as it was in a snapshot of this app (a file
   * of `snapshots/`, by name). The snapshot becomes a side schema, then one
   * transaction swaps it in; the data it replaces is first kept as a snapshot
   * of its own, so a restore can be undone by another. Refused unless the
   * snapshot was taken at the version the app is on (the definition and the
   * tables must agree). Live waits while it runs; a failed restore leaves the
   * app as it was.
   */
  restoreSnapshot(
    principal: EnginePrincipal,
    name: string,
    opts: { approved?: boolean } = {},
  ): Promise<{
    version: number;
    restoredFrom: string;
    /** The snapshot of the data this restore replaced. */
    snapshot: string;
  }> {
    try {
      requireOwnerPrincipal(principal, this.tenantId);
    } catch (e) {
      return Promise.reject(e);
    }
    if (!this.onServer)
      return Promise.reject(
        new EngineError(
          'restoring a snapshot is for PostgreSQL; on SQLite the snapshot is a database file',
          'refused',
        ),
      );
    return this.run(async () => {
      if (this.frozenNow)
        throw new EngineError(
          'the app is frozen while a draft is open; restore after it is published or discarded',
          'refused',
        );
      const file = resolveSnapshot(join(this.dataDir, 'snapshots'), name);
      if (!file.endsWith('.pgdump'))
        throw new EngineError(
          `${name} is a SQLite database file, not a PostgreSQL dump; it cannot be restored here`,
          'refused',
        );
      const header = readDumpHeader(file);
      const schema = schemaOf(this.database);
      if (header.schema !== schema)
        throw new EngineError(
          `${name} was taken of schema ${header.schema}, not this app's ${schema}`,
          'refused',
        );
      if (header.version !== this.version)
        throw new EngineError(
          `${name} was taken at version ${header.version}; the app is on version ${this.version}. Undo to that version first.`,
          'refused',
        );
      if (opts.approved !== true)
        throw new ApprovalRequiredError({
          summary: `restore the data from ${name}`,
          risky: true,
          preview: {
            snapshot: name,
            takenAt: header.takenAt,
            version: header.version,
          },
        });
      await this.drainInflight();
      const side = schemaOf(this.sideDatabase('n'));
      const aside = schemaOf(this.sideDatabase('o'));
      const kept = await this.callApp<string>(
        'snapshot',
        'migrate-before-restore',
      );
      try {
        await withSchemaAdmin(this.database, (db) =>
          restoreDump(db, file, side, this.ownerBase()),
        );
        let swapped = false;
        // #5470: the swap and a compare of the store's pointer are one
        // transaction (the version is unchanged by a restore): a host that
        // lost the store to another one swaps nothing.
        const version = this.version;
        const same = this.atomic
          ? (tx: any) =>
              this.store.commitIn?.(tx, [], version, version) ??
              Promise.resolve()
          : undefined;
        try {
          await this.retireApp();
          await this.swapSchemasIn(side, aside, false, same);
          swapped = true;
          this.app = this.spawn(this.def, this.version);
          await this.app.ready;
        } catch (e) {
          try {
            this.keepBudget(this.app);
            await this.app.terminate().catch(() => {});
            // Ask the catalog, not the flag: a swap that committed with its reply
            // lost left the aside behind and the data replaced.
            const there =
              swapped ||
              (await this.admin((db) =>
                db.transaction((tx) => schemaExists(tx, aside)),
              ));
            if (there) await this.swapSchemasIn(aside, side, !swapped, same);
            this.app = this.spawn(this.def, this.version);
            await this.app.ready.catch(() => {});
            this.app.settleBudget();
          } finally {
            this.releaseSpare();
          }
          throw e;
        }
        await this.dropAsideSchemaOrThrow(aside).catch(() => {});
      } finally {
        await this.dropSideSchema(side);
      }
      this.emit('changed', {
        version: this.version,
        summary: `restored from ${name}`,
      });
      return { version: this.version, restoredFrom: name, snapshot: kept };
    });
  }

  // ---------- the running app ----------

  /**
   * The engine's own call into the app: change-queue work, as the system
   * principal of this host's tenant. Never reachable for a caller's request;
   * those go through `onApp` with the caller's principal.
   */
  private callApp<T>(op: WorkerOp, ...args: unknown[]): Promise<T> {
    return this.callAs<T>(this.#system, op, ...args);
  }

  /** Talk to the app as `principal` (already checked by the caller of this). */
  private async callAs<T>(
    principal: EnginePrincipal,
    op: WorkerOp,
    ...args: unknown[]
  ): Promise<T> {
    try {
      return await this.app.call<T>(op, principal, ...args);
    } catch (e) {
      // A call in flight when the claim was lost sees the loss, not the
      // retired worker's crash. The worker commits on its own connection, so
      // whether this call took effect is unknown (never "wrote nothing").
      if (this.claimLost) {
        const lost = new ClaimLostError(
          'this host lost its claim on the app while this call was running, so whether the call took effect is unknown; reopen the app and check before repeating it.',
        );
        lost.cause = e;
        throw lost;
      }
      if (e instanceof AppCallError) {
        if (e.code === 'unauthorized') throw new NoPrincipalError(e.message);
        if (e.code === 'forbidden') throw new PermissionDeniedError(e.message);
        if (e.stale) throw new StaleFenceError(e.message);
        if (e.user) throw new EngineError(e.message, 'invalid', e.details);
        throw new EngineError(e.message, 'refused');
      }
      throw e;
    }
  }

  /**
   * Refuse unless the tenant's entitlement grants method code (#5194). The
   * answer comes from the injected gate on this host, per call; a failed
   * lookup is a refusal ("unavailable"), never a yes.
   */
  private async requireMethodCode(what: string): Promise<void> {
    const gate = this.methodCode;
    if (!gate) return;
    let ok = false;
    try {
      ok = (await gate(this.tenantId)) === true;
    } catch {
      throw new EngineError(
        `${what}: whether custom method code is enabled for this workspace could not be checked, so nothing was run or saved; try again shortly`,
        'unavailable',
      );
    }
    if (!ok)
      throw new EngineError(methodCodeMessage(what), 'refused', {
        code: METHOD_CODE_DENIED,
      });
  }

  /** Refuse a change that adds or changes method code when it is not granted. */
  private async requireMethodCodeFor(
    from: AppDefinition,
    to: AppDefinition,
  ): Promise<void> {
    if (!this.methodCode) return;
    const added = introducedCode(from, to);
    if (added.length) await this.requireMethodCode(added.join(', '));
  }

  private async onApp<T>(
    principal: EnginePrincipal,
    op: WorkerOp,
    ...args: unknown[]
  ): Promise<T> {
    // No principal, or one of another tenant: nothing is queued or posted.
    requirePrincipal(principal, this.tenantId);
    // Never talk to an app that is being replaced: wait until the queue is
    // idle AND no change was queued while waiting. The check and the call below
    // run in one synchronous step, so no change can start in between.
    // A call that would run method code is also checked against the tenant's
    // entitlement (#5194); the check awaits, so the queue is looked at again.
    let entitled = false;
    for (;;) {
      const q = this.queue;
      await q;
      if (q !== this.queue) continue;
      const target =
        entitled || !this.methodCode
          ? null
          : methodCodeTarget(this.def, op, args);
      if (!target) break;
      await this.requireMethodCode(`${target.model}.${target.method}()`);
      entitled = true;
    }
    if (this.closed) throw new EngineError('the host is closed', 'refused');
    if (this.claimLost) throw this.claimLost;
    this.inflight++;
    try {
      return await this.callAs<T>(principal, op, ...args);
    } finally {
      if (--this.inflight === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const w of waiters) w();
      }
    }
  }

  /**
   * Wait for the calls already inside the worker to finish. Used inside the
   * change queue, where no new call can start (see {@link onApp}), before a
   * consistent copy of the data is taken.
   */
  private async drainInflight() {
    while (this.inflight > 0)
      await new Promise<void>((r) => this.idleWaiters.push(r));
  }

  // ---------- drafts ----------

  /**
   * Start a draft: copy the live data into `draftDir` (a directory that must
   * not exist yet; this call creates it) and return a second host over the
   * copy, with `autoApprove` on. The copy is a `VACUUM INTO` taken in the
   * change queue with no call in flight, so it is one consistent state; live is
   * only read. If anything fails, the directory this call created is removed.
   * Only an ordinary (live) host can fork. Live may keep serving records while
   * the draft is open; the caller freezes live structure with `setFrozen`.
   */
  forkDraft(
    principal: EnginePrincipal,
    draftDir: string,
    opts: ForkDraftOptions,
  ): Promise<AppHost> {
    try {
      requireOwnerPrincipal(principal, this.tenantId);
    } catch (e) {
      return Promise.reject(e);
    }
    if (this.draft)
      return Promise.reject(
        new EngineError('a draft cannot be forked again', 'refused'),
      );
    return this.run(async () => {
      const dir = checkDraftPath(draftDir, this.dataDir);
      if ((await opts.store.current()) !== null)
        throw new EngineError(
          'the draft needs an empty version store',
          'refused',
        );
      const base = await this.store.get(this.version);
      if (!base)
        throw new EngineError(
          `version ${this.version} is missing`,
          'not_found',
        );
      await this.drainInflight();
      mkdirSync(dirname(dir), { recursive: true });
      mkdirSync(dir); // EEXIST: someone else made it first; not ours to remove
      // PostgreSQL: the draft is a schema beside the live one, in the same database.
      const schema = this.onServer
        ? sideSchemaName(schemaOf(this.database), 'd')
        : undefined;
      const liveSchema = schema ? schemaOf(this.database) : undefined;
      let keepDir = false;
      try {
        if (schema) {
          // The marker goes first: a draft schema is never without a record of
          // it, so a failed start that cannot drop it leaves it findable (#5630).
          writeDraftMarker(dir, this.dataDir, base.version, schema, liveSchema);
          await this.forkSchemaTo(schema);
          // The copy carries the live app's change journal (#5486): a draft
          // starts with none of its own.
          await withSchemaAdmin(
            { ...this.database, schema } as DatabaseConfig,
            (db) =>
              db.transaction((tx) =>
                deleteMeta(tx, schema, [CHANGE_KEY, APPLIED_KEY, REVERSED_KEY]),
              ),
          );
        } else {
          await this.callApp('copyTo', join(dir, 'app.db'));
          writeDraftMarker(dir, this.dataDir, base.version);
        }
        await opts.store.append(structuredClone(base));
        await opts.store.setCurrent(base.version);
        return await AppHost.open(dir, {
          store: opts.store,
          tenantId: this.tenantId,
          workerUrl: this.workerUrl,
          workerLimits: this.workerLimits,
          appLimits: this.appLimits,
          methodCode: this.methodCode,
          autoApprove: true,
          database: schema ? this.database : undefined,
          swapLockTimeoutMs: this.lockTimeoutMs,
          // Its store writes run on this host's claim, lent, never released.
          ...(schema && this.lendableClaim
            ? { claim: this.lendableClaim }
            : {}),
        });
      } catch (e) {
        // A schema that cannot be dropped (this host lost its claim) keeps the
        // directory and its marker: the next start or discard removes the
        // orphan through the live claim (`discardOrphanDraft`). Removing the
        // marker would strand the schema, which nothing else lists (#5630).
        if (schema)
          try {
            await this.dropSideSchemaOrThrow(schema);
          } catch {
            keepDir = true;
          }
        if (!keepDir) rmSync(dir, { recursive: true, force: true });
        throw e;
      }
    });
  }

  /**
   * Throw this draft away: stop its app and delete its directory (only a
   * directory holding the draft marker is ever deleted). The caller discards
   * the draft's version store.
   */
  async discard(): Promise<void> {
    if (!this.draft)
      throw new EngineError('only a draft can be discarded', 'refused');
    await this.close();
    // Its schema first: if that fails the marker is still there to retry.
    if (this.draft.schema)
      await this.dropSideSchema(this.draft.schema, true, this.fence);
    removeDraftDirectory(this.dataDir, true);
  }

  /**
   * Throw this draft away only if it has no changes (#5122). The empty-chain
   * check and the close run on the change queue, so an edit queued before it
   * runs first and keeps the draft (returns false), and one arriving after
   * the close is refused rather than silently lost. Returns whether the draft
   * was discarded.
   */
  async discardIfEmpty(): Promise<boolean> {
    const draft = this.draft;
    if (!draft)
      throw new EngineError('only a draft can be discarded', 'refused');
    return this.run(async () => {
      const recs = await this.chain();
      const at = recs.findIndex((r) => r.version === draft.baseVersion);
      if (at !== 0) return false; // changes since the base, or unreadable
      await this.drainInflight();
      this.closed = true;
      this.unlisten?.();
      await this.app.terminate();
      if (draft.schema)
        await this.dropSideSchema(draft.schema, true, this.fence);
      removeDraftDirectory(this.dataDir, true);
      return true;
    });
  }

  /**
   * This draft's versions since its base, oldest first, with the base record.
   * What a publish takes from the draft.
   */
  draftChain(): Promise<DraftChain> {
    const draft = this.draft;
    if (!draft)
      return Promise.reject(new EngineError('not a draft', 'refused'));
    return this.run(async () => {
      const recs = await this.chain(); // current back to the base
      const at = recs.findIndex((r) => r.version === draft.baseVersion);
      if (at < 0)
        throw new EngineError(
          'the draft history does not reach its base version',
          'not_found',
        );
      return {
        baseVersion: draft.baseVersion,
        base: recs[at],
        versions: recs.slice(0, at).reverse(),
      };
    });
  }

  /** Checks shared by preview and publish; runs inside the change queue. */
  private async publishInputs(draft: AppHost) {
    if (this.draft)
      throw new EngineError(
        'a draft cannot be published into a draft',
        'refused',
      );
    if (draft === this || !draft.draft)
      throw new EngineError('that is not a draft', 'refused');
    if (!sameDir(draft.draft.liveDir, this.dataDir))
      throw new EngineError(
        'that draft was made from another app or location; discard it and start a new one',
        'refused',
      );
    const chain = await draft.draftChain();
    if (chain.baseVersion !== this.version)
      throw new EngineError(
        `the app moved from version ${chain.baseVersion} to ${this.version} since the draft started; discard the draft and start again`,
        'refused',
      );
    const live = await this.store.get(this.version);
    if (
      !live ||
      canonical(live.definition) !== canonical(chain.base.definition) ||
      canonical(this.def) !== canonical(chain.base.definition)
    )
      throw new EngineError(
        'the app is not what the draft started from; discard the draft and start again',
        'refused',
      );
    if (!chain.versions.length)
      throw new EngineError('the draft has no changes to publish', 'refused');
    // Method code the draft adds or changes needs the entitlement at publish
    // too (a card made while entitled, applied after it was lost).
    await this.requireMethodCodeFor(
      this.def,
      chain.versions[chain.versions.length - 1].definition,
    );
    return { chain, digest: chainDigest(this.version, chain) };
  }

  /** The version numbers a publish of `chain` would give: after everything live's store holds. */
  private async nextNumbers(chain: DraftChain) {
    const max = await this.store.maxVersion();
    return chain.versions.map((_, i) => max + 1 + i);
  }

  /**
   * Replay the draft's versions, in order, onto the copy of live in `dir`: one
   * short worker per version, with that version's stored definition and steps
   * and the number it will have in live (archives are keyed by it). Ends by
   * writing the result as one standalone file, `dir/final/app.db`. Touches
   * nothing but `dir`.
   */
  private async replay(place: CopyPlace, chain: DraftChain, numbers: number[]) {
    const dir = place.dir;
    const boots: BootInfo[] = [];
    const dataSteps: PublishDataStep[][] = [];
    const allSteps = chain.versions.flatMap((r) => r.migration?.steps ?? []);
    let archives = { values: 0, tables: 0 };
    const file = place.database ? '' : join(dir, 'final', 'app.db');
    // The worker that applied the previous version: it holds exactly the
    // definition and data the next version's previews must read, so it answers
    // them instead of a second worker booted just for that.
    let prev: AppWorker | null = null;
    try {
      for (let i = 0; i < chain.versions.length; i++) {
        const rec = chain.versions[i];
        const errs = validate(rec.definition, rec.definition);
        if (errs.length)
          throw new EngineError(
            `"${rec.summary}" from the draft is invalid: ${errs.join('; ')}`,
          );
        const steps = structuredClone(rec.migration?.steps ?? []);
        const impacts: PublishDataStep[] = [];
        // Only a data step previews; any other version lets the carried worker go
        // before the next boots on the same files.
        let carried = prev;
        prev = null;
        if (
          !steps.some((step) =>
            ['loadRecords', 'extractModel', 'mergeRecords'].includes(step.op),
          )
        ) {
          await carried?.retire();
          carried = null;
        }
        if (
          steps.some((step) =>
            ['loadRecords', 'extractModel', 'mergeRecords'].includes(step.op),
          )
        ) {
          const before =
            carried ??
            new AppWorker(this.workerUrl, {
              tenantId: this.tenantId,
              dataDir: dir,
              def: chain.base.definition,
              version: chain.baseVersion,
              limits: this.workerLimits,
              appLimits: this.appLimits,
              database: place.database,
              lockTimeoutMs: this.lockTimeoutMs,
            });
          carried = null;
          try {
            await before.ready;
            for (const step of steps) {
              if (step.op === 'loadRecords') {
                const counts = await before.call<LoadPreview>(
                  'previewLoad',
                  this.#system,
                  step.command,
                );
                step.maxUpdates = counts.update;
                impacts.push({
                  op: step.op,
                  model: step.command.model,
                  mode: step.command.mode,
                  counts: { ...counts },
                });
              } else if (
                step.op === 'extractModel' ||
                step.op === 'mergeRecords'
              ) {
                const counts = await before.call<ExtractPreview | MergePreview>(
                  step.op === 'extractModel'
                    ? 'previewExtract'
                    : 'previewMerge',
                  this.#system,
                  step.command,
                );
                impacts.push({
                  op: step.op,
                  model: step.command.model,
                  counts: { ...counts },
                });
              }
            }
          } finally {
            await before.retire();
          }
        }
        dataSteps.push(impacts);
        const w = new AppWorker(this.workerUrl, {
          tenantId: this.tenantId,
          dataDir: dir,
          def: rec.definition,
          version: numbers[i],
          limits: this.workerLimits,
          appLimits: this.appLimits,
          database: place.database,
          lockTimeoutMs: this.lockTimeoutMs,
          migration: steps.length
            ? { steps, direction: 'up', version: numbers[i] }
            : undefined,
        });
        try {
          boots.push(await w.ready);
          if (i === chain.versions.length - 1) {
            archives = await w.call(
              'countArchives',
              this.#system,
              numbers,
              archivedTables(allSteps),
            );
            // SQLite: the result is written as one standalone file. On
            // PostgreSQL the rehearsal schema already is the result.
            if (!place.database) await w.call('copyTo', this.#system, file);
          }
        } catch (e) {
          await w.terminate().catch(() => {});
          throw new EngineError(
            `"${rec.summary}" from the draft does not apply to the current data, so nothing was published: ${(e as Error).message}`,
            'migration_failed',
          );
        }
        if (i === chain.versions.length - 1) await w.retire();
        else prev = w;
      }
    } finally {
      await prev?.retire();
    }
    return { boots, archives, file, dataSteps };
  }

  private replayDigest(chain: string, dataSteps: PublishDataStep[][]) {
    return dataSteps.some((steps) => steps.length)
      ? createHash('sha256')
          .update(canonical({ chain, dataSteps }))
          .digest('hex')
      : chain;
  }

  /**
   * What publishing `draft` would do: the draft's versions replayed on a fresh
   * copy of the CURRENT live data (the live app is not touched and only waits
   * while the copy is taken). `digest` pins the answer for `publishDraft`.
   */
  async previewPublish(draft: AppHost): Promise<PublishPreview> {
    const ctx = await this.run(async () => {
      const { chain, digest } = await this.publishInputs(draft);
      await this.drainInflight();
      const numbers = await this.nextNumbers(chain);
      const dir = makeRehearsalDir(this.dataDir);
      let place: CopyPlace = { dir };
      try {
        if (this.onServer) {
          place = { dir, database: this.sideDatabase('r') };
          await this.forkSchemaTo(schemaOf(place.database as DatabaseConfig));
        } else await this.callApp('copyTo', join(dir, 'app.db'));
      } catch (e) {
        removeRehearsal(this.dataDir, dir);
        throw e;
      }
      return {
        chain,
        digest,
        numbers,
        dir,
        place,
        from: this.def,
        at: this.version,
      };
    });
    try {
      const r = await this.replay(ctx.place, ctx.chain, ctx.numbers);
      const final =
        ctx.chain.versions[ctx.chain.versions.length - 1].definition;
      return {
        digest: this.replayDigest(ctx.digest, r.dataSteps),
        risky: true,
        fromVersion: ctx.at,
        toVersion: ctx.numbers[ctx.numbers.length - 1],
        versions: ctx.chain.versions.map((rec, i) => ({
          version: ctx.numbers[i],
          draftVersion: rec.version,
          author: rec.author,
          summary: rec.summary,
          steps: rec.migration?.steps ?? [],
          statements: r.boots[i].statements,
          dataSteps: r.dataSteps[i],
        })),
        fieldRenames: ctx.chain.versions.flatMap((record, index) => {
          const before = index
            ? ctx.chain.versions[index - 1].definition
            : ctx.chain.base.definition;
          return (record.migration?.steps ?? []).flatMap((step) => {
            if (step.op !== 'renameColumn') return [];
            const entry = Object.entries(before.models).find(
              ([name, model]) => tableFor(name, model) === step.table,
            );
            if (!entry) return [];
            const [model, oldModel] = entry;
            const from = Object.keys(oldModel.fields).find(
              (name) => snake(name) === step.from,
            );
            const to = Object.keys(
              record.definition.models[model]?.fields ?? {},
            ).find((name) => snake(name) === step.to);
            return from && to
              ? [
                  {
                    model,
                    from,
                    to,
                    fromLabel: oldModel.fields[from].label ?? from,
                    toLabel:
                      record.definition.models[model].fields[to].label ?? to,
                  },
                ]
              : [];
          });
        }),
        definition: diffDefinitions(ctx.from, final),
        archives: r.archives,
        methods: listMethods(ctx.from, final),
      };
    } finally {
      removeRehearsal(this.dataDir, ctx.dir);
      if (ctx.place.database)
        await this.dropSideSchema(schemaOf(ctx.place.database));
    }
  }

  /**
   * Publish `draft` into live. Always needs `approved: true` and the `expect`
   * digest of a preview; refuses if the draft's chain, or the app it started
   * from, is not what that preview was of.
   *
   * It rehearses on a fresh copy of the current live data (so records added
   * since the fork are kept and draft records are not), then swaps the file:
   * the old data is first copied to snapshots/<ts>-0-migrate-prepublish.db,
   * live's files are renamed aside and the rehearsed file renamed into place.
   * The versions land in live as N ordinary versions (numbers after live's
   * highest, summaries tagged with `draftName`), so `undo` / `undoTo` work.
   * Any failure before the store is written puts the old files back (live's
   * `app.db` is byte-for-byte what it was) and leaves the version unchanged.
   * Live records wait (not fail) while this runs. The caller discards the draft.
   */
  publishDraft(
    principal: EnginePrincipal,
    draft: AppHost,
    opts: PublishOptions,
  ): Promise<PublishResult> {
    try {
      requireOwnerPrincipal(principal, this.tenantId);
    } catch (e) {
      return Promise.reject(e);
    }
    if (!opts || typeof opts.author !== 'string' || !opts.author)
      return Promise.reject(new EngineError('publish needs an author'));
    if (typeof opts.expect !== 'string' || !opts.expect)
      return Promise.reject(
        new EngineError('publish needs the digest of a preview', 'refused'),
      );
    if (opts.approved !== true)
      return Promise.reject(
        new ApprovalRequiredError({
          summary: 'publish the draft',
          risky: true,
          preview: { digest: opts.expect },
        }),
      );
    return this.run(() => this.doPublish(draft, opts));
  }

  private async persistVersions(records: VersionRecord[], current: number) {
    if (this.store.commit) return this.store.commit(records, current);
    for (const r of records) await this.store.append(r);
    await this.store.setCurrent(current);
  }

  private async doPublish(
    draft: AppHost,
    opts: PublishOptions,
  ): Promise<PublishResult> {
    const { chain, digest } = await this.publishInputs(draft);
    if (
      !chain.versions.some((rec) =>
        rec.migration?.steps.some((step) =>
          ['loadRecords', 'extractModel', 'mergeRecords'].includes(step.op),
        ),
      ) &&
      digest !== opts.expect
    )
      throw new EngineError(
        'the draft is not what was reviewed (it changed since the preview); review it again',
        'refused',
      );
    const stage = async (s: PublishStage) => {
      await opts.onStage?.(s);
    };
    assertNoAside(this.dataDir);
    await this.drainInflight();
    const numbers = await this.nextNumbers(chain);
    const finalNumber = numbers[numbers.length - 1];
    const finalDef = chain.versions[chain.versions.length - 1].definition;
    const tag = opts.draftName
      ? `[draft: ${opts.draftName.replace(/\s+/g, ' ').trim()}] `
      : '';
    const oldVersion = this.version;
    const atomic = this.atomic;
    const dir = makeRehearsalDir(this.dataDir);
    const t0 = performance.now();
    let retired = false;
    let journaled = false;
    let asideStarted = false;
    let swapped = false;
    let next: AppWorker | null = null;
    let snapshot = '';
    let journal: PublishJournal | null = null;
    let archives = { values: 0, tables: 0 };
    const stamp = now();
    const records: VersionRecord[] = chain.versions.map((rec, i) => ({
      version: numbers[i],
      parent: i === 0 ? oldVersion : numbers[i - 1],
      author: rec.author,
      summary: `${tag}${rec.summary}`,
      definition: structuredClone(rec.definition),
      migration: rec.migration?.steps.length
        ? { steps: structuredClone(rec.migration.steps) }
        : null,
      createdAt: stamp,
    }));
    // PostgreSQL: the rehearsal is a schema beside live, swapped in by rename.
    const pg = this.onServer
      ? {
          schema: schemaOf(this.database),
          staging: schemaOf(this.sideDatabase('r')),
          aside: schemaOf(this.sideDatabase('o')),
        }
      : null;
    const place: CopyPlace = pg
      ? {
          dir,
          database: { ...this.database, schema: pg.staging } as DatabaseConfig,
        }
      : { dir };
    try {
      if (pg) await this.forkSchemaTo(pg.staging);
      else await this.callApp('copyTo', join(dir, 'app.db'));
      await stage('copied');
      const r = await this.replay(place, chain, numbers);
      if (this.replayDigest(digest, r.dataSteps) !== opts.expect)
        throw new EngineError(
          'the draft or live data counts changed since review; review it again',
          'refused',
        );
      archives = r.archives;
      await stage('rehearsed');
      snapshot = join(
        this.dataDir,
        'snapshots',
        `${Date.now()}-0-migrate-prepublish.${copySuffix(this.database)}`,
      );
      await this.callApp('copyTo', snapshot);
      await stage('snapshotted');
      journal = {
        format: 1,
        oldVersion,
        finalVersion: finalNumber,
        rehearsal: dir,
        snapshot,
        startedAt: now(),
        ...(pg ? { pg } : {}),
        ...(pg && atomic
          ? {
              atomic: true,
              id: randomUUID(),
              draftId: this.store.publishingDraft?.() ?? null,
              numbers,
            }
          : {}),
      };
      writeJournal(this.dataDir, journal);
      journaled = true;
      await stage('journaled');
      retired = true;
      await this.retireApp();
      await stage('retired');
      asideStarted = true;
      if (pg) {
        // One transaction renames live aside and the rehearsal into place.
        await stage('moved-aside');
        // #5470: the store's write is part of this transaction.
        await this.swapSchemasIn(
          pg.staging,
          pg.aside,
          false,
          atomic
            ? (tx) =>
                this.store.commitIn?.(
                  tx,
                  records,
                  finalNumber,
                  oldVersion,
                  true,
                ) ?? Promise.resolve()
            : undefined,
        );
        swapped = true;
        await stage('swapped');
      } else {
        moveAside(this.dataDir);
        await stage('moved-aside');
        renameSync(r.file, join(this.dataDir, 'app.db'));
        await stage('swapped');
      }
      next = this.spawn(finalDef, finalNumber);
      await next.ready;
      await stage('respawned');
      if (atomic && pg && journal?.id)
        // The new worker is up: say so, so no later boot undoes the publish
        // over what it serves.
        await this.admin((db) =>
          markPublished(db, pg.schema, journal?.id as string),
        );
      else await this.persistVersions(records, finalNumber);
    } catch (e) {
      await this.abortPublish(
        {
          retired,
          asideStarted,
          journaled,
          next,
          dir,
          pg,
          swapped,
          journal: atomic ? journal : null,
          finalNumber,
        },
        e,
      );
      throw e; // not reached when abortPublish throws its own
    }
    // The store has the versions: the publish is final.
    this.app = next as AppWorker;
    this.def = structuredClone(finalDef);
    this.version = finalNumber;
    this.lastSwapMs = Math.round(performance.now() - t0);
    try {
      await opts.onStage?.('committed');
    } catch {
      // too late to matter
    }
    // Say so in the journal before the old data goes. If that write fails the
    // old data and the journal stay (the next start finishes the clean-up:
    // `publishHappened` reads a store at or past the final version as
    // published) and the owner is told, never left to find out at a restart.
    let marked = true;
    try {
      if (journal) writeJournal(this.dataDir, { ...journal, committed: true });
    } catch (e) {
      marked = false;
      this.notices.push(
        `The publish is done, but its journal could not be marked finished (${(e as Error).message}); the old data is kept until the next start, which removes it. Free some disk space or fix the data directory.`,
      );
    }
    if (marked)
      try {
        // PostgreSQL: the old data's schema goes; if that fails the journal
        // stays, and the next start removes it (the journal says published).
        if (pg) await this.dropAsideSchemaOrThrow(pg.aside);
        dropAside(this.dataDir);
        removeJournal(this.dataDir);
        removeRehearsal(this.dataDir, dir);
      } catch {
        // leftovers are removed at the next start (reconcilePublish)
      }
    const summary = `${tag}published ${chain.versions.length} change${chain.versions.length === 1 ? '' : 's'}`;
    this.emit('changed', { version: finalNumber, summary });
    return {
      version: finalNumber,
      versions: numbers,
      summary,
      snapshot,
      archives,
      appRestartMs: this.lastSwapMs,
    };
  }

  /** Undo a failed publish: put live back exactly as it was and start it again. */
  private async abortPublish(
    s: {
      retired: boolean;
      asideStarted: boolean;
      journaled: boolean;
      next: AppWorker | null;
      dir: string;
      pg: { schema: string; staging: string; aside: string } | null;
      swapped: boolean;
      /** The journal of an atomic publish (#5470): the store committed with the swap. */
      journal?: PublishJournal | null;
      finalNumber?: number;
    },
    cause: unknown,
  ) {
    try {
      if (s.next) {
        this.keepBudget(s.next);
        await s.next.terminate().catch(() => {});
      }
      if (s.retired) {
        await this.app.terminate().catch(() => {});
        if (s.asideStarted && !s.pg) restoreAside(this.dataDir);
      }
      if (s.pg) {
        // The swap is one transaction: either it happened (put the old schema
        // back) or live was never touched. The rehearsal goes either way.
        // Ask the catalog, not the flag: if the swap committed but its reply
        // was lost, the aside is there.
        if (
          s.swapped ||
          (await this.admin((db) =>
            db.transaction((tx) => schemaExists(tx, s.pg?.aside ?? '')),
          ))
        ) {
          // An atomic publish's swap carried the store's write: undo both.
          if (s.journal && s.finalNumber !== undefined)
            await this.compensate(s.pg, s.journal, s.finalNumber, !s.swapped);
          else await this.swapSchemasIn(s.pg.aside, s.pg.staging, !s.swapped);
        }
        await this.dropSideSchemaOrThrow(s.pg.staging);
      }
      if (s.journaled) removeJournal(this.dataDir);
      removeRehearsal(this.dataDir, s.dir);
      if (s.retired) {
        this.app = this.spawn(this.def, this.version);
        await this.app.ready.catch(() => {});
        this.app.settleBudget();
      }
    } catch (e2) {
      // A lost claim changes nothing more, whatever state the swap left: the
      // next opener's boot recovers from the journal and the catalog.
      if (e2 instanceof ClaimLostError) throw e2;
      throw new EngineError(
        `${(cause as Error).message}; and putting the old data back failed: ${(e2 as Error).message}. It is restored when the app next starts.`,
        'migration_failed',
      );
    } finally {
      this.releaseSpare();
    }
  }

  /** Bounded read worker: a timeout never terminates the live app worker. */
  runReport(
    principal: EnginePrincipal,
    input: string | RuntimeReportSpec,
    options: ReportOptions = {},
  ): Promise<AppReportResult> {
    try {
      requirePrincipal(principal, this.tenantId);
    } catch (e) {
      return Promise.reject(e);
    }
    const timeoutMs = options.timeoutMs ?? 5000;
    const maxRows = options.maxRows ?? 1000;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 10000 ||
      !Number.isInteger(maxRows) ||
      maxRows < 1 ||
      maxRows > 1000
    )
      return Promise.reject(
        new EngineError('report limits: 1-1000 rows and 1-10000 ms'),
      );
    return this.run(async () => {
      await this.drainInflight();
      const worker = new AppWorker(this.workerUrl, {
        tenantId: this.tenantId,
        dataDir: this.dataDir,
        def: this.def,
        version: this.version,
        limits: this.workerLimits,
        appLimits: this.appLimits,
        database: this.database,
        lockTimeoutMs: this.lockTimeoutMs,
        readOnly: true,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await worker.ready;
        return await Promise.race([
          worker.call<AppReportResult>('runReport', principal, input, {
            maxRows,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new EngineError('report time limit exceeded', 'refused'),
                ),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        await worker.terminate();
      }
    });
  }

  countRows(principal: EnginePrincipal, model: string) {
    if (
      !Object.hasOwn(this.def.models, model) ||
      this.def.models[model].extends
    )
      throw new EngineError('Row counting requires an app-owned model.');
    return this.onApp<number>(
      principal,
      'countRows',
      tableFor(model, this.def.models[model]),
    );
  }

  /** Bounded engine read-back, including hidden provenance; never exposed as a tool. */
  readStoredRows(
    principal: EnginePrincipal,
    model: string,
    fields: string[],
    order: string,
    sourceRows?: number[],
    options?: { limit?: number; nullsLast?: boolean },
  ) {
    return this.onApp<Row[]>(
      principal,
      'readStoredRows',
      model,
      fields,
      order,
      sourceRows,
      options,
    );
  }

  /** Read only the linked records requested, in bounded core batches. */
  listByIds(principal: EnginePrincipal, model: string, ids: string[]) {
    return this.onApp<Row[]>(principal, 'listByIds', model, ids);
  }

  list(principal: EnginePrincipal, model: string, limit = 200) {
    return this.onApp<Row[]>(principal, 'list', model, limit);
  }
  get(principal: EnginePrincipal, model: string, id: string) {
    return this.onApp<Row>(principal, 'get', model, id);
  }
  async create(principal: EnginePrincipal, model: string, data: Row) {
    const r = await this.onApp<Row>(principal, 'create', model, data);
    this.emit('records', { model });
    return r;
  }
  async update(
    principal: EnginePrincipal,
    model: string,
    id: string,
    data: Row,
  ) {
    const r = await this.onApp<Row>(principal, 'update', model, id, data);
    this.emit('records', { model });
    return r;
  }
  async remove(principal: EnginePrincipal, model: string, id: string) {
    const r = await this.onApp<{ deleted: string }>(
      principal,
      'remove',
      model,
      id,
    );
    this.emit('records', { model });
    return r;
  }

  async runMethod(
    principal: EnginePrincipal,
    model: string,
    method: string,
    id: string | null = null,
    params: Row = {},
  ) {
    const out = await this.onApp<MethodResult>(
      principal,
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
  appTools(principal: EnginePrincipal) {
    return this.onApp<
      { name: string; description?: string; inputSchema?: unknown }[]
    >(principal, 'tools');
  }

  /** Call one of the app's generated tools. A delete needs `approved: true`. */
  async callAppTool(
    principal: EnginePrincipal,
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
    const r = await this.onApp<ToolResult>(principal, 'callTool', name, args);
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
    principal: EnginePrincipal,
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
    const r = await this.onApp<RestResult>(principal, 'rest', {
      ...req,
      method,
    });
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
    this.unlisten?.(); // a draft stops listening to the claim it was lent
    this.releaseSpare();
    try {
      await this.app.terminate();
    } finally {
      await this.releaseDatabase?.();
    }
  }
}

/** A field as stored in the definition: visible unless hidden is set later. */
function shown(fd: FieldDef): FieldDef {
  const { hidden: _hidden, ...rest } = fd;
  return rest;
}

/**
 * Discard a draft directory no host holds (a crash left it). On PostgreSQL the
 * draft's schema goes too, through the live app's `database` config; on SQLite
 * `discardDraftDirectory` is enough. With `claim` (the live host's, #5486) the
 * drop is a claim transaction: a host that lost its claim drops nothing.
 */
export async function discardOrphanDraft(
  dataDir: string,
  database: DatabaseConfig = SQLITE,
  claim?: AppClaim,
): Promise<void> {
  const marker = readDraftMarker(dataDir);
  if (marker?.schema) {
    if (database.kind === 'sqlite')
      throw new EngineError(
        "this draft lives on PostgreSQL; pass the live app's database config",
        'refused',
      );
    if (
      !marker.liveSchema ||
      marker.liveSchema !== database.schema ||
      !isSideSchema(marker.schema, marker.liveSchema, 'd')
    )
      throw new EngineError(
        `the draft marker in ${dataDir} names ${marker.schema}, which is not a draft schema of ${database.schema}; not dropping it`,
        'refused',
      );
    const schema = assertSchemaName(marker.schema);
    const drop = (db: SqlDatabase) =>
      dropSchema(db, schema, undefined, marker.liveSchema);
    if (claim) await drop(claim.admin as unknown as SqlDatabase);
    else await withSchemaAdmin({ ...database, schema }, drop);
  }
  removeDraftDirectory(dataDir, true);
}

/** A PostgreSQL deadlock the server resolved by cancelling this statement (SQLSTATE 40P01). */
function isDeadlockError(error: unknown): boolean {
  let e = error as { code?: unknown; cause?: unknown } | undefined;
  for (let i = 0; e && i < 6; i++, e = e.cause as typeof e)
    if (e.code === '40P01') return true;
  return false;
}
