import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCliCommandArgs } from '../../cli-generator.js';
import {
  dbPermissionsCommand,
  formatPermissionsOutcome,
  outputPermissionsOutcome,
  runPostgresPermissions,
} from '../db-permissions.js';

const mocks = vi.hoisted(() => ({
  plan: vi.fn(),
  apply: vi.fn(),
  getDatabase: vi.fn(),
  discover: vi.fn(),
  query: vi.fn(),
  close: vi.fn(),
}));
vi.mock('@happyvertical/sql', () => ({ getDatabase: mocks.getDatabase }));
vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: mocks.discover,
}));
vi.mock('@happyvertical/smrt-core', () => ({
  ObjectRegistry: { getAllSchemasAsDefinitions: () => ({ orders: {} }) },
  getSystemTableShapes: () =>
    new Map([
      ['_smrt_changes', {}],
      ['_smrt_dispatch', {}],
    ]),
  planPostgresPermissions: mocks.plan,
  applyPostgresPermissions: mocks.apply,
}));
const configured = {
  schema: 'app',
  schemaExclusive: true as const,
  migrationOwner: 'owner',
  runtimeRole: 'runtime',
  retainedTables: ['operator_audit'],
  monitor: { role: 'monitor', tables: { orders: ['id'] } },
};
const plan = {
  contract: { ...configured, managedTables: ['orders'] },
  diagnostics: [],
  statements: ['GRANT ...'],
  canApply: true,
  fingerprint: 'reviewed',
  limitations: ['ACL checks do not verify RLS.'],
};

beforeEach(() => {
  clearCache();
  vi.clearAllMocks();
  process.exitCode = 0;
  setConfig({
    packages: {
      cli: {
        postgresPermissions: configured,
        database: {
          type: 'postgres',
          url: 'postgres://secret:password@example/db',
        },
      },
    },
  });
  mocks.query.mockResolvedValue({ rows: [{ tablename: '_smrt_changes' }] });
  mocks.getDatabase.mockResolvedValue({
    query: mocks.query,
    close: mocks.close,
  });
  mocks.plan.mockResolvedValue(plan);
  mocks.apply.mockResolvedValue(plan);
});
afterEach(() => {
  clearCache();
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('PostgreSQL permissions CLI', () => {
  it('parses the reviewed hash with verbatim kebab-case keys', () => {
    const parsed = parseCliCommandArgs(
      ['db:permissions', '--apply', '--expected-fingerprint', 'reviewed'],
      [dbPermissionsCommand],
    );
    expect(parsed.options).toMatchObject({
      apply: true,
      'expected-fingerprint': 'reviewed',
    });
  });
  it('defaults to read-only and includes only present optional system tables', async () => {
    expect((await runPostgresPermissions()).error).toBeNull();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.plan.mock.calls[0][1].managedTables).toEqual([
      '_smrt_changes',
      'orders',
    ]);
    expect(mocks.plan.mock.calls[0][1].retainedTables).toEqual([
      'operator_audit',
    ]);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining('pg_catalog.pg_tables'),
      ['app'],
    );
    expect(mocks.close).toHaveBeenCalledOnce();
  });
  it.each([
    { apply: true },
    { apply: true, 'dry-run': true, 'expected-fingerprint': 'reviewed' },
  ])('refuses unsafe apply arguments before connecting: %j', async (options) => {
    expect((await runPostgresPermissions(options)).error).toContain(
      '--apply requires',
    );
    expect(mocks.getDatabase).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('passes an explicit reviewed fingerprint to core', async () => {
    await runPostgresPermissions({
      apply: true,
      'expected-fingerprint': 'reviewed',
    });
    expect(mocks.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining(configured),
      { expectedFingerprint: 'reviewed' },
    );
    expect(mocks.plan).not.toHaveBeenCalled();
  });
  it('redacts driver, stale plan, and cleanup failures', async () => {
    mocks.apply.mockRejectedValue(new Error('password and private row'));
    mocks.close.mockRejectedValueOnce(new Error('secret'));
    const outcome = await runPostgresPermissions({
      apply: true,
      'expected-fingerprint': 'stale',
    });
    expect(outcome.error).toContain('could not be verified');
    expect(JSON.stringify(outcome)).not.toMatch(/password|private row|secret/);
  });
  it('skips absent optional contracts, refuses explicit use and other dialects', async () => {
    clearCache();
    expect((await runPostgresPermissions({}, true)).skipped).toBe(true);
    expect((await runPostgresPermissions()).error).toContain('Configure');
    setConfig({ packages: { cli: { postgresPermissions: configured } } });
    expect((await runPostgresPermissions()).error).toContain(
      'PostgreSQL database',
    );
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });
  it('reports drift as a failing JSON diagnostic without credentials', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    outputPermissionsOutcome(
      {
        skipped: false,
        error: null,
        plan: {
          ...plan,
          diagnostics: [
            {
              code: 'runtime_missing',
              severity: 'missing',
              resource: 'orders',
              message: 'Missing SELECT',
            },
          ],
        },
      },
      true,
    );
    expect(JSON.parse(log.mock.calls[0][0]).plan.diagnostics).toHaveLength(1);
    expect(process.exitCode).toBe(1);
  });
});

it('identifies the affected role and resource in operator output', () => {
  expect(
    formatPermissionsOutcome({
      skipped: false,
      error: null,
      plan: {
        ...plan,
        diagnostics: [
          {
            code: 'missing',
            severity: 'missing',
            role: 'runtime',
            resource: 'orders',
            message: 'SELECT is required',
          },
        ],
      },
    }).join('\n'),
  ).toContain('runtime · orders: SELECT is required');
});

it('reports scope limitations alongside a clean plan', () => {
  expect(
    formatPermissionsOutcome({ skipped: false, error: null, plan }).join('\n'),
  ).toContain('Scope: ACL checks do not verify RLS.');
});
