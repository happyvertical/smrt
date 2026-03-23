import type { DatabaseInterface } from '@happyvertical/sql';
import { detectEngine } from '../schema/ddl/index.js';

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
    const engine = detectEngine(db.url || '');
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

async function addColumnIfMissing(
  db: DatabaseInterface,
  tableName: string,
  columnName: string,
  definition: string,
): Promise<void> {
  if (await columnExists(db, tableName, columnName)) {
    return;
  }

  await db.query(
    `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`,
  );
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
