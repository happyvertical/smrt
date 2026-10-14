import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import { ensureTenantTaxCodes } from './legacy.js';

/** The tax subset emitted by core's cookbook engine, expressed as a percent. */
export interface CookbookTaxSettingsInput {
  taxRate: number;
  pricesIncludeTax: boolean;
  taxRounding: 'line' | 'document';
}

/**
 * Materialize core's legacy cookbook tax setting into commerce-owned records.
 * Core deliberately stays unaware of these models to avoid a core → commerce
 * dependency cycle.
 */
export async function applyCookbookTaxSettings(
  db: DatabaseInterface,
  tenantId: string,
  input: CookbookTaxSettingsInput,
): Promise<void> {
  if (
    !Number.isFinite(input.taxRate) ||
    input.taxRate < 0 ||
    input.taxRate > 100
  )
    throw new Error('Cookbook taxRate must be a percentage between 0 and 100');
  if (!db.transaction)
    throw new Error('Cookbook tax settings require transactions');
  await db.transaction((tx) =>
    withTenant({ tenantId }, async () => {
      const components = await TaxComponentCollection.create({ db: tx });
      const codes = await TaxCodeCollection.create({ db: tx });
      const settings = await TaxSettingsCollection.create({ db: tx });
      if (input.taxRate === 0) {
        await ensureTenantTaxCodes(tx, tenantId);
        const codes = await TaxCodeCollection.create({ db: tx });
        const outOfScope = await codes.findByCode('out-of-scope');
        const current = await settings.getOrCreateForTenant(tenantId);
        current.defaultSalesTaxCodeId = outOfScope?.id ?? '';
        current.defaultPurchaseTaxCodeId = outOfScope?.id ?? '';
        current.defaultLineAmountType = 'none';
        current.taxRoundingScope = input.taxRounding;
        await current.save();
        return;
      }
      const percent = String(input.taxRate);
      const componentName = `Cookbook ${percent}%`;
      let component = (
        await components.list({ where: { name: componentName }, limit: 1 })
      )[0];
      if (!component)
        component = await components.create({
          tenantId,
          name: componentName,
          percent,
        });
      if (!component.id)
        throw new Error('Cookbook tax component did not persist');
      const codeName = `default-${percent.replace('.', '_')}`;
      let code = await codes.findByCode(codeName);
      if (!code)
        code = await codes.create({
          tenantId,
          code: codeName,
          name: `Default ${percent}%`,
          kind: 'taxable',
          components: [{ taxComponentId: component.id, compound: false }],
        });
      if (!code.id) throw new Error('Cookbook tax code did not persist');
      const current = await settings.getOrCreateForTenant(tenantId);
      current.defaultSalesTaxCodeId = code.id;
      current.defaultPurchaseTaxCodeId = code.id;
      current.defaultLineAmountType = input.pricesIncludeTax
        ? 'inclusive'
        : 'exclusive';
      current.taxRoundingScope = input.taxRounding;
      await current.save();
    }),
  );
}
