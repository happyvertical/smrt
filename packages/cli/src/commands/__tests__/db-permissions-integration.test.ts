import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  output: vi.fn(),
  resolveData: vi.fn(),
}));
vi.mock('../db-permissions.js', () => ({
  dbPermissionsCommand: { name: 'db:permissions' },
  runPostgresPermissions: mocks.run,
  outputPermissionsOutcome: mocks.output,
  formatPermissionsOutcome: () => [],
}));
vi.mock('../json-validator.js', () => ({
  resolveDataPath: mocks.resolveData,
  discoverJsonFiles: vi.fn(),
  JsonDatabaseValidator: vi.fn(),
  displayValidationResults: vi.fn(),
}));

import { utilityCommands } from '../utilities.js';

afterEach(() => {
  clearCache();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.exitCode = 0;
});
describe('database validation permissions routing', () => {
  it('registers the explicit permissions command', () => {
    expect(utilityCommands['db:permissions'].name).toBe('db:permissions');
  });
  it('runs configured PostgreSQL validation read-only and preserves JSON output', async () => {
    setConfig({
      packages: {
        cli: {
          database: { type: 'postgres', url: 'postgres://localhost/app' },
        },
      },
    });
    const outcome = { skipped: false, plan: null, error: 'Missing contract' };
    mocks.run.mockResolvedValue(outcome);
    await utilityCommands['db:validate'].handler([], { json: true, fix: true });
    expect(mocks.run).toHaveBeenCalledWith({}, true);
    expect(mocks.output).toHaveBeenCalledWith(outcome, true);
    expect(mocks.resolveData).not.toHaveBeenCalled();
  });
  it('preserves auto-detected JSON validation when PostgreSQL permissions are unconfigured', async () => {
    setConfig({
      packages: {
        cli: {
          database: { type: 'postgres', url: 'postgres://localhost/app' },
        },
      },
    });
    mocks.run.mockResolvedValue({ skipped: true, plan: null, error: null });
    mocks.resolveData.mockRejectedValue(
      new Error('JSON validation path reached'),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    await utilityCommands['db:validate']
      .handler([], { quick: true })
      .catch(() => undefined);
    expect(mocks.resolveData).toHaveBeenCalledWith(undefined);
    expect(mocks.run).toHaveBeenCalledWith({}, true);
    expect(mocks.output).not.toHaveBeenCalled();
  });
  it('retains the JSON validator when an explicit data directory is supplied', async () => {
    setConfig({
      packages: {
        cli: {
          database: { type: 'postgres', url: 'postgres://localhost/app' },
        },
      },
    });
    mocks.resolveData.mockRejectedValue(
      new Error('JSON validation path reached'),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    await expect(
      utilityCommands['db:validate'].handler([], { data: './data' }),
    ).rejects.toThrow('exit');
    expect(mocks.resolveData).toHaveBeenCalledWith('./data');
    expect(mocks.run).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});

it('doctor --db includes read-only permission findings as issues', async () => {
  const originalCwd = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), 'smrt-permissions-doctor-'));
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'permissions-fixture', private: true }),
  );
  mocks.run.mockResolvedValue({
    skipped: false,
    plan: null,
    error: 'Permission metadata unavailable',
  });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  try {
    process.chdir(directory);
    await utilityCommands.doctor
      .handler([], { db: true })
      .catch(() => undefined);
    expect(mocks.run).toHaveBeenCalledWith({}, true);
    expect(log.mock.calls.flat().join('\n')).toContain(
      'PostgreSQL role permissions',
    );
  } finally {
    process.chdir(originalCwd);
    await rm(directory, { recursive: true, force: true });
  }
});
