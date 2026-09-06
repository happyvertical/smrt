import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearCache,
  defineConfig,
  getPackageConfig,
  loadConfig,
  setConfig,
} from './index.js';
import type { PostgresPermissionsConfig } from './types.js';

afterEach(clearCache);
describe('PostgreSQL permissions configuration', () => {
  it('propagates the global declarative contract and supports package overrides', async () => {
    const contract: PostgresPermissionsConfig = {
      schema: 'app',
      schemaExclusive: true,
      migrationOwner: 'owner',
      runtimeRole: 'runtime',
      monitor: { role: 'monitor', tables: { orders: ['id'] } },
    };
    const directory = await mkdtemp(join(tmpdir(), 'smrt-permissions-config-'));
    const configPath = join(directory, 'smrt.config.json');
    try {
      await writeFile(
        configPath,
        JSON.stringify(
          defineConfig({ smrt: { postgresPermissions: contract } }),
        ),
      );
      await loadConfig({ configPath, cache: false });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    setConfig({
      packages: {
        cli: { postgresPermissions: { runtimeRole: 'cli_runtime' } },
      },
    });
    expect(getPackageConfig('cli', {}).postgresPermissions).toEqual({
      ...contract,
      runtimeRole: 'cli_runtime',
    });
  });
  it('does not silently enable permissions management by default', () => {
    expect(getPackageConfig('cli', {}).postgresPermissions).toBeUndefined();
  });
});
