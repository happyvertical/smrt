#!/usr/bin/env node

/**
 * Migration script for Issue #198: DuckDB DATETIME Compatibility
 *
 * This script migrates existing databases from DATETIME to TIMESTAMP type
 * and from datetime('now') to current_timestamp default values.
 *
 * Usage:
 *   npx tsx scripts/migrate-datetime-to-timestamp.ts <database-path>
 *
 * Example:
 *   npx tsx scripts/migrate-datetime-to-timestamp.ts ./data/my-database.db
 *
 * What it does:
 * 1. Backs up the database file
 * 2. For each table with DATETIME columns:
 *    - Creates a new table with TIMESTAMP columns
 *    - Copies all data from old table to new table
 *    - Drops old table and renames new table
 * 3. Recreates indexes and triggers with correct syntax
 *
 * Note: This migration is safe and reversible via the backup file.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Database } from '@happyvertical/sql';

interface MigrationOptions {
  databasePath: string;
  dryRun?: boolean;
  backup?: boolean;
}

/**
 * Main migration function
 */
async function migrate(options: MigrationOptions) {
  const { databasePath, dryRun = false, backup = true } = options;

  // Validate database exists
  if (!existsSync(databasePath)) {
    throw new Error(`Database not found: ${databasePath}`);
  }

  console.log(`🔍 Analyzing database: ${databasePath}`);

  // Create backup if requested
  if (backup && !dryRun) {
    const backupPath = `${databasePath}.backup-${Date.now()}`;
    console.log(`📦 Creating backup: ${backupPath}`);
    const dbContent = await readFile(databasePath);
    await writeFile(backupPath, dbContent);
    console.log(`✅ Backup created successfully`);
  }

  // Connect to database
  const db = await Database.connect({
    type: 'sqlite',
    url: databasePath,
  });

  try {
    // Get all tables
    const tables = await db.all(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_smrt_%'
    `);

    console.log(`📊 Found ${tables.length} user tables to check`);

    // Process each table
    for (const table of tables) {
      const tableName = table.name;
      console.log(`\n🔧 Processing table: ${tableName}`);

      // Get table schema
      const columns = await db.all(`PRAGMA table_info("${tableName}")`);

      // Find DATETIME columns
      const datetimeColumns = columns.filter((col: any) =>
        col.type.toUpperCase().includes('DATETIME'),
      );

      if (datetimeColumns.length === 0) {
        console.log(`  ✓ No DATETIME columns found, skipping`);
        continue;
      }

      console.log(
        `  📋 Found ${datetimeColumns.length} DATETIME column(s): ${datetimeColumns.map((c: any) => c.name).join(', ')}`,
      );

      if (dryRun) {
        console.log(`  🔍 [DRY RUN] Would migrate these columns to TIMESTAMP`);
        continue;
      }

      // Create new table with TIMESTAMP columns
      const newTableName = `${tableName}_new`;

      // Build CREATE TABLE statement for new table
      const createTableSQL = buildCreateTableSQL(
        tableName,
        newTableName,
        columns,
      );
      console.log(`  🏗️  Creating new table: ${newTableName}`);
      await db.run(createTableSQL);

      // Copy data from old table to new table
      console.log(`  📤 Copying data to new table...`);
      const columnNames = columns.map((c: any) => `"${c.name}"`).join(', ');
      await db.run(`
        INSERT INTO "${newTableName}" (${columnNames})
        SELECT ${columnNames} FROM "${tableName}"
      `);

      // Get row counts to verify
      const oldCount = await db.get(
        `SELECT COUNT(*) as count FROM "${tableName}"`,
      );
      const newCount = await db.get(
        `SELECT COUNT(*) as count FROM "${newTableName}"`,
      );

      if (oldCount.count !== newCount.count) {
        throw new Error(
          `Data copy verification failed: ${oldCount.count} rows in old table, ${newCount.count} rows in new table`,
        );
      }

      console.log(`  ✅ Copied ${oldCount.count} rows successfully`);

      // Drop old table
      console.log(`  🗑️  Dropping old table: ${tableName}`);
      await db.run(`DROP TABLE "${tableName}"`);

      // Rename new table to old table name
      console.log(`  📝 Renaming ${newTableName} to ${tableName}`);
      await db.run(`ALTER TABLE "${newTableName}" RENAME TO "${tableName}"`);

      // Recreate indexes
      const indexes = await db.all(`
        SELECT sql FROM sqlite_master
        WHERE type='index' AND tbl_name='${tableName}' AND sql IS NOT NULL
      `);

      if (indexes.length > 0) {
        console.log(`  🔗 Recreating ${indexes.length} index(es)...`);
        for (const index of indexes) {
          // Update index SQL to use new table name and current_timestamp
          let indexSQL = index.sql;
          indexSQL = indexSQL.replace(
            /datetime\('now'\)/gi,
            'current_timestamp',
          );
          indexSQL = indexSQL.replace(/DATETIME/gi, 'TIMESTAMP');
          await db.run(indexSQL);
        }
      }

      // Recreate triggers
      const triggers = await db.all(`
        SELECT sql FROM sqlite_master
        WHERE type='trigger' AND tbl_name='${tableName}' AND sql IS NOT NULL
      `);

      if (triggers.length > 0) {
        console.log(`  ⚡ Recreating ${triggers.length} trigger(s)...`);
        for (const trigger of triggers) {
          // Update trigger SQL to use current_timestamp
          let triggerSQL = trigger.sql;
          triggerSQL = triggerSQL.replace(
            /datetime\('now'\)/gi,
            'current_timestamp',
          );
          triggerSQL = triggerSQL.replace(/DATETIME/gi, 'TIMESTAMP');
          await db.run(triggerSQL);
        }
      }

      console.log(`  ✅ Migration complete for table: ${tableName}`);
    }

    console.log(`\n✨ Migration completed successfully!`);
  } finally {
    await db.close();
  }
}

/**
 * Build CREATE TABLE SQL for new table with TIMESTAMP columns
 */
function buildCreateTableSQL(
  _oldTableName: string,
  newTableName: string,
  columns: any[],
): string {
  let sql = `CREATE TABLE "${newTableName}" (\n`;

  const columnDefs = columns.map((col: any) => {
    const parts: string[] = [];

    // Column name and type
    let type = col.type.toUpperCase();
    // Replace DATETIME with TIMESTAMP
    if (type.includes('DATETIME')) {
      type = type.replace('DATETIME', 'TIMESTAMP');
    }
    parts.push(`  "${col.name}" ${type}`);

    // Primary key
    if (col.pk) {
      parts.push('PRIMARY KEY');
    }

    // Not null
    if (col.notnull) {
      parts.push('NOT NULL');
    }

    // Default value
    if (col.dflt_value !== null) {
      let defaultValue = col.dflt_value;
      // Replace datetime('now') with current_timestamp
      if (typeof defaultValue === 'string') {
        defaultValue = defaultValue.replace(
          /datetime\('now'\)/gi,
          'current_timestamp',
        );
        defaultValue = defaultValue.replace(
          /CURRENT_TIMESTAMP/gi,
          'current_timestamp',
        );
      }
      parts.push(`DEFAULT ${defaultValue}`);
    }

    return parts.join(' ');
  });

  sql += columnDefs.join(',\n');
  sql += '\n);';

  return sql;
}

/**
 * Parse command line arguments and run migration
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Migration Script for Issue #198: DuckDB DATETIME Compatibility

Usage:
  npx tsx scripts/migrate-datetime-to-timestamp.ts [options] <database-path>

Options:
  --dry-run         Show what would be migrated without making changes
  --no-backup       Skip creating a backup file (not recommended)
  -h, --help        Show this help message

Examples:
  # Migrate database with backup
  npx tsx scripts/migrate-datetime-to-timestamp.ts ./data/my-database.db

  # Preview migration without making changes
  npx tsx scripts/migrate-datetime-to-timestamp.ts --dry-run ./data/my-database.db

  # Migrate without backup (dangerous!)
  npx tsx scripts/migrate-datetime-to-timestamp.ts --no-backup ./data/my-database.db
    `);
    process.exit(0);
  }

  // Parse options
  const dryRun = args.includes('--dry-run');
  const noBackup = args.includes('--no-backup');
  const databasePath = resolve(args.find((arg) => !arg.startsWith('--')) || '');

  if (!databasePath) {
    console.error('❌ Error: Database path is required');
    process.exit(1);
  }

  try {
    await migrate({
      databasePath,
      dryRun,
      backup: !noBackup,
    });
    process.exit(0);
  } catch (error) {
    console.error(`\n❌ Migration failed:`, error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { migrate, type MigrationOptions };
