import type { DatabaseInterface } from '@happyvertical/sql';
import corePackage from '../../package.json' with { type: 'json' };
import { withEmbeddedWriteQueue } from '../embedded-write-queue.js';
import { ObjectRegistry } from '../registry.js';
import type { DatabaseEngine } from '../schema/ddl/types.js';
import type {
  RetireConfirmationSource,
  SchemaChange,
  SchemaDefinition,
} from '../schema/types.js';
import {
  ensureSystemTables,
  runSerializedAgainstSystemTableBootstrap,
} from '../system/bootstrap.js';
import { getDatabaseEngine, tableExists } from '../system/compatibility.js';
import {
  type BuildSchema,
  resolveBuildSchema,
  resolveRetiredTables,
} from './build-schema.js';
import type { PackagesSeenInput } from './migration-run-decision.js';
import { computeSchemaFingerprint } from './schema-fingerprint.js';

export interface MigrateRecordInput {
  release: string;
  packages: string[];
  fingerprint: string;
  /**
   * How this run compares with the build (absent when no build was found).
   * Never written to the record; read by the package check and its notices.
   */
  build?: {
    source: string;
    /** The build's stamp, when it has one. */
    fingerprint?: string;
    /** Another project manifest describes a different schema: which was used. */
    notice?: string;
    /** Build tables this run has not planned, grouped by package. */
    unloaded: UnloadedBuildPackage[];
  };
}

/**
 * A retirement the operator confirmed over a definition mismatch (#5005), as
 * the migrate run that dropped the table records it.
 */
export interface ConfirmedRetirement {
  table: string;
  /** The declaring package(s). */
  packageName: string;
  lastOwner: string;
  since: string;
  /** `flag`: `--confirm-retire-table`; `code`: `confirmRetireTables`. */
  by: RetireConfirmationSource;
  /** The differences confirmed, one per release tried. */
  differences: string[];
}

/** The confirmed retirements among a run's planned drops. */
export function confirmedRetirementsOf(
  changes: readonly SchemaChange[],
): ConfirmedRetirement[] {
  return changes.flatMap((change) => {
    const retirement = change.retirement;
    if (
      change.type !== 'retire_table' ||
      change.kindHint !== 'table.retire' ||
      !retirement?.confirmed
    )
      return [];
    return [
      {
        table: change.table,
        packageName: retirement.packageName,
        lastOwner: retirement.lastOwner,
        since: retirement.since,
        by: retirement.confirmed.by,
        differences: [...retirement.confirmed.differences],
      },
    ];
  });
}

export interface UnloadedBuildPackage {
  packageName: string;
  tables: string[];
}

export interface MigrateRecord {
  release: string;
  packages: string[];
  fingerprint: string;
  createdAt: string;
}

export type LastMigrateRecord =
  | { state: 'none' }
  | { state: 'recorded'; record: MigrateRecord };

export interface MigrateRecordOptions {
  engineHint?: DatabaseEngine;
}

/** A migrate record that carries confirmed retirements (#5005). */
export interface ConfirmedRetirementRecord {
  createdAt: string;
  release: string;
  retirements: ConfirmedRetirement[];
}

function packageOf(name: string): string {
  const separator = name.lastIndexOf(':');
  return separator > 0 ? name.slice(0, separator) : '<unqualified>';
}

/**
 * What a successful migrate records, the same for every writer (the CLI and
 * `migrateSmrtSchemas`) and every install, given the same build:
 * - `fingerprint`: the planned schema restricted to the build's tables, which
 *   equals the build's stamp when the declarations agree (#4929);
 * - `packages`: the packages that contribute tables to the build (#4928).
 * With no build (see `resolveBuildSchema`), the whole planned schema and the
 * package of every registered class, as before.
 */
export function collectMigrateRecordInput(
  build: BuildSchema | undefined = resolveBuildSchema(),
): MigrateRecordInput {
  const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
  if (!build) {
    // No build known (unchanged from #4926): every registered class counts.
    const packages = new Set<string>();
    for (const [key, registered] of ObjectRegistry.getAllClasses())
      packages.add(packageOf(registered.qualifiedName ?? key));
    return {
      release: corePackage.version,
      packages: [...packages].sort(),
      // The retired list the plan uses, so the stamp covers what it drops.
      fingerprint: computeSchemaFingerprint(schemas, {
        retired: resolveRetiredTables(build),
      }),
    };
  }
  const unloaded = new Map<string, string[]>();
  const planned: SchemaDefinition[] = [];
  for (const [table, owners] of Object.entries(build.tables)) {
    const schema = schemas[table];
    if (schema) {
      planned.push(schema);
      continue;
    }
    for (const owner of owners) {
      unloaded.set(owner, [...(unloaded.get(owner) ?? []), table]);
    }
  }
  return {
    release: corePackage.version,
    packages: [...build.packages],
    // The retired list the plan uses (the build's own), which the build's
    // stamp covers (#5005).
    fingerprint: computeSchemaFingerprint(planned, {
      retired: resolveRetiredTables(build),
    }),
    build: {
      source: build.source,
      ...(build.fingerprint ? { fingerprint: build.fingerprint } : {}),
      ...(build.notice ? { notice: build.notice } : {}),
      unloaded: [...unloaded]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([packageName, tables]) => ({ packageName, tables })),
    },
  };
}

/**
 * The package-check input every writer passes to `decideMigrationRun`: the
 * last record's packages against this run's (both from the build), plus how
 * this run's plan covers the build.
 */
export function packagesSeenInput(
  current: MigrateRecordInput,
  last: LastMigrateRecord,
  confirmedRemoved: readonly string[] = [],
): PackagesSeenInput {
  return {
    recorded: last.state === 'recorded' ? last.record.packages : null,
    current: current.packages,
    confirmedRemoved,
    ...(current.build
      ? {
          build: {
            ...(current.build.fingerprint
              ? { fingerprint: current.build.fingerprint }
              : {}),
            ...(current.build.notice ? { notice: current.build.notice } : {}),
            planned: current.fingerprint,
            unloaded: current.build.unloaded,
          },
        }
      : {}),
  };
}

/** SELECT-only: an older or empty database is explicitly a first run. */
export async function readLastMigrateRecord(
  db: DatabaseInterface,
  options: MigrateRecordOptions = {},
): Promise<LastMigrateRecord> {
  if (!(await tableExists(db, '_smrt_migrate_runs', options.engineHint))) {
    return { state: 'none' };
  }
  const result = await db.query(
    'SELECT release, packages, fingerprint, created_at FROM _smrt_migrate_runs ORDER BY created_at DESC, id DESC LIMIT 1',
  );
  const rows = Array.isArray(result) ? result : result.rows;
  const row = rows[0];
  if (!row) return { state: 'none' };
  return {
    state: 'recorded',
    record: {
      release: String(row.release),
      packages: JSON.parse(String(row.packages)) as string[],
      fingerprint: String(row.fingerprint),
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    },
  };
}

/**
 * Append only when the successful migrate's declarations changed. Uses the
 * supplied handle (and any caller-held migration lock); no tracker required.
 * Bootstrap serialization also makes the read/insert atomic on PostgreSQL.
 */
export async function recordSuccessfulMigrate(
  db: DatabaseInterface,
  options: MigrateRecordOptions & {
    input?: MigrateRecordInput;
    /**
     * Retirements this run dropped over a confirmed definition mismatch
     * (#5005). A run with any writes a record even when its declarations are
     * unchanged, so every confirmation is on the ledger.
     */
    confirmedRetirements?: readonly ConfirmedRetirement[];
  } = {},
): Promise<{ written: boolean; record: MigrateRecord }> {
  const input = options.input ?? collectMigrateRecordInput();
  const packages = [...new Set(input.packages)].sort();
  const confirmed = options.confirmedRetirements ?? [];
  return withEmbeddedWriteQueue(
    db,
    getDatabaseEngine(db, options.engineHint) !== 'postgres',
    async () => {
      await ensureSystemTables(db, options.engineHint);
      return runSerializedAgainstSystemTableBootstrap(
        db,
        options.engineHint,
        async (scopedDb) => {
          const previous = await readLastMigrateRecord(scopedDb, options);
          if (
            confirmed.length === 0 &&
            previous.state === 'recorded' &&
            previous.record.release === input.release &&
            previous.record.fingerprint === input.fingerprint &&
            JSON.stringify(previous.record.packages) ===
              JSON.stringify(packages)
          ) {
            return { written: false, record: previous.record };
          }
          // Strictly increasing timestamps preserve latest-row order even for rapid
          // calls in one transaction (CURRENT_TIMESTAMP is transaction-stable on PG).
          const previousTime =
            previous.state === 'recorded'
              ? Date.parse(previous.record.createdAt)
              : 0;
          const createdAt = new Date(
            Math.max(Date.now(), previousTime + 1),
          ).toISOString();
          const record = {
            release: input.release,
            fingerprint: input.fingerprint,
            packages,
            createdAt,
          };
          const id = crypto.randomUUID();
          const serializedPackages = JSON.stringify(packages);
          const confirmedRetirements = confirmed.length
            ? JSON.stringify(confirmed)
            : null;
          await scopedDb.execute`
      INSERT INTO _smrt_migrate_runs (id, release, packages, fingerprint, created_at, confirmed_retirements)
      VALUES (${id}, ${input.release}, ${serializedPackages}, ${input.fingerprint}, ${createdAt}, ${confirmedRetirements})
    `;
          return { written: true, record };
        },
      );
    },
  );
}

/**
 * The migrate records that carry confirmed retirements, oldest first
 * (#5005). SELECT-only; empty when there is no ledger.
 */
export async function readConfirmedRetirements(
  db: DatabaseInterface,
  options: MigrateRecordOptions = {},
): Promise<ConfirmedRetirementRecord[]> {
  if (!(await tableExists(db, '_smrt_migrate_runs', options.engineHint)))
    return [];
  const result = await db.query(
    'SELECT release, created_at, confirmed_retirements FROM _smrt_migrate_runs WHERE confirmed_retirements IS NOT NULL ORDER BY created_at, id',
  );
  const rows = Array.isArray(result) ? result : result.rows;
  return rows.map((row) => {
    return {
      release: String(row.release),
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
      retirements: JSON.parse(
        String(row.confirmed_retirements),
      ) as ConfirmedRetirement[],
    };
  });
}
