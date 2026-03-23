import type { DatabaseInterface } from '@happyvertical/sql';
import { detectEngine } from '../schema/ddl/index.js';

type DatabaseWithConfig = DatabaseInterface & {
  config?: {
    url?: string;
  };
};

function getQueryRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result as Record<string, unknown>[];
  }

  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) {
      return rows as Record<string, unknown>[];
    }
  }

  return [];
}

async function tableExists(
  db: DatabaseInterface,
  tableName: string,
): Promise<boolean> {
  try {
    await db.query(`SELECT 1 FROM ${tableName} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

async function columnExists(
  db: DatabaseInterface,
  tableName: string,
  columnName: string,
): Promise<boolean> {
  try {
    const engine = detectEngine(getDatabaseUrl(db));
    if (engine === 'postgres') {
      const result = await db.query(
        'SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 LIMIT 1',
        tableName,
        columnName,
      );
      return getQueryRows(result).length > 0;
    }

    const result = await db.query(`PRAGMA table_info(${tableName})`);
    return getQueryRows(result).some((row) => row.name === columnName);
  } catch {
    return false;
  }
}

function getDatabaseUrl(db: DatabaseInterface): string {
  const dbWithConfig = db as DatabaseWithConfig;
  return db.url || dbWithConfig.config?.url || '';
}

function isDuplicateColumnError(error: unknown): boolean {
  const message =
    error && typeof error === 'object'
      ? String((error as { message?: unknown }).message || error)
      : String(error);

  return (
    /column .*already exists/i.test(message) ||
    /duplicate column name/i.test(message)
  );
}

async function addColumnIfMissing(
  db: DatabaseInterface,
  tableName: string,
  columnName: string,
  definition: string,
): Promise<void> {
  const engine = detectEngine(getDatabaseUrl(db));

  if (engine === 'postgres') {
    await db.query(
      `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS ${columnName} ${definition}`,
    );
    return;
  }

  if (await columnExists(db, tableName, columnName)) {
    return;
  }

  try {
    await db.query(
      `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`,
    );
  } catch (error) {
    if (isDuplicateColumnError(error)) {
      return;
    }

    throw error;
  }
}

async function addIndexIfMissing(
  db: DatabaseInterface,
  indexName: string,
  tableName: string,
  columnName: string,
): Promise<void> {
  await db.query(
    `CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName}(${columnName})`,
  );
}

export async function ensureDispatchSystemTableCompatibility(
  db: DatabaseInterface,
): Promise<void> {
  if (!(await tableExists(db, '_smrt_dispatch'))) {
    return;
  }

  await addColumnIfMissing(db, '_smrt_dispatch', 'target_subscriber', 'TEXT');
  await addColumnIfMissing(db, '_smrt_dispatch', 'correlation_id', 'TEXT');
  await addIndexIfMissing(
    db,
    'idx_smrt_dispatch_target',
    '_smrt_dispatch',
    'target_subscriber',
  );
  await addIndexIfMissing(
    db,
    'idx_smrt_dispatch_correlation',
    '_smrt_dispatch',
    'correlation_id',
  );
}

export async function ensureDispatchSubscriptionsSystemTableCompatibility(
  db: DatabaseInterface,
): Promise<void> {
  if (!(await tableExists(db, '_smrt_dispatch_subscriptions'))) {
    return;
  }

  await addColumnIfMissing(
    db,
    '_smrt_dispatch_subscriptions',
    'delivery',
    "TEXT NOT NULL DEFAULT 'compete'",
  );
}

export async function ensureLegacySystemTableCompatibility(
  db: DatabaseInterface,
): Promise<void> {
  await ensureDispatchSystemTableCompatibility(db);
  await ensureDispatchSubscriptionsSystemTableCompatibility(db);
}
