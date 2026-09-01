import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getDatabase } from '@happyvertical/sql';

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quoteIdentifier(value) {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(
      'The generated manifest contains an unsafe SQL identifier.',
    );
  }
  return `"${value}"`;
}

function manifestTables(sourceRoot) {
  const manifestPath = join(sourceRoot, '.smrt', 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error('Build the application before exporting or importing data.');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const tables = new Map();
  for (const definition of Object.values(manifest.objects || {})) {
    const schema = definition?.schema;
    if (definition?.className?.endsWith('Collection')) continue;
    if (!schema?.tableName || schema.tableName.startsWith('_smrt_')) continue;
    const columnDefinitions = schema.columns || {};
    const columns = Object.keys(columnDefinitions);
    if (columns.length === 0) continue;
    const foreignKeys = Object.entries(columnDefinitions).flatMap(
      ([column, definition]) =>
        definition.foreignKey?.table
          ? [{ column, referencesTable: definition.foreignKey.table }]
          : [],
    );
    const primaryKeys = Object.entries(columnDefinitions)
      .filter(([, definition]) => definition.primaryKey)
      .map(([column]) => column);
    tables.set(schema.tableName, {
      name: schema.tableName,
      columns,
      columnDefinitions,
      foreignKeys,
      primaryKeys,
    });
  }
  return [...tables.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

/** Parent-first insertion plan with nullable cycle edges deferred to updates. */
export function planImportTables(tables) {
  const remaining = new Map(tables.map((table) => [table.name, table]));
  const inserted = new Set();
  const plan = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((table) =>
        table.foreignKeys.every(
          (foreignKey) =>
            foreignKey.referencesTable === table.name ||
            !remaining.has(foreignKey.referencesTable) ||
            inserted.has(foreignKey.referencesTable),
        ),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
    const table =
      ready[0] ||
      [...remaining.values()].sort((left, right) =>
        left.name.localeCompare(right.name),
      )[0];
    const deferredColumns = new Set(
      table.foreignKeys
        .filter(
          (foreignKey) =>
            foreignKey.referencesTable === table.name ||
            remaining.has(foreignKey.referencesTable),
        )
        .map((foreignKey) => foreignKey.column),
    );
    plan.push({ ...table, deferredColumns });
    inserted.add(table.name);
    remaining.delete(table.name);
  }
  return plan;
}

async function withDatabase(context, callback) {
  const db = await getDatabase({
    type: context.runtime.providers.database.engine,
    url: context.env.DATABASE_URL,
  });
  try {
    return await callback(db);
  } finally {
    await db.close?.();
  }
}

export function validateImportBundle(bundle, expected) {
  const providedNames = bundle.tables.map((table) => table?.name);
  if (
    providedNames.length !== expected.size ||
    new Set(providedNames).size !== expected.size ||
    providedNames.some((name) => !expected.has(name))
  ) {
    throw new Error(
      'The export does not contain the complete application schema.',
    );
  }
  for (const exported of bundle.tables) {
    const table = expected.get(exported.name);
    if (
      !table ||
      !Array.isArray(exported.rows) ||
      !Array.isArray(exported.columns)
    ) {
      throw new Error('The export does not match the generated application schema.');
    }
    if (
      exported.columns.length !== table.columns.length ||
      new Set(exported.columns).size !== table.columns.length ||
      exported.columns.some((column) => !table.columns.includes(column))
    ) {
      throw new Error(`The export schema does not match ${table.name}.`);
    }
    for (const row of exported.rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`The export has an invalid row for ${table.name}.`);
      }
      const columns = Object.keys(row);
      if (
        columns.length !== table.columns.length ||
        columns.some((column) => !table.columns.includes(column))
      ) {
        throw new Error(`The export has incomplete columns for ${table.name}.`);
      }
    }
  }
}

export async function exportApplication(context) {
  const tables = manifestTables(context.sourceRoot);
  let bundle;
  await withDatabase(context, async (db) => {
    if (typeof db.transaction !== 'function') {
      throw new Error('Logical export requires transactional database support.');
    }
    bundle = await db.transaction(async (tx) => {
      const exported = {
        schemaVersion: 1,
        application: context.appId,
        profile: context.runtime.profile,
        exportedAt: new Date().toISOString(),
        tables: [],
      };
      for (const table of tables) {
        const result = await tx.query(
          `SELECT ${table.columns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table.name)}`,
        );
        exported.tables.push({
          name: table.name,
          columns: table.columns,
          rows: result.rows,
        });
      }
      return exported;
    });
  });
  const outputPath =
    context.path ||
    join(
      context.stateRoot,
      'exports',
      `${context.appId}-${Date.now()}.json`,
    );
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, {
    mode: 0o600,
  });
  return { path: outputPath, tableCount: bundle.tables.length };
}

/** Execute a prevalidated parent-first import against one database transaction. */
export async function executeImportPlan(tx, plan, exportedByName) {
  const deferredUpdates = [];
  let rowCount = 0;
  for (const table of plan) {
    const exported = exportedByName.get(table.name);
    const count = await tx.query(
      `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)}`,
    );
    if (Number(count.rows[0]?.count || 0) !== 0) {
      throw new Error(`Import target table ${table.name} is not empty.`);
    }
    for (const row of exported.rows) {
      const columns = Object.keys(row);
      await tx.query(
        `INSERT INTO ${quoteIdentifier(table.name)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        ...columns.map((column) =>
          table.deferredColumns.has(column) ? null : row[column],
        ),
      );
      for (const column of table.deferredColumns) {
        if (row[column] != null) {
          deferredUpdates.push({
            table,
            column,
            value: row[column],
            primaryKey: table.primaryKeys[0],
            primaryValue: row[table.primaryKeys[0]],
          });
        }
      }
      rowCount += 1;
    }
  }
  for (const update of deferredUpdates) {
    await tx.query(
      `UPDATE ${quoteIdentifier(update.table.name)} SET ${quoteIdentifier(update.column)} = ? WHERE ${quoteIdentifier(update.primaryKey)} = ?`,
      update.value,
      update.primaryValue,
    );
  }
  return rowCount;
}

export async function importApplication(context) {
  if (!context.path) {
    throw new Error(
      'Usage: pnpm app:import -- /absolute/path/export.json',
    );
  }
  const bundle = JSON.parse(readFileSync(context.path, 'utf8'));
  if (bundle.schemaVersion !== 1 || !Array.isArray(bundle.tables)) {
    throw new Error('Unsupported logical export bundle.');
  }
  if (bundle.application !== context.appId) {
    throw new Error('The export belongs to a different application.');
  }
  const expected = new Map(
    manifestTables(context.sourceRoot).map((table) => [table.name, table]),
  );
  validateImportBundle(bundle, expected);
  const exportedByName = new Map(
    bundle.tables.map((table) => [table.name, table]),
  );
  const plan = planImportTables([...expected.values()]);
  for (const table of plan) {
    const exported = exportedByName.get(table.name);
    for (const column of table.deferredColumns) {
      if (
        table.columnDefinitions[column]?.notNull &&
        exported.rows.some((row) => row[column] != null)
      ) {
        throw new Error(
          `Import cannot safely defer required cyclic reference ${table.name}.${column}.`,
        );
      }
    }
    if (table.deferredColumns.size > 0 && table.primaryKeys.length !== 1) {
      throw new Error(
        `Import cannot update cyclic references for ${table.name} without one primary key.`,
      );
    }
  }
  let rowCount = 0;
  await withDatabase(context, async (db) => {
    if (typeof db.transaction !== 'function') {
      throw new Error('Logical import requires transactional database support.');
    }
    await db.transaction(async (tx) => {
      rowCount = await executeImportPlan(tx, plan, exportedByName);
    });
  });
  return { path: context.path, rowCount };
}
