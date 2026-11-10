import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import type { TaxCode } from '../models/TaxCode.js';
import { createOrLoadTaxSeed, deterministicTaxId } from './identity.js';

/** The non-taxable codes every tenant needs, by stable code. */
export const STANDARD_TAX_CODES = [
  ['exempt', 'Exempt', 'exempt'],
  ['zero-rated', 'Zero rated', 'zero-rated'],
  ['out-of-scope', 'Out of scope', 'out-of-scope'],
] as const;

/**
 * Ensure the three non-taxable codes every tenant needs. Repeating the call is
 * safe; callers must use a transaction-capable database so the check/create
 * sequence is atomic with their surrounding work. An existing standard code
 * whose kind or components were changed is refused, never adopted.
 */
export async function ensureTenantTaxCodes(
  db: DatabaseInterface,
  tenantId: string,
): Promise<TaxCode[]> {
  return withTenant({ tenantId }, async () => {
    const codes = await TaxCodeCollection.create({ db });
    const result: TaxCode[] = [];
    for (const [code, name, kind] of STANDARD_TAX_CODES) {
      const existing = await codes.findByCode(code, tenantId);
      if (existing) {
        // The standard codes are reserved: billing lines and zero rates rely
        // on them never carrying tax. An edited one is refused, not adopted.
        if (existing.kind !== kind || existing.components.length > 0)
          throw new Error(
            `Standard tax code '${code}' was changed to kind '${existing.kind}' with ${existing.components.length} component(s); restore it to '${kind}' with no components.`,
          );
        result.push(existing);
      } else {
        const id = await deterministicTaxId(tenantId, 'code', code);
        result.push(
          await createOrLoadTaxSeed(
            () => codes.create({ id, tenantId, code, name, kind }),
            () => codes.findByCode(code, tenantId),
          ),
        );
      }
    }
    return result;
  });
}
