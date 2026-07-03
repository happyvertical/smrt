/**
 * Regression test for issue #1783: `smrt db:setup` / `db:migrate` cannot load a
 * TypeScript `smrt.config.ts`.
 *
 * The SvelteKit template scaffolds its config as `smrt.config.ts` (TS by
 * default). The CLI loads config at startup via `loadConfig()` and every db
 * command resolves its database through
 * `getPackageConfig('cli', DEFAULT_CLI_CONFIG)`. Before the fix the cosmiconfig
 * loader had no TypeScript support, so the TS config was never discovered and db
 * commands fell back to the `:memory:` default ("Database not configured").
 *
 * This test exercises the real (unmocked) config-resolution seam the db
 * commands use — searching a fixture project whose only config is
 * `smrt.config.ts` — and asserts the database config from the TS file survives
 * all the way to `getPackageConfig('cli', DEFAULT_CLI_CONFIG)`.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearCache,
  getPackageConfig,
  loadConfig,
} from '@happyvertical/smrt-config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CLI_CONFIG } from '../../config.js';

describe('#1783: CLI loads a TypeScript smrt.config.ts', () => {
  let fixtureDir: string;

  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'smrt-1783-cli-'));
    clearCache();
  });

  afterEach(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
    clearCache();
  });

  it('resolves the db config from smrt.config.ts for db commands', async () => {
    // A template-shaped TS config: TS-only syntax plus a runtime `process.env`
    // read, exactly what a plain-JSON loader could not handle.
    const dbPath = join(fixtureDir, 'data', 'app.db');
    writeFileSync(
      join(fixtureDir, 'smrt.config.ts'),
      `
      type DbType = 'sqlite' | 'postgres';
      const type: DbType = 'sqlite';
      export default {
        smrt: { logLevel: 'info' as const },
        packages: {
          cli: {
            database: {
              type,
              url: process.env.SMRT_1783_DB_URL ?? ${JSON.stringify(dbPath)},
            },
          },
        },
      };
      `,
      'utf-8',
    );

    // Mirror the CLI startup path: search the project dir (no explicit path).
    await loadConfig({ searchFrom: fixtureDir, cache: true });

    // Mirror what every db command does to resolve its database.
    const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

    expect(config.database?.type).toBe('sqlite');
    expect(config.database?.url).toBe(dbPath);
    // The db-command guard rejects a missing/`:memory:` url — prove we cleared it.
    expect(config.database?.url).not.toBe(':memory:');
  });

  it('honors a process.env override in the TS config', async () => {
    process.env.SMRT_1783_DB_URL = 'sqlite:///tmp/override-1783.db';
    writeFileSync(
      join(fixtureDir, 'smrt.config.ts'),
      `
      export default {
        packages: {
          cli: {
            database: {
              type: 'sqlite' as const,
              url: process.env.SMRT_1783_DB_URL ?? ':memory:',
            },
          },
        },
      };
      `,
      'utf-8',
    );

    try {
      await loadConfig({ searchFrom: fixtureDir, cache: true });
      const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
      expect(config.database?.url).toBe('sqlite:///tmp/override-1783.db');
    } finally {
      process.env.SMRT_1783_DB_URL = undefined;
    }
  });
});
