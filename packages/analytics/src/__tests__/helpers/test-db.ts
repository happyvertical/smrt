/**
 * Test database utilities for multi-adapter testing
 * @packageDocumentation
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';

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
  const db = await getDatabase(config);

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
