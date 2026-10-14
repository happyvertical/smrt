import { SmrtCollection } from '@happyvertical/smrt-core';
import { TaxSettings } from '../models/TaxSettings.js';
import { createOrLoadTaxSeed, deterministicTaxId } from '../tax/identity.js';

export class TaxSettingsCollection extends SmrtCollection<TaxSettings> {
  static readonly _itemClass = TaxSettings;

  async getOrCreateForTenant(tenantId: string): Promise<TaxSettings> {
    const existing = (await this.list({ where: { tenantId }, limit: 1 }))[0];
    if (existing) return existing;
    const id = await deterministicTaxId(tenantId, 'settings', 'default');
    return createOrLoadTaxSeed(
      () => this.create({ id, tenantId }),
      async () =>
        (await this.list({ where: { tenantId }, limit: 1 }))[0] ?? null,
    );
  }
}
