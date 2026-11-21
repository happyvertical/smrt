/** Node-only, opt-in activation. Application DDL stays in the migration tracker. */
import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type ActivationManifest,
  activationClosure,
} from './activation/manifest.js';
import { journalListTables } from './cookbook/app-model-claims.js';
import { resolveMigrationEngine } from './migrations/differ.js';
import {
  joinQueueWithDeadline,
  type MigrationLockDeadline,
  MigrationLockTimeoutError,
  raceMigrationLockDeadline,
  refuseInsideMigrationLockHolder,
  startMigrationLockDeadline,
  withMigrationLock,
} from './migrations/migration-lock.js';
import {
  assertMigrationAccepted,
  migrateSmrtSchemas,
} from './migrations/orchestrate.js';
import { isFrameworkBaseClass } from './registry/framework-base-classes.js';
import { ObjectRegistry } from './registry.js';
import {
  COOKBOOK_TOOLS_MODEL,
  getRuntimeModelReadiness,
  notifyRuntimeExposureChanged,
  type RuntimeExposureGate,
  type RuntimeExposureModel,
} from './runtime-exposure.js';
import { runSerializedAgainstSystemTableBootstrap } from './system/bootstrap.js';

export type {
  ActivationManifest,
  ActivationModule,
} from './activation/manifest.js';
export { activationClosure } from './activation/manifest.js';

export interface ActivationCoordinatorOptions {
  /** One stable process slot per application's database. Reuse its database handle. */
  scope: string;
  db: DatabaseInterface;
  packageName: string;
  manifest: ActivationManifest;
  loaders: Record<string, () => Promise<unknown>>;
  alwaysOn?: readonly string[];
  /** Read the persisted enabled-model union over ALL tenants. Failure aborts boot. */
  readEnabled(): Promise<Iterable<string>>;
  /**
   * PostgreSQL: how long an activation waits, in milliseconds, for its turn
   * in the activation queue and for the migration lock, counted from the
   * `activate()` call; then `MigrationLockTimeoutError`. `0` waits
   * indefinitely. Default 15 minutes.
   */
  migrationLockTimeout?: number;
}

/** @internal Options an outer entry point passes to `activate()`. */
export interface ActivationCallOptions {
  /** The outer entry point's deadline, carried rather than restarted. */
  migrationLockDeadline?: MigrationLockDeadline;
}

export interface ActivationCoordinator {
  /** Recover the persisted union before accepting requests. Safe to retry after failure. */
  boot(): Promise<void>;
  /**
   * Await BEFORE publishing/persisting cookbook enablement. Never unloads or
   * drops on disable. On PostgreSQL it holds one pinned connection and the
   * migration lock from the table-ownership check through the loaders to the
   * migration. Refused with `MigrationLockOrderError` from code that holds
   * the migration lock.
   */
  activate(
    models: Iterable<string>,
    call?: ActivationCallOptions,
  ): Promise<void>;
  isReady(model: RuntimeExposureModel | string): boolean;
  /**
   * The installed graph, loaded or not. The app model editor reads its model
   * ids and tables so a custom list never takes an installed model's name or
   * table while that model's recipe is off.
   */
  readonly manifest?: ActivationManifest;
  /** AND readiness with the host's live tenant gate. Install before boot, never per request. */
  gate(exposure: RuntimeExposureGate): RuntimeExposureGate;
}

interface ActivationProcess {
  tail: Promise<void>;
  slots: Map<
    string,
    {
      db: DatabaseInterface;
      signature: string;
      coordinator: ActivationCoordinator;
    }
  >;
}
declare global {
  var __smrtActivation: ActivationProcess | undefined;
}

/**
 * Serialize explicit runtime schema writers sharing the process-wide registry.
 *
 * The activation queue comes before the migration lock in the lock order, so
 * it is refused (`MigrationLockOrderError`) from code that holds the
 * migration lock: that holder would wait here behind a turn that may be
 * waiting for the holder.
 */
export function withRuntimeSchemaActivation<T>(
  work: () => Promise<T>,
): Promise<T> {
  refuseInsideMigrationLockHolder('activation-inside-holder');
  return enqueueRuntimeSchemaActivation(work);
}

/**
 * The activation queue's turn, bounded by an entry point's deadline.
 * @internal
 */
export function enqueueRuntimeSchemaActivation<T>(
  work: () => Promise<T>,
  deadline?: MigrationLockDeadline,
): Promise<T> {
  globalThis.__smrtActivation ??= { tail: Promise.resolve(), slots: new Map() };
  const process = globalThis.__smrtActivation;
  const { operation, result } = joinQueueWithDeadline(
    process.tail,
    work,
    deadline,
  );
  process.tail = operation.then(
    () => {},
    () => {},
  );
  return result;
}

export function createActivationCoordinator(
  options: ActivationCoordinatorOptions,
): ActivationCoordinator {
  const engine = resolveMigrationEngine(options.db);
  if (engine !== 'sqlite' && engine !== 'postgres') {
    throw new Error(
      'SMRT lazy activation supports SQLite and PostgreSQL only; keep eager registration and operator migrations for DuckDB.',
    );
  }
  activationClosure(options.manifest, Object.keys(options.manifest.models));
  for (const id of Object.keys(options.manifest.modules)) {
    if (typeof options.loaders[id] !== 'function')
      throw new Error(`Missing activation loader: ${id}`);
  }
  globalThis.__smrtActivation ??= {
    tail: Promise.resolve(),
    slots: new Map(),
  };
  const process = globalThis.__smrtActivation;
  const signature = JSON.stringify([
    options.manifest,
    options.alwaysOn ?? [],
    options.packageName,
  ]);
  const previous = process.slots.get(options.scope);
  if (previous) {
    if (previous.db !== options.db || previous.signature !== signature) {
      throw new Error(
        `Conflicting SMRT activation coordinator: ${options.scope}`,
      );
    }
    return previous.coordinator;
  }
  const ready = new Set<string>();
  const loaded = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  let invalidGraph: Error | undefined;
  /**
   * Ownership check, loaders, checks and migration of one closure, on the
   * handle the migration lock lives on (`lock.db`; the database itself on
   * SQLite and PGlite).
   */
  const activateLocked = async (
    db: DatabaseInterface,
    closure: ReturnType<typeof activationClosure>,
    tables: Set<string>,
  ) => {
    // Durable ownership, independent of boot order and of what this
    // process has registered: a list any app model journal declares
    // keeps its table. Read through the serialized system-table
    // executor, on the lock's connection.
    const journalled = await runSerializedAgainstSystemTableBootstrap(
      db,
      engine,
      (scoped) => journalListTables(scoped, undefined, engine),
    );
    for (const [table, list] of journalled)
      if (tables.has(table))
        throw new Error(
          `Activation table ${table} is already used by the run-time model ${list}; it cannot also hold ${closure.models.join(', ')}`,
        );
    const before = new Set(ObjectRegistry.getAllClasses().keys());
    const allowed = new Set([
      ...closure.models,
      ...closure.modules.flatMap(
        (id) => options.manifest.modules[id].collections ?? [],
      ),
    ]);
    try {
      for (const id of closure.modules) {
        if (loaded.has(id)) continue;
        await options.loaders[id]();
        loaded.add(id);
      }
    } finally {
      for (const [id, entry] of ObjectRegistry.getAllClasses()) {
        if (
          !before.has(id) &&
          !allowed.has(id) &&
          !isFrameworkBaseClass(entry.name, entry.packageName)
        ) {
          invalidGraph = new Error(
            `Activation imported an undeclared model: ${id}; regenerate the activation manifest and restart`,
          );
        }
      }
    }
    if (invalidGraph) throw invalidGraph;
    for (const id of closure.models) {
      if (!ObjectRegistry.getClass(options.manifest.models[id].effective))
        throw new Error(`Activation loader did not register ${id}`);
    }
    // A stale/incomplete graph must never silently migrate an extra table.
    const schemas = ObjectRegistry.getAllSchemasAsDefinitions({
      tables: closure.tables,
    });
    const expected = new Set(closure.tables);
    if (
      Object.keys(schemas).some((table) => !expected.has(table)) ||
      closure.tables.some((table) => !schemas[table])
    ) {
      throw new Error(
        'SMRT activation manifest disagrees with registered physical tables; regenerate it',
      );
    }
    await runSerializedAgainstSystemTableBootstrap(db, engine, async (tx) =>
      // A refused run applies nothing; never publish readiness on it.
      assertMigrationAccepted(
        await migrateSmrtSchemas({
          db: tx,
          packageName: options.packageName,
          engineHint: engine,
          ...(engine === 'postgres'
            ? {
                atomic: true,
                postgresSafe: false,
                useConcurrentIndexes: false,
              }
            : {}),
          name: `smrt_activation_${randomUUID()}`,
          tables: closure.tables,
          requireComplete: true,
        }),
      ),
    );
  };
  const coordinator: ActivationCoordinator = {
    manifest: options.manifest,
    async boot() {
      await coordinator.activate(await options.readEnabled());
    },
    activate(requested, call) {
      // Before any lookup, queue or await: a holder of the migration lock
      // must not join the queue or a pending activation waiting for it.
      refuseInsideMigrationLockHolder('activation-inside-holder');
      const deadline =
        call?.migrationLockDeadline ??
        startMigrationLockDeadline(options.migrationLockTimeout);
      // Validate before scheduling or importing anything. Capture iterators now.
      const closure = activationClosure(options.manifest, [
        ...(options.alwaysOn ?? []),
        ...requested,
      ]);
      const key = JSON.stringify(closure.models);
      const existing = pending.get(key);
      // A pending activation started earlier under this coordinator's own
      // timeout settles no later than this call's deadline: share it. A
      // deadline carried from an outer entry point bounds this caller alone.
      if (existing && !call?.migrationLockDeadline) return existing;
      if (existing)
        return raceMigrationLockDeadline(
          deadline,
          existing,
          () =>
            new MigrationLockTimeoutError(deadline.now() - deadline.startedAt, {
              phase: 'queue',
            }),
        );
      const work = enqueueRuntimeSchemaActivation(async () => {
        if (closure.models.every((id) => ready.has(id))) return;
        if (invalidGraph) throw invalidGraph;
        // A standalone run-time model (an app editor list: `runtime-model:`,
        // extending nothing, replacing nothing) can already hold one of these
        // tables. Refuse before importing anything, so the process keeps one
        // class family per table. Run-time subclasses and replacements of a
        // model share its table legitimately and are not refused (the same
        // rule as the migrate's buildOwnedTables).
        const tables = new Set(closure.tables);
        for (const entry of ObjectRegistry.getAllClasses().values()) {
          const id = entry.qualifiedName ?? entry.name;
          const standaloneRuntime =
            entry.sourceFilePath?.startsWith('runtime-model:') === true &&
            (!entry.extends || entry.extends === 'SmrtObject') &&
            !entry.replacedQualifiedNames?.length;
          if (!standaloneRuntime) continue;
          // A list holding a closure model's own identity is refused too.
          if (closure.models.includes(id))
            throw new Error(
              `Activation model ${id} is already registered as a run-time list; it cannot also be loaded as an installed model`,
            );
          const table = ObjectRegistry.getTableName(id);
          if (table && tables.has(table))
            throw new Error(
              `Activation table ${table} is already used by the run-time model ${id}; it cannot also hold ${closure.models.join(', ')}`,
            );
        }
        // From the ownership check to the migration's commit the migration
        // lock is held (on PostgreSQL, on one pinned connection): an editor
        // claims a table only inside its own locked revision, so the check is
        // authoritative and nothing is imported for a refused table. Nothing
        // is opened on the pool before the lock is held.
        await withMigrationLock(
          options.db,
          (lock) => activateLocked(lock.db, closure, tables),
          { engineHint: engine, deadline },
        );
        // No await between successful migration and publication. A failed import,
        // diff or transaction never publishes readiness. Retry re-diffs committed DDL.
        for (const id of closure.models) ready.add(id);
        notifyRuntimeExposureChanged();
      }, deadline);
      // Rejection must not poison the process queue or the next retry.
      pending.set(key, work);
      void work.finally(() => pending.delete(key)).catch(() => {});
      return work;
    },
    isReady(model) {
      const id = typeof model === 'string' ? model : model.qualifiedName;
      if (!id) return false;
      const runtimeReady = getRuntimeModelReadiness(id);
      if (runtimeReady !== undefined) return runtimeReady;
      const effective = options.manifest.models[id]?.effective;
      return !!effective && ready.has(effective);
    },
    gate(exposure) {
      return {
        isEnabled: (model, context) =>
          (model.qualifiedName === COOKBOOK_TOOLS_MODEL ||
            coordinator.isReady(model)) &&
          exposure.isEnabled(model, context) === true,
        subscribe: exposure.subscribe?.bind(exposure),
      };
    },
  };
  process.slots.set(options.scope, { db: options.db, signature, coordinator });
  return coordinator;
}
