import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';
import {
  checkCommerceMoneyPreconditions,
  dbUpgradeCommerceMoneyCommand,
} from '../db-upgrade-commerce-money.js';
import { utilityCommands } from '../utilities.js';

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  getDatabase: vi.fn(),
  needs: vi.fn(),
  upgrade: vi.fn(),
  discover: vi.fn(),
  missing: false,
}));

vi.mock('@happyvertical/sql', () => ({ getDatabase: mocks.getDatabase }));
vi.mock('../../loaders/consumer-package.js', () => ({
  importConsumerPackage: vi.fn().mockImplementation(async () => {
    if (mocks.missing) throw new Error('Cannot find package');
    return {
      findCommerceMoneyUpgradeNeeds: mocks.needs,
      upgradeCommerceMoney: mocks.upgrade,
    };
  }),
}));
vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: mocks.discover,
}));

const UPGRADED = {
  tenantId: 'tenant-a',
  issuedBackfilled: 1,
  draftsRecomputed: 1,
  changedDrafts: [
    {
      documentType: 'invoice',
      documentId: 'draft-a',
      old: { subtotalMinor: 100, taxMinor: 0, totalMinor: 105 },
      next: { subtotalMinor: 100, taxMinor: 5, totalMinor: 105 },
    },
  ],
  componentsWithoutLiabilityAccount: ['component-5'],
};

describe('smrt db:upgrade-commerce-money (#4021)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.exitCode = undefined;
    clearCache();
    setConfig({
      packages: {
        cli: { database: { type: 'sqlite', url: '/tmp/commerce-money.db' } },
      },
    } as never);
    mocks.missing = false;
    mocks.close.mockReset();
    mocks.getDatabase.mockReset().mockResolvedValue({ close: mocks.close });
    mocks.discover.mockReset().mockResolvedValue(undefined);
    mocks.needs.mockReset().mockResolvedValue({ oldSchema: [], tenants: [] });
    mocks.upgrade.mockReset().mockResolvedValue({
      upgraded: [UPGRADED],
      failures: [],
      droppedSchema: ['tax_settings.money_model'],
      remaining: [],
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearCache();
    process.exitCode = undefined;
  });

  it('registers one upgrade command and no migration commands', () => {
    expect(utilityCommands['db:upgrade-commerce-money']).toBe(
      dbUpgradeCommerceMoneyCommand,
    );
    for (const removed of [
      'db:preflight-commerce-money',
      'db:migrate-commerce-money',
      'db:rollback-commerce-money',
    ])
      expect(utilityCommands).not.toHaveProperty(removed);
  });

  it('upgrades, reports changed drafts and dropped columns, and exits 0', async () => {
    await requireCommandHandler(dbUpgradeCommerceMoneyCommand)([], {
      'tenant-id': ' tenant-a ',
    });
    expect(mocks.upgrade).toHaveBeenCalledWith(expect.anything(), {
      tenantId: 'tenant-a',
    });
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('tenant-a: 1 issued document(s) backfilled');
    expect(output).toContain('invoice draft-a: total 105 -> 105');
    expect(output).toContain('component-5');
    expect(output).toContain('tax_settings.money_model');
    expect(process.exitCode).toBeUndefined();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('lists unreconcilable documents and exits 1 while tenants remain', async () => {
    mocks.upgrade.mockResolvedValueOnce({
      upgraded: [],
      failures: [
        {
          tenantId: 'tenant-b',
          documentType: 'invoice',
          documentId: 'INV-9',
          reason: 'does not reconcile: line tax 4 differs from stored tax 5',
        },
      ],
      droppedSchema: [],
      remaining: [{ tenantId: 'tenant-b', reason: 'legacy-marker' }],
    });
    await requireCommandHandler(dbUpgradeCommerceMoneyCommand)([], {});
    expect(mocks.upgrade).toHaveBeenCalledWith(expect.anything(), {
      tenantId: undefined,
    });
    const errors = errorSpy.mock.calls.flat().join('\n');
    expect(errors).toContain('tenant-b invoice INV-9: does not reconcile');
    expect(errors).toContain(
      '1 tenant(s) and 0 row(s) without a tenant still need attention',
    );
    expect(process.exitCode).toBe(1);
  });

  it('checks without writing and exits 1 when an upgrade is needed', async () => {
    mocks.needs.mockResolvedValueOnce({
      oldSchema: ['tax_settings.money_model'],
      tenants: [{ tenantId: 'tenant-a', reason: 'legacy-marker' }],
    });
    await requireCommandHandler(dbUpgradeCommerceMoneyCommand)([], {
      check: true,
    });
    expect(mocks.upgrade).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.flat().join('\n')).toContain(
      'No database changes made',
    );
    expect(process.exitCode).toBe(1);
  });

  it('reports a db:status error precondition naming the upgrade command', async () => {
    const db = { tableExists: vi.fn().mockResolvedValue(true) } as never;
    expect(await checkCommerceMoneyPreconditions(db)).toEqual([]);
    mocks.needs.mockResolvedValueOnce({
      oldSchema: [],
      tenants: [{ tenantId: 'tenant-a', reason: 'missing-settings' }],
    });
    const [precondition] = await checkCommerceMoneyPreconditions(db);
    expect(precondition).toMatchObject({
      name: 'commerce-money-upgrade',
      status: 'error',
    });
    expect(precondition?.message).toContain('COMMERCE_DATA_NEEDS_UPGRADE');
    expect(precondition?.recommendation).toContain(
      'smrt db:upgrade-commerce-money',
    );
    mocks.needs.mockResolvedValueOnce({
      oldSchema: [],
      tenants: [],
      tenantlessDocuments: [{ table: 'invoices', id: 'global-1' }],
    });
    const [tenantless] = await checkCommerceMoneyPreconditions(db);
    expect(tenantless?.message).toContain(
      '1 document row(s) without a tenant to assign or delete',
    );
    mocks.missing = true;
    expect(await checkCommerceMoneyPreconditions(db)).toEqual([]);
  });
});
