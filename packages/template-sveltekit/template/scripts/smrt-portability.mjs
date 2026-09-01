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
    const columns = Object.keys(schema.columns || {});
    if (columns.length === 0) continue;
    tables.set(schema.tableName, { name: schema.tableName, columns });
  }
  return [...tables.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
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

export async function exportApplication(context) {
  const tables = manifestTables(context.sourceRoot);
  const bundle = {
    schemaVersion: 1,
    application: context.appId,
    profile: context.runtime.profile,
    exportedAt: new Date().toISOString(),
    tables: [],
  };
  await withDatabase(context, async (db) => {
    for (const table of tables) {
      const result = await db.query(
        `SELECT ${table.columns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table.name)}`,
      );
      bundle.tables.push({ ...table, rows: result.rows });
    }
  });
  const outputPath =
    context.path ||
    join(
      context.stateRoot,
      'exports',
      `${context.appId}-${Date.now()}.json`,
    );
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  return { path: outputPath, tableCount: bundle.tables.length };
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
  let rowCount = 0;
  await withDatabase(context, async (db) => {
    if (typeof db.transaction !== 'function') {
      throw new Error('Logical import requires transactional database support.');
    }
    await db.transaction(async (tx) => {
      for (const exported of bundle.tables) {
        const table = expected.get(exported.name);
        if (!table || !Array.isArray(exported.rows)) {
          throw new Error(
            'The export does not match the generated application schema.',
          );
        }
        const count = await tx.query(
          `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)}`,
        );
        if (Number(count.rows[0]?.count || 0) !== 0) {
          throw new Error(`Import target table ${table.name} is not empty.`);
        }
        for (const row of exported.rows) {
          const columns = Object.keys(row);
          if (columns.some((column) => !table.columns.includes(column))) {
            throw new Error(`The export has unknown columns for ${table.name}.`);
          }
          await tx.query(
            `INSERT INTO ${quoteIdentifier(table.name)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
            ...columns.map((column) => row[column]),
          );
          rowCount += 1;
        }
      }
    });
  });
  return { path: context.path, rowCount };
}
