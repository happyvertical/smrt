import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { expect, it } from 'vitest';
import { proveNullBillingScheduleSave } from './helpers/contract-null-schedule-suite.js';
import { proveContractSchedule } from './helpers/contract-schedule-suite.js';

it.skipIf(!isPostgresAvailable())(
  'serializes milestone claims and preserves parent rollback on PostgreSQL',
  async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Contract',
        'ContractLineItem',
        'Customer',
        'Invoice',
        'InvoiceLineItem',
        'DocumentTax',
        'TaxCode',
        'TaxComponent',
        'TaxSettings',
        'PaymentAllocation',
      ],
    });
    enableTenancy();
    try {
      await proveContractSchedule(isolated.baseDb, true);
    } finally {
      disableTenancy();
      await isolated.cleanup();
    }
  },
);

it.skipIf(!isPostgresAvailable())(
  'saves a NULL billing schedule contract and refuses a schedule change on PostgreSQL (#4155)',
  async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Contract',
        'ContractLineItem',
        'Customer',
        'DocumentTax',
        'TaxCode',
        'TaxComponent',
        'TaxSettings',
      ],
    });
    enableTenancy();
    try {
      const column = await isolated.baseDb.query(
        "SELECT column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'contracts' AND column_name = 'billing_schedule_json'",
      );
      expect(
        String((column.rows[0] as { column_default: unknown }).column_default),
      ).toMatch(/^''(::text)?$/);
      await proveNullBillingScheduleSave(isolated.baseDb);
    } finally {
      disableTenancy();
      await isolated.cleanup();
    }
  },
);
