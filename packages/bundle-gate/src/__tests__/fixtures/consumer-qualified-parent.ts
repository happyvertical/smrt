/**
 * Bundled consumer subclass of smrt-commerce's `Agreement` while smrt-sales
 * declares its own `Agreement` (#4145).
 *
 * Bundled into a server entry the way a SvelteKit app bundles its own code,
 * with SMRT packages left external, then executed in a fresh process. The
 * consumer has no manifest here: its parent must come from the constructor
 * it actually extends, and an unrelated STI model's `toJSON()` (which walks
 * every registered class's inheritance chain) must not fail.
 */

import { Agreement } from '@happyvertical/smrt-commerce';
import { ObjectRegistry, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { Agreement as SalesAgreement } from '@happyvertical/smrt-sales';

const AdvertisingProductContract = smrt()(
  class AdvertisingProductContract extends Agreement {},
);
const Redirect = smrt({ tableStrategy: 'sti', tableName: 'redirects_4145' })(
  class Redirect extends SmrtObject {},
);

const consumer = ObjectRegistry.getClassByConstructor(
  AdvertisingProductContract as unknown as typeof SmrtObject,
);
const sales = ObjectRegistry.getClassByConstructor(
  SalesAgreement as unknown as typeof SmrtObject,
);
const consumerName = consumer?.qualifiedName ?? '';

let toJSONError: string | null = null;
try {
  new Redirect().toJSON();
} catch (error) {
  toJSONError = error instanceof Error ? error.message : String(error);
}

console.log(
  `SMRT_QUALIFIED_PARENT_RESULT=${JSON.stringify({
    consumer: consumerName,
    extends: consumer?.extends,
    chain: ObjectRegistry.getInheritanceChain(consumerName),
    commerceDescendant: ObjectRegistry.getDescendants(
      '@happyvertical/smrt-commerce:Agreement',
    ).includes(consumerName),
    salesDescendant: ObjectRegistry.getDescendants(
      sales?.qualifiedName ?? '@happyvertical/smrt-sales:Agreement',
    ).includes(consumerName),
    salesQualifiedName: sales?.qualifiedName,
    toJSONError,
  })}`,
);
