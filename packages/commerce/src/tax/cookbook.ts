import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { Cookbook, CookbookPolicyRow } from '@happyvertical/smrt-types';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import { createOrLoadTaxSeed, deterministicTaxId } from './identity.js';
import { ensureTenantTaxCodes } from './standard-codes.js';

/** The tax subset emitted by core's cookbook engine, expressed as a percent. */
export interface CookbookTaxSettingsInput {
  taxRate: number;
  pricesIncludeTax: boolean;
  taxRounding: 'line' | 'document';
}

const COMMERCE = '@happyvertical/smrt-commerce:';

function policyValue(
  policies: readonly CookbookPolicyRow[],
  targets: readonly (readonly [string, string])[],
): unknown {
  for (const [model, field] of targets) {
    const value = policies.find(
      (row) =>
        row.scopeType === 'app' &&
        row.objectRef === `${COMMERCE}${model}` &&
        row.fieldName === field,
    )?.defaultValue;
    if (value === undefined || value === null) continue;
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`Cookbook ${model}.${field} default is not JSON`);
    }
  }
  return undefined;
}

/** Read the validated cookbook's persisted commerce setting rows. */
export function cookbookTaxSettings(
  cookbook: Pick<Cookbook, 'policies'>,
): CookbookTaxSettingsInput {
  const fraction = policyValue(cookbook.policies, [
    ['InvoiceLineItem', 'taxRate'],
    ['ContractLineItem', 'taxRate'],
  ]);
  const amountType = policyValue(cookbook.policies, [
    ['Invoice', 'lineAmountType'],
    ['Contract', 'lineAmountType'],
  ]);
  const rounding = policyValue(cookbook.policies, [
    ['Invoice', 'taxRoundingScope'],
    ['Contract', 'taxRoundingScope'],
  ]);
  if (fraction !== undefined && typeof fraction !== 'number')
    throw new Error('Cookbook taxRate default must be numeric');
  if (
    amountType !== undefined &&
    amountType !== 'exclusive' &&
    amountType !== 'inclusive'
  )
    throw new Error(
      'Cookbook lineAmountType default must be inclusive or exclusive',
    );
  if (rounding !== undefined && rounding !== 'line' && rounding !== 'document')
    throw new Error(
      'Cookbook taxRoundingScope default must be line or document',
    );
  return {
    taxRate: Number((((fraction as number | undefined) ?? 0) * 100).toFixed(6)),
    pricesIncludeTax: amountType === 'inclusive',
    taxRounding: (rounding as 'line' | 'document' | undefined) ?? 'line',
  };
}

/**
 * Explicit server bootstrap boundary for a host that owns both the database
 * and authoritative tenant context after schema setup.
 */
export async function applyCommerceCookbookSettings(
  db: DatabaseInterface,
  tenantId: string,
  cookbook: Pick<Cookbook, 'policies'>,
): Promise<void> {
  if (!tenantId.trim())
    throw new Error('Cookbook tax settings require a tenant');
  await applyCookbookTaxSettings(db, tenantId, cookbookTaxSettings(cookbook));
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
        const outOfScope = await codes.findByCode('out-of-scope', tenantId);
        const current = await settings.getOrCreateForTenant(tenantId);
        current.defaultSalesTaxCodeId = outOfScope?.id ?? '';
        current.defaultPurchaseTaxCodeId = outOfScope?.id ?? '';
        current.defaultLineAmountType = input.pricesIncludeTax
          ? 'inclusive'
          : 'exclusive';
        current.taxRoundingScope = input.taxRounding;
        await current.save();
        return;
      }
      const percent = String(input.taxRate);
      const componentName = `Cookbook ${percent}%`;
      let component = (
        await components.list({ where: { name: componentName }, limit: 1 })
      )[0];
      if (!component) {
        const id = await deterministicTaxId(
          tenantId,
          'component',
          `cookbook-${percent}`,
        );
        component = await createOrLoadTaxSeed(
          () =>
            components.create({
              id,
              tenantId,
              name: componentName,
              percent,
            }),
          () => components.get({ id }, { cache: false }),
        );
      }
      if (!component.id)
        throw new Error('Cookbook tax component did not persist');
      const componentId = component.id;
      const codeName = `default-${percent.replace('.', '_')}`;
      let code = await codes.findByCode(codeName, tenantId);
      if (!code) {
        const id = await deterministicTaxId(tenantId, 'code', codeName);
        code = await createOrLoadTaxSeed(
          () =>
            codes.create({
              id,
              tenantId,
              code: codeName,
              name: `Default ${percent}%`,
              kind: 'taxable',
              components: [{ taxComponentId: componentId, compound: false }],
            }),
          () => codes.findByCode(codeName, tenantId),
        );
      }
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
