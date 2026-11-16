/** Node-only, opt-in activation. Application DDL stays in the migration tracker. */
import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type ActivationManifest,
  activationClosure,
} from './activation/manifest.js';
import { resolveMigrationEngine } from './migrations/differ.js';
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
}

export interface ActivationCoordinator {
  /** Recover the persisted union before accepting requests. Safe to retry after failure. */
  boot(): Promise<void>;
  /** Await BEFORE publishing/persisting cookbook enablement. Never unloads or drops on disable. */
  activate(models: Iterable<string>): Promise<void>;
  isReady(model: RuntimeExposureModel | string): boolean;
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

/** Serialize explicit runtime schema writers sharing the process-wide registry. */
export function withRuntimeSchemaActivation<T>(
  work: () => Promise<T>,
): Promise<T> {
  globalThis.__smrtActivation ??= { tail: Promise.resolve(), slots: new Map() };
  const process = globalThis.__smrtActivation;
  const operation = process.tail.then(work);
  process.tail = operation.then(
    () => {},
    () => {},
  );
  return operation;
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
  const coordinator: ActivationCoordinator = {
    async boot() {
      await coordinator.activate(await options.readEnabled());
    },
    activate(requested) {
      // Validate before scheduling or importing anything. Capture iterators now.
      const closure = activationClosure(options.manifest, [
        ...(options.alwaysOn ?? []),
        ...requested,
      ]);
      const key = JSON.stringify(closure.models);
      const existing = pending.get(key);
      if (existing) return existing;
      const work = withRuntimeSchemaActivation(async () => {
        if (closure.models.every((id) => ready.has(id))) return;
        if (invalidGraph) throw invalidGraph;
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
        await runSerializedAgainstSystemTableBootstrap(
          options.db,
          engine,
          async (db) =>
            // A refused run applies nothing; never publish readiness on it.
            assertMigrationAccepted(
              await migrateSmrtSchemas({
                db,
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
        // No await between successful migration and publication. A failed import,
        // diff or transaction never publishes readiness. Retry re-diffs committed DDL.
        for (const id of closure.models) ready.add(id);
        notifyRuntimeExposureChanged();
      });
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
