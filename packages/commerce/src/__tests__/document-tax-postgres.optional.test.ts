import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocumentTaxCollection } from '../collections/DocumentTaxCollection.js';
import { DOCUMENT_MONEY_WRITE } from '../document-money-internal.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('DocumentTax PostgreSQL persistence (#3933)', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;
  let taxes: DocumentTaxCollection;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: ['DocumentTax'],
    });
    db = isolated.baseDb;
    enableTenancy();
    taxes = await DocumentTaxCollection.create({ db });
  });

  afterEach(async () => {
    disableTenancy();
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('round-trips one null/null identity and enforces it as unique', async () => {
    const tenantId = randomUUID();
    const documentId = randomUUID();
    const row = {
      tenantId,
      documentType: 'invoice' as const,
      documentId,
      currency: 'CAD',
      taxCodeId: null,
      taxCodeCode: null,
      kind: null,
      taxComponentId: null,
      taxComponentName: null,
      percent: null,
      liabilityAccountId: null,
      taxableMinor: 700,
      taxMinor: 0,
      recoverableMinor: 0,
    };
    await withTenant({ tenantId }, () =>
      taxes.replaceDerivedForDocument(DOCUMENT_MONEY_WRITE, {
        tenantId,
        documentType: 'invoice',
        documentId,
        rows: [row],
      }),
    );
    await withTenant({ tenantId }, () =>
      taxes.replaceDerivedForDocument(DOCUMENT_MONEY_WRITE, {
        tenantId,
        documentType: 'invoice',
        documentId,
        rows: [row],
      }),
    );
    const result = await db.query(
      `SELECT tax_code_id, tax_component_id, COUNT(*) AS count
         FROM document_taxes
        WHERE tenant_id = ? AND document_id = ?
        GROUP BY tax_code_id, tax_component_id`,
      [tenantId, documentId],
    );
    expect(result.rows).toEqual([
      { tax_code_id: null, tax_component_id: null, count: '1' },
    ]);
  });
});
