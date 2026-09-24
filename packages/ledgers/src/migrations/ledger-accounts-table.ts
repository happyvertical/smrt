/**
 * One-time move of ledger accounts out of the shared `accounts` table (#3098).
 *
 * Until 0.51.24 the ledger `Account` derived the table name `accounts`, which
 * smrt-messages' unrelated `Account` also derives. A database may therefore
 * hold ledger accounts in `accounts` alone (ledgers only), or mixed with
 * messaging accounts in one union table (both packages, after `db:migrate`).
 * The ledger model now owns `ledger_accounts`; this migration moves the
 * existing ledger rows there, detaches the foreign keys that pointed ledger
 * references at `accounts`, and leaves messaging rows where they are.
 *
 * Operator sequence (maintenance window, PostgreSQL):
 *   1. `smrt db:migrate` — creates `ledger_accounts` from the manifest. It
 *      reports, and does not apply, the retargeted `journal_entries.account_id`
 *      foreign key while the old one still points at `accounts`.
 *   2. `smrt db:migrate-ledger-accounts` — this module.
 *   3. `smrt db:migrate` — adds the foreign keys onto `ledger_accounts`.
 */

import { detectEngine, ObjectRegistry } from '@happyvertical/smrt-core';
import {
  BackfillTracker,
  type DatabaseInterface,
} from '@happyvertical/smrt-core/migrations';

export const LEDGER_ACCOUNTS_TABLE = 'ledger_accounts';
export const LEGACY_ACCOUNTS_TABLE = 'accounts';
export const LEDGER_ACCOUNTS_TABLE_MOVE =
  '@happyvertical/smrt-ledgers:ledger-accounts-table:v1';

/**
 * Columns that only the legacy ledger model put on `accounts`. Their presence
 * identifies a table that may hold ledger rows; this is a fact about the
 * pre-#3098 data being migrated, not a schema definition.
 */
const LEGACY_LEDGER_SIGNATURE = ['number', 'type'] as const;

/** The STI discriminator smrt-messages writes on every messaging account. */
const STI_DISCRIMINATOR = '_meta_type';

/** Messaging columns that a ledger row never populates. */
const MESSAGING_MARKERS = ['provider_type', 'channel_type'] as const;

export interface LedgerAccountsTableMoveOptions {
  backfillName?: string;
  packageName?: string;
  /** PostgreSQL `lock_timeout`, milliseconds (default 30000). */
  lockTimeout?: number;
  /** PostgreSQL `statement_timeout`, milliseconds (default 60000). */
  statementTimeout?: number;
}

export interface LedgerAccountsTableMovePlan {
  /** Whether a legacy `accounts` table with ledger columns exists. */
  legacyTable: boolean;
  /** Ledger rows still in `accounts` that this migration would move. */
  pending: number;
  /** Messaging rows that stay in `accounts`. */
  messagingRows: number;
}

export interface LedgerAccountsTableMoveResult {
  ran: boolean;
  moved: number;
  /** Rows (messaging accounts) left in `accounts`. */
  remainingLegacyRows: number;
  /** `table.column` foreign keys detached from `accounts`. */
  detachedForeignKeys: string[];
}

export class LedgerAccountsTableMoveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerAccountsTableMoveError';
  }
}

type Queryable = Pick<DatabaseInterface, 'query'>;

interface LegacyShape {
  columns: Set<string>;
  hasDiscriminator: boolean;
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function timeout(value: number | undefined, fallback: number): string {
  const milliseconds = value ?? fallback;
  if (!Number.isInteger(milliseconds) || milliseconds < 0) {
    throw new LedgerAccountsTableMoveError(
      'Migration timeout must be a non-negative integer',
    );
  }
  return `${milliseconds}ms`;
}

function assertPostgres(db: DatabaseInterface): void {
  const withConfig = db as DatabaseInterface & {
    type?: string;
    config?: { type?: string; url?: string };
  };
  const engine = detectEngine(
    db.url || withConfig.config?.url || '',
    withConfig.type || withConfig.config?.type,
  );
  if (engine !== 'postgres') {
    throw new LedgerAccountsTableMoveError(
      'The ledger accounts table move supports PostgreSQL only. For a SQLite database whose `accounts` table holds only ledger accounts, run `ALTER TABLE accounts RENAME TO ledger_accounts` before `db:migrate`; see the smrt-ledgers README.',
    );
  }
}

async function readLegacyShape(
  db: DatabaseInterface,
): Promise<LegacyShape | null> {
  const schema = await db.getTableSchema?.(LEGACY_ACCOUNTS_TABLE);
  if (!schema) return null;
  const columns = new Set(Object.keys(schema.columns));
  if (!LEGACY_LEDGER_SIGNATURE.every((column) => columns.has(column))) {
    return null;
  }
  return { columns, hasDiscriminator: columns.has(STI_DISCRIMINATOR) };
}

/** SQL predicate selecting the ledger rows of the legacy table. */
function ledgerRowPredicate(shape: LegacyShape): string {
  return shape.hasDiscriminator
    ? `(${quote(STI_DISCRIMINATOR)} IS NULL OR ${quote(STI_DISCRIMINATOR)} = '')`
    : 'TRUE';
}

async function count(db: Queryable, where: string): Promise<number> {
  const result = await db.query(
    `SELECT COUNT(*) AS n FROM ${quote(LEGACY_ACCOUNTS_TABLE)} WHERE ${where}`,
  );
  return Number((result.rows[0] as { n: number | string }).n);
}

async function classify(
  db: Queryable,
  shape: LegacyShape,
): Promise<{ pending: number; messagingRows: number }> {
  const ledger = ledgerRowPredicate(shape);
  const pending = await count(db, ledger);
  const messagingRows = shape.hasDiscriminator
    ? await count(db, `NOT ${ledger}`)
    : 0;

  // Refuse rows whose owner is not certain rather than guess. A messaging
  // row never carries a ledger account number; a ledger row never carries a
  // messaging provider or channel.
  if (shape.hasDiscriminator) {
    const ledgerLooking = await count(
      db,
      `NOT ${ledger} AND COALESCE(${quote('number')}, '') <> ''`,
    );
    const markers = MESSAGING_MARKERS.filter((column) =>
      shape.columns.has(column),
    );
    const messagingLooking =
      markers.length === 0
        ? 0
        : await count(
            db,
            `${ledger} AND (${markers
              .map((column) => `COALESCE(${quote(column)}, '') <> ''`)
              .join(' OR ')})`,
          );
    if (ledgerLooking > 0 || messagingLooking > 0) {
      throw new LedgerAccountsTableMoveError(
        `Refusing to move ledger accounts: ${ledgerLooking} messaging row(s) carry a ledger account number and ${messagingLooking} ledger row(s) carry a messaging provider or channel in "${LEGACY_ACCOUNTS_TABLE}". Resolve their ownership by hand, then rerun.`,
      );
    }
  }
  return { pending, messagingRows };
}

/**
 * Every `table.column` the registered manifests point at `ledger_accounts` —
 * the references that pointed at `accounts` before #3098.
 */
function ledgerReferenceColumns(): Set<string> {
  const references = new Set<string>();
  const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
  for (const [tableName, schema] of Object.entries(schemas)) {
    for (const [columnName, column] of Object.entries(schema.columns ?? {})) {
      const target = (column as { foreignKey?: { table?: string } }).foreignKey
        ?.table;
      if (target === LEDGER_ACCOUNTS_TABLE) {
        references.add(`${tableName}.${columnName}`);
      }
    }
  }
  return references;
}

async function legacyForeignKeys(
  db: Queryable,
): Promise<Array<{ constraint: string; table: string; column: string }>> {
  const result = await db.query(
    `SELECT con.conname AS constraint_name,
            rel.relname AS table_name,
            att.attname AS column_name
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_attribute att
         ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
      WHERE con.contype = 'f'
        AND con.confrelid = to_regclass(?)
        AND array_length(con.conkey, 1) = 1
      ORDER BY rel.relname, con.conname`,
    quote(LEGACY_ACCOUNTS_TABLE),
  );
  return (
    result.rows as Array<{
      constraint_name: string;
      table_name: string;
      column_name: string;
    }>
  ).map((row) => ({
    constraint: row.constraint_name,
    table: row.table_name,
    column: row.column_name,
  }));
}

/** Inspect the legacy table without changing anything. */
export async function planLedgerAccountsTableMove(
  db: DatabaseInterface,
): Promise<LedgerAccountsTableMovePlan> {
  assertPostgres(db);
  const shape = await readLegacyShape(db);
  if (!shape) return { legacyTable: false, pending: 0, messagingRows: 0 };
  return { legacyTable: true, ...(await classify(db, shape)) };
}

/**
 * Move ledger accounts from `accounts` into `ledger_accounts` in one
 * transaction under an exclusive lock. Operator-invoked and idempotent: a
 * rerun, or a database that never had ledger rows in `accounts`, is a no-op.
 */
export async function migrateLedgerAccountsTable(
  db: DatabaseInterface,
  options: LedgerAccountsTableMoveOptions = {},
): Promise<LedgerAccountsTableMoveResult> {
  assertPostgres(db);
  if (!db.transaction) {
    throw new LedgerAccountsTableMoveError(
      'The ledger accounts table move requires a transaction-capable PostgreSQL adapter',
    );
  }
  const noop = (remainingLegacyRows = 0): LedgerAccountsTableMoveResult => ({
    ran: false,
    moved: 0,
    remainingLegacyRows,
    detachedForeignKeys: [],
  });

  const shape = await readLegacyShape(db);
  if (!shape) return noop();
  const target = await db.getTableSchema?.(LEDGER_ACCOUNTS_TABLE);
  if (!target) {
    throw new LedgerAccountsTableMoveError(
      `"${LEDGER_ACCOUNTS_TABLE}" does not exist; run db:migrate before moving ledger accounts`,
    );
  }
  const legacy = await db.getTableSchema?.(LEGACY_ACCOUNTS_TABLE);
  const copyColumns = Object.keys(target.columns).filter((column) =>
    shape.columns.has(column),
  );
  const references = ledgerReferenceColumns();

  const tracker = new BackfillTracker({ db });
  await tracker.initialize();
  const backfillName = options.backfillName ?? LEDGER_ACCOUNTS_TABLE_MOVE;

  return db.transaction(async (tx) => {
    BackfillTracker.inheritInitialization(tx, db);
    const transactionTracker = new BackfillTracker({ db: tx });
    await tx.query(
      `SET LOCAL lock_timeout = '${timeout(options.lockTimeout, 30_000)}'`,
    );
    await tx.query(
      `SET LOCAL statement_timeout = '${timeout(options.statementTimeout, 60_000)}'`,
    );
    await tx.query(
      `LOCK TABLE ${quote(LEGACY_ACCOUNTS_TABLE)}, ${quote(LEDGER_ACCOUNTS_TABLE)} IN ACCESS EXCLUSIVE MODE`,
    );

    const { pending, messagingRows } = await classify(tx, shape);
    if (await transactionTracker.isApplied(backfillName)) {
      if (pending > 0) {
        throw new LedgerAccountsTableMoveError(
          `The ledger accounts table move is recorded as applied but "${LEGACY_ACCOUNTS_TABLE}" still holds ${pending} ledger row(s); refusing inconsistent state`,
        );
      }
      return noop(messagingRows);
    }

    const ledger = ledgerRowPredicate(shape);
    const clash = await tx.query(
      `SELECT COUNT(*) AS n FROM ${quote(LEGACY_ACCOUNTS_TABLE)} legacy
        WHERE ${ledger}
          AND EXISTS (SELECT 1 FROM ${quote(LEDGER_ACCOUNTS_TABLE)} moved
                       WHERE moved.id = legacy.id)`,
    );
    if (Number((clash.rows[0] as { n: number | string }).n) > 0) {
      throw new LedgerAccountsTableMoveError(
        `"${LEDGER_ACCOUNTS_TABLE}" already holds ids of ledger rows still in "${LEGACY_ACCOUNTS_TABLE}"; refusing to overwrite`,
      );
    }

    // Copy values as they are; convert only a column whose legacy type
    // differs from the manifest's (e.g. TEXT ids where ledger_accounts now
    // declares UUID), through its text form.
    const selectList = copyColumns
      .map((column) => {
        const to = target.columns[column]?.type;
        const from = legacy?.columns[column]?.type;
        return sameType(from, to)
          ? quote(column)
          : `CAST(CAST(${quote(column)} AS TEXT) AS ${targetType(to)})`;
      })
      .join(', ');
    await tx.query(
      `INSERT INTO ${quote(LEDGER_ACCOUNTS_TABLE)} (${copyColumns
        .map(quote)
        .join(', ')})
       SELECT ${selectList} FROM ${quote(LEGACY_ACCOUNTS_TABLE)} WHERE ${ledger}`,
    );

    // Detach the ledger references (journal entries, and anything else the
    // manifests now point at ledger_accounts) from the legacy table. The
    // next db:migrate adds them against ledger_accounts. References owned by
    // messaging (emails, messages, routes) keep pointing at accounts.
    const detached: string[] = [];
    for (const foreignKey of await legacyForeignKeys(tx)) {
      const key = `${foreignKey.table}.${foreignKey.column}`;
      if (!references.has(key)) continue;
      await tx.query(
        `ALTER TABLE ${quote(foreignKey.table)} DROP CONSTRAINT ${quote(foreignKey.constraint)}`,
      );
      detached.push(key);
    }

    // Any remaining reference to a moved row fails this DELETE, rolling the
    // whole move back rather than orphaning it.
    try {
      await tx.query(
        `DELETE FROM ${quote(LEGACY_ACCOUNTS_TABLE)} WHERE ${ledger}`,
      );
    } catch (error) {
      if (!isForeignKeyViolation(error)) throw error;
      throw new LedgerAccountsTableMoveError(
        `A foreign key no registered model declares still references ledger accounts in "${LEGACY_ACCOUNTS_TABLE}"; nothing was moved. Run the move from the application whose models declare that reference, or retarget the constraint to "${LEDGER_ACCOUNTS_TABLE}" by hand, then rerun.`,
      );
    }

    await transactionTracker.recordApplied(backfillName, {
      description:
        'Moved ledger accounts from the shared accounts table to ledger_accounts (#3098).',
      packageName: options.packageName ?? '@happyvertical/smrt-ledgers',
    });
    return {
      ran: true,
      moved: pending,
      remainingLegacyRows: messagingRows,
      detachedForeignKeys: detached,
    };
  });
}

/** PostgreSQL `foreign_key_violation` (23503), through adapter wrapping. */
function isForeignKeyViolation(error: unknown): boolean {
  for (
    let current: unknown = error, depth = 0;
    current && depth < 5;
    current = (current as { cause?: unknown }).cause, depth++
  ) {
    const { code, message } = current as { code?: unknown; message?: unknown };
    if (code === '23503') return true;
    if (
      typeof message === 'string' &&
      message.includes('violates foreign key constraint')
    ) {
      return true;
    }
  }
  return false;
}

const SQL_TYPE = /^[A-Za-z][A-Za-z0-9 _]*(\(\d+(,\s*\d+)?\))?(\[\])?$/;

function sameType(from: string | undefined, to: string | undefined): boolean {
  return (
    from !== undefined &&
    to !== undefined &&
    from.trim().toLowerCase() === to.trim().toLowerCase()
  );
}

function targetType(declared: string | undefined): string {
  const type = declared?.trim();
  if (!type || !SQL_TYPE.test(type)) {
    throw new LedgerAccountsTableMoveError(
      `Cannot copy into "${LEDGER_ACCOUNTS_TABLE}": unsupported live column type ${JSON.stringify(type)}`,
    );
  }
  return type;
}
