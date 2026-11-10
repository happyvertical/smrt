import { readFileSync } from 'node:fs';
import { getTestManifestPath } from '@happyvertical/smrt-vitest';
import { describe, expect, it } from 'vitest';
import { separateHostedStiCollections } from '../../../core/src/consumer-plugin/hosted-sti-collections.js';
import type { SmartObjectManifest } from '../../../core/src/scanner/types.js';
import {
  buildWebCollectionDefinition,
  selectWebCollectionEntries,
} from '../../../core/src/vite-plugin/web-collections.js';
import { deriveScreenRelations } from '../../../smrt-svelte/src/components/screens/relations.js';

const SALES = [
  'Estimate',
  'Order',
  'WholesaleOrder',
  'Cart',
  'Lease',
  'Agreement',
  'LicenseSale',
];
const PURCHASES = ['SupplierQuote', 'PurchaseOrder', 'ProductionOrder'];
const ref = (name: string) => `@happyvertical/smrt-commerce:${name}`;

function screenDefinitions() {
  const manifest = JSON.parse(
    readFileSync(getTestManifestPath(), 'utf8'),
  ) as SmartObjectManifest;
  const hostedRefs = ['Customer', 'Vendor', ...SALES, ...PURCHASES].map(ref);
  const wanted = new Set(hostedRefs);
  const hosted = separateHostedStiCollections(
    manifest,
    hostedRefs,
    (key, object) => object.qualifiedName ?? key,
  );
  return Object.fromEntries(
    selectWebCollectionEntries(hosted)
      .filter((entry) => wanted.has(entry.obj.qualifiedName ?? ''))
      .map((entry) => [
        entry.collection,
        buildWebCollectionDefinition(entry, hosted),
      ]),
  );
}

describe('manifest-derived Customer and Vendor record tabs (#3898)', () => {
  it.each([
    ['Customer', SALES],
    ['Vendor', PURCHASES],
  ] as const)('shows only applicable contract tabs on %s', (party, expected) => {
    const relations = deriveScreenRelations(screenDefinitions(), ref(party));
    const children = relations
      .filter((relation) => relation.kind !== 'reference')
      .map((relation) => relation.model.split(':').pop())
      .sort();
    expect(children).toEqual([...expected].sort());
  });
});
