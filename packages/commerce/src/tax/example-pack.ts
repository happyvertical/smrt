import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../collections/TaxComponentCollection.js';
import type { TaxCodeAppliesTo } from '../models/TaxCode.js';
import { deterministicTaxId } from './identity.js';

export interface TaxCodeExamplePack {
  id: string;
  components: readonly {
    key: string;
    name: string;
    percent: string;
    recoverable: boolean;
  }[];
  codes: readonly {
    code: string;
    name: string;
    appliesTo: TaxCodeAppliesTo;
    componentKeys: readonly string[];
  }[];
}

/** Illustrative common rates; applications must confirm local applicability. */
export const COMMON_TAX_CODE_EXAMPLE_PACK: TaxCodeExamplePack = {
  id: 'common-sales-taxes-v1',
  components: [
    { key: 'ca-gst-5', name: 'Canada GST 5%', percent: '5', recoverable: true },
    { key: 'ca-pst-bc-7', name: 'BC PST 7%', percent: '7', recoverable: false },
    {
      key: 'ca-hst-on-13',
      name: 'Ontario HST 13%',
      percent: '13',
      recoverable: true,
    },
    { key: 'uk-vat-20', name: 'UK VAT 20%', percent: '20', recoverable: true },
    {
      key: 'au-gst-10',
      name: 'Australia GST 10%',
      percent: '10',
      recoverable: true,
    },
    {
      key: 'nz-gst-15',
      name: 'New Zealand GST 15%',
      percent: '15',
      recoverable: true,
    },
  ],
  codes: [
    {
      code: 'ca-gst',
      name: 'Canada GST',
      appliesTo: 'both',
      componentKeys: ['ca-gst-5'],
    },
    {
      code: 'ca-gst-pst-bc',
      name: 'BC GST + PST',
      appliesTo: 'both',
      componentKeys: ['ca-gst-5', 'ca-pst-bc-7'],
    },
    {
      code: 'ca-hst-on',
      name: 'Ontario HST',
      appliesTo: 'both',
      componentKeys: ['ca-hst-on-13'],
    },
    {
      code: 'uk-vat-standard',
      name: 'UK VAT standard',
      appliesTo: 'both',
      componentKeys: ['uk-vat-20'],
    },
    {
      code: 'au-gst',
      name: 'Australia GST',
      appliesTo: 'both',
      componentKeys: ['au-gst-10'],
    },
    {
      code: 'nz-gst',
      name: 'New Zealand GST',
      appliesTo: 'both',
      componentKeys: ['nz-gst-15'],
    },
  ],
};

/** Import a documented example pack without changing existing tenant rows. */
export async function applyTaxCodeExamplePack(
  db: DatabaseInterface,
  tenantId: string,
  pack: TaxCodeExamplePack = COMMON_TAX_CODE_EXAMPLE_PACK,
): Promise<{
  componentIds: Record<string, string>;
  codeIds: Record<string, string>;
}> {
  if (!db.transaction)
    throw new Error('Tax example packs require transactions');
  if (!tenantId.trim() || !pack.id.trim())
    throw new Error('Tax example packs require tenant and pack IDs');
  return db.transaction((tx) =>
    withTenant({ tenantId }, async () => {
      const components = await TaxComponentCollection.create({ db: tx });
      const codes = await TaxCodeCollection.create({ db: tx });
      const componentIds: Record<string, string> = {};
      const seenComponents = new Set<string>();
      for (const seed of pack.components) {
        if (seenComponents.has(seed.key))
          throw new Error(`Duplicate tax example component key: ${seed.key}`);
        seenComponents.add(seed.key);
        const id = await deterministicTaxId(
          tenantId,
          'component',
          `${pack.id}:${seed.key}`,
        );
        const existing = await components.get({ id }, { cache: false });
        const component =
          existing ??
          (await components.create({
            id,
            tenantId,
            name: seed.name,
            percent: seed.percent,
            recoverable: seed.recoverable,
          }));
        if (!component.id)
          throw new Error(`Tax example component did not persist: ${seed.key}`);
        componentIds[seed.key] = component.id;
      }
      const codeIds: Record<string, string> = {};
      const seenCodes = new Set<string>();
      for (const seed of pack.codes) {
        if (seenCodes.has(seed.code))
          throw new Error(`Duplicate tax example code: ${seed.code}`);
        seenCodes.add(seed.code);
        const parts = seed.componentKeys.map((key) => {
          const taxComponentId = componentIds[key];
          if (!taxComponentId)
            throw new Error(`Unknown tax example component key: ${key}`);
          return { taxComponentId, compound: false };
        });
        const existing = await codes.findByCode(seed.code);
        const code =
          existing ??
          (await codes.create({
            id: await deterministicTaxId(
              tenantId,
              'code',
              `${pack.id}:${seed.code}`,
            ),
            tenantId,
            code: seed.code,
            name: seed.name,
            appliesTo: seed.appliesTo,
            components: parts,
          }));
        if (!code.id)
          throw new Error(`Tax example code did not persist: ${seed.code}`);
        codeIds[seed.code] = code.id;
      }
      return { componentIds, codeIds };
    }),
  );
}
