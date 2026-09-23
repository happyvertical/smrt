/**
 * Test database utilities for multi-adapter testing
 * @packageDocumentation
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { AnalyticsPropertyCollection } from '../../collections/AnalyticsPropertyCollection.js';

export type TestAdapter = 'sqlite' | 'postgres' | 'json';

export interface TestDbConfig {
  type: 'sqlite' | 'postgres' | 'json';
  url: string;
  writeStrategy?: 'immediate';
}

/**
 * Get the current test adapter from environment
 */
export function getTestAdapter(): TestAdapter {
  return (process.env.TEST_DB_ADAPTER as TestAdapter) || 'sqlite';
}

/**
 * Get database configuration for the current test adapter
 */
export function getTestDbConfig(): TestDbConfig {
  const adapter = getTestAdapter();
  const testId = randomUUID().slice(0, 8);

  switch (adapter) {
    case 'sqlite':
      return {
        type: 'sqlite',
        url: join(tmpdir(), `test-analytics-sqlite-${testId}.db`),
      };

    case 'postgres':
      return {
        type: 'postgres',
        url:
          process.env.TEST_DB_URL ||
          process.env.DATABASE_URL ||
          `postgresql://postgres:postgres@${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || '5432'}/test_db`,
      };

    case 'json':
      return {
        type: 'json',
        url: join(tmpdir(), `test-analytics-json-${testId}`),
        writeStrategy: 'immediate',
      };

    default:
      throw new Error(`Unknown test adapter: ${adapter}`);
  }
}

/**
 * Create a database instance for the current test adapter
 */
export async function createTestDb(): Promise<{
  db: DatabaseInterface;
  config: TestDbConfig;
  cleanup: () => Promise<void>;
}> {
  const config = getTestDbConfig();
  // SQLite and JSON get a fresh file per call; PostgreSQL gets a fresh
  // schema, reached through the pool's `search_path`, so no test inherits
  // rows from an earlier one in the package's shared database.
  let admin: DatabaseInterface | undefined;
  let schema: string | undefined;
  if (config.type === 'postgres') {
    schema = `analytics_${randomUUID().replaceAll('-', '')}`;
    admin = await getDatabase({
      type: 'postgres',
      url: config.url,
      dbid: `analytics-admin-${schema}`,
      __smrtSkipVitestSchemaPreparation: true,
    } as Parameters<typeof getDatabase>[0]);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(config.url);
    url.searchParams.set('options', `-c search_path=${schema}`);
    config.url = url.toString();
  }
  // The schema starts empty; getTestDatabase() below provisions exactly the
  // tables this package needs, so skip smrt-vitest's whole-registry pass.
  const db = schema
    ? await getDatabase({
        ...config,
        dbid: `analytics-${schema}`,
        __smrtSkipVitestSchemaPreparation: true,
      } as Parameters<typeof getDatabase>[0])
    : await getDatabase(config);

  await getTestDatabase({
    db,
    type: config.type,
    classes: [
      '@happyvertical/smrt-analytics:AnalyticsProperty',
      '@happyvertical/smrt-analytics:AnalyticsDataStream',
      '@happyvertical/smrt-analytics:AnalyticsEvent',
      '@happyvertical/smrt-analytics:AnalyticsReport',
    ],
    // DuckDB cannot enforce the package's generated ON UPDATE CASCADE action.
    // These adapter/query tests still prepare every table and seed real parents;
    // physical FK enforcement remains covered by SQLite/PostgreSQL lanes.
    omitForeignKeyConstraints: config.type === 'json',
  });

  const cleanup = async () => {
    if (db && typeof (db as any).close === 'function') {
      try {
        await (db as any).close();
      } catch {
        // Ignore close errors
      }
    }

    // Small delay to allow DuckDB to release file locks
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Clean up file-based databases
    if (
      config.type === 'sqlite' &&
      config.url !== ':memory:' &&
      existsSync(config.url)
    ) {
      try {
        rmSync(config.url, { force: true });
      } catch {
        // Ignore cleanup errors
      }
    }

    if (admin && schema) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.close?.();
    }

    if (config.type === 'json' && config.url && existsSync(config.url)) {
      try {
        rmSync(config.url, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  };

  return { db, config, cleanup };
}

/**
 * Deterministic UUID for a readable fixture label. Property ids are native
 * UUID columns on PostgreSQL, so a literal such as `'prop-123'` is rejected
 * there (22P02) while SQLite's text ids accept it; routing every fixture id
 * through this keeps the same readable label valid on all three adapters.
 */
export function fixtureId(label: string): string {
  const hex = createHash('sha256')
    .update(`smrt-analytics:${label}`)
    .digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/** Seed explicit real parents for collection fixtures that exercise child rows. */
export async function seedAnalyticsProperties(
  db: DatabaseInterface,
  ids: readonly string[],
): Promise<void> {
  const properties = await AnalyticsPropertyCollection.create({ db });
  for (const id of ids) {
    await properties.create({
      id,
      name: id,
      displayName: id,
      externalId: `fixture:${id}`,
    });
  }
}

// Cache the postgres availability check result
let postgresAvailableCache: boolean | null = null;

/**
 * Check if PostgreSQL is available (cached)
 */
export async function isPostgresAvailable(): Promise<boolean> {
  if (postgresAvailableCache !== null) {
    return postgresAvailableCache;
  }

  // If not running postgres adapter, return false
  if (getTestAdapter() !== 'postgres') {
    postgresAvailableCache = false;
    return false;
  }

  try {
    const config = getTestDbConfig();
    const db = await getDatabase(config);
    await db.query('SELECT 1');
    await (db as any).close();
    postgresAvailableCache = true;
    return true;
  } catch {
    postgresAvailableCache = false;
    return false;
  }
}

/**
 * Get display name for current adapter (for test descriptions)
 */
export function getAdapterDisplayName(): string {
  const adapter = getTestAdapter();
  switch (adapter) {
    case 'sqlite':
      return 'SQLite';
    case 'postgres':
      return 'PostgreSQL';
    case 'json':
      return 'JSON (DuckDB)';
    default:
      return adapter;
  }
}

/**
 * Check if current test run is for a specific adapter
 */
export function isAdapter(adapter: TestAdapter): boolean {
  return getTestAdapter() === adapter;
}
