/**
 * Server entry for the #4176 gate, bundled the way a SvelteKit app bundles
 * its own code (SMRT packages external) and run from the app root, so the
 * runtime reads the scanner-generated `.smrt/manifest.json`.
 *
 * It drives the path that broke anytown.ai#1697: decorator registration
 * against the manifest, the first `getAllFields()` / `ensureManifestLoaded()`
 * (lazy manifest hydration), then a collection `list()`, whose table binding
 * walks `getSTIBase()`. Every step must keep commerce's `Agreement`.
 */
import { ObjectRegistry, type SmrtObject } from '@happyvertical/smrt-core';
import { loadManifestFromPathSync } from '@happyvertical/smrt-core/manifest';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { Agreement as SalesAgreement } from '@happyvertical/smrt-sales';
import {
  AdvertisingProductContract,
  AdvertisingProductContractCollection,
} from './AdvertisingProductContract';

const COMMERCE_AGREEMENT = '@happyvertical/smrt-commerce:Agreement';

function capture<T>(step: () => T): { value?: T; error?: string } {
  try {
    return { value: step() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const consumer = ObjectRegistry.getClassByConstructor(
  AdvertisingProductContract as unknown as typeof SmrtObject,
);
const consumerName = consumer?.qualifiedName ?? '';
const sales = ObjectRegistry.getClassByConstructor(
  SalesAgreement as unknown as typeof SmrtObject,
);
const registeredExtends = consumer?.extends;

// The app's runtime reads its own generated manifest, as consumers whose
// models are bundled do; hydration then reconciles against this entry.
const appManifest = loadManifestFromPathSync('.smrt/manifest.json');

let hydrationError: string | null = null;
let placementField = false;
try {
  const fields = await ObjectRegistry.getAllFields(consumerName);
  placementField = fields.has('placement');
  await ObjectRegistry.ensureManifestLoaded(consumerName);
} catch (error) {
  hydrationError = error instanceof Error ? error.message : String(error);
}
const hydratedExtends = ObjectRegistry.getClass(consumerName)?.extends;

let listError: string | null = null;
let tableName: string | undefined;
try {
  const db = await getTestDatabase({ classes: [COMMERCE_AGREEMENT] });
  const contracts = await AdvertisingProductContractCollection.create({ db });
  tableName = contracts.tableName;
  await contracts.list({});
} catch (error) {
  listError = error instanceof Error ? error.message : String(error);
}

console.log(
  `SMRT_QUALIFIED_PARENT_SERVER_RESULT=${JSON.stringify({
    consumer: consumerName,
    appManifestLoaded: !!appManifest,
    salesQualifiedName: sales?.qualifiedName,
    registeredExtends,
    hydratedExtends,
    finalExtends: ObjectRegistry.getClass(consumerName)?.extends,
    hydrationError,
    placementField,
    chain: capture(() => ObjectRegistry.getInheritanceChain(consumerName)),
    stiBase: capture(() => ObjectRegistry.getSTIBase(consumerName)),
    commerceStiBase: capture(() =>
      ObjectRegistry.getSTIBase(COMMERCE_AGREEMENT),
    ).value,
    commerceTable:
      ObjectRegistry.getClass(COMMERCE_AGREEMENT)?.schema?.tableName,
    tableName,
    listError,
  })}`,
);
