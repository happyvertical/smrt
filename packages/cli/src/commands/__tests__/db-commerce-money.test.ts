import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';
import {
  dbMigrateCommerceMoneyCommand,
  dbPreflightCommerceMoneyCommand,
  dbRollbackCommerceMoneyCommand,
} from '../db-commerce-money.js';
import { utilityCommands } from '../utilities.js';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  getDatabase: vi.fn(),
  migrate: vi.fn(),
  preflight: vi.fn(),
  rollback: vi.fn(),
  discover: vi.fn(),
}));

vi.mock('@happyvertical/sql', () => ({ getDatabase: mocks.getDatabase }));
vi.mock('@happyvertical/smrt-commerce', () => ({
  migrateCommerceLineAmounts: mocks.migrate,
  preflightCommerceLineAmounts: mocks.preflight,
  rollbackCommerceLineAmounts: mocks.rollback,
}));
vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: mocks.discover,
}));

const REPORT = {
  version: 1 as const,
  documents: [
    {
      tenantId: 'tenant-a',
      documentType: 'invoice' as const,
      documentId: 'invoice-a',
      status: 'DRAFT',
      arJournalIdSet: false,
      old: { subtotalMinor: 100, taxMinor: 5, totalMinor: 105 },
      next: { subtotalMinor: 100, taxMinor: 6, totalMinor: 106 },
      delta: { subtotalMinor: 0, taxMinor: 1, totalMinor: 1 },
      reasons: ['DRAFT_RECOMPUTED' as const],
    },
  ],
  tenants: [
    {
      tenantId: 'tenant-a',
      documentCount: 1,
      changingDraftCount: 1,
      issuedUnpostedFallbackTaxCount: 0,
      reasonCounts: { DRAFT_RECOMPUTED: 1 },
    },
  ],
};

describe('Commerce money migration CLI commands (#3933)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.exitCode = undefined;
    clearCache();
    setConfig({
      packages: {
        cli: {
          database: { type: 'sqlite', url: '/tmp/commerce-money.db' },
        },
      },
    } as never);
    mocks.close.mockReset();
    mocks.getDatabase.mockReset().mockResolvedValue({ close: mocks.close });
    mocks.discover.mockReset().mockResolvedValue(undefined);
    mocks.preflight.mockReset().mockResolvedValue(REPORT);
    mocks.migrate.mockReset().mockResolvedValue({
      tenantId: 'tenant-a',
      migrationId: '00000000-0000-4000-8000-000000003933',
      migrated: 1,
      resumed: 0,
      activated: true,
      report: REPORT,
    });
    mocks.rollback.mockReset().mockResolvedValue({
      tenantId: 'tenant-a',
      migrationId: '00000000-0000-4000-8000-000000003933',
      restored: 1,
      alreadyRestored: 0,
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearCache();
    process.exitCode = undefined;
  });

  it('registers the three explicit commands', () => {
    expect(utilityCommands['db:preflight-commerce-money']).toBe(
      dbPreflightCommerceMoneyCommand,
    );
    expect(utilityCommands['db:migrate-commerce-money']).toBe(
      dbMigrateCommerceMoneyCommand,
    );
    expect(utilityCommands['db:rollback-commerce-money']).toBe(
      dbRollbackCommerceMoneyCommand,
    );
  });

  it('preflights without writes and requires both artifact paths', async () => {
    await requireCommandHandler(dbPreflightCommerceMoneyCommand)([], {
      'tenant-id': ' tenant-a ',
      'json-path': '/reports/money.json',
      'csv-path': '/reports/money.csv',
    });
    expect(mocks.preflight).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      out: {
        jsonPath: '/reports/money.json',
        csvPath: '/reports/money.csv',
      },
    });
    expect(logSpy.mock.calls.flat().join('\n')).toContain(
      'No database changes',
    );
    expect(mocks.close).toHaveBeenCalledOnce();

    await requireCommandHandler(dbPreflightCommerceMoneyCommand)([], {
      'json-path': '/reports/incomplete.json',
    });
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join('\n')).toContain(
      '--json-path and --csv-path must be supplied together',
    );
    expect(mocks.preflight).toHaveBeenCalledOnce();
  });

  it('prints and passes a recoverable owner before migration starts', async () => {
    mocks.migrate.mockRejectedValueOnce(
      Object.assign(new Error('interrupted after claim'), {
        code: 'FROZEN_DOCUMENT',
      }),
    );
    await requireCommandHandler(dbMigrateCommerceMoneyCommand)([], {
      'tenant-id': 'tenant-a',
      'accept-draft-changes': true,
    });
    const owner = mocks.migrate.mock.calls[0]?.[1]?.migrationId;
    expect(owner).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(mocks.migrate).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      migrationId: owner,
      acceptDraftChanges: true,
    });
    expect(logSpy.mock.calls.flat().join('\n')).toContain(
      `Migration owner: ${owner}`,
    );
    expect(errorSpy.mock.calls.flat().join('\n')).toContain(
      '[FROZEN_DOCUMENT] interrupted after claim',
    );
    expect(process.exitCode).toBe(1);
  });

  it('requires both rollback identities and passes them unchanged', async () => {
    const owner = '00000000-0000-4000-8000-000000003933';
    await requireCommandHandler(dbRollbackCommerceMoneyCommand)([], {
      'tenant-id': 'tenant-a',
      'migration-id': owner,
    });
    expect(mocks.rollback).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
      migrationId: owner,
    });

    await requireCommandHandler(dbRollbackCommerceMoneyCommand)([], {
      'tenant-id': 'tenant-a',
    });
    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls.flat().join('\n')).toContain(
      '--migration-id is required',
    );
    expect(mocks.rollback).toHaveBeenCalledOnce();
  });
});
