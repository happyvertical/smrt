/**
 * Bundled consumer with its own `LicenseSale` next to smrt-commerce's (#3106).
 *
 * Bundled into a server entry the way a SvelteKit app bundles its own code,
 * with SMRT packages left external (installed dist), then executed in a fresh
 * process. `SMRT_GATE_ORDER` picks whether commerce or the consumer class
 * registers first.
 */
import { ObjectRegistry, SmrtObject, smrt } from '@happyvertical/smrt-core';

type CommerceModule = typeof import('@happyvertical/smrt-commerce');

const providerFirst = process.env.SMRT_GATE_ORDER === 'provider-first';
let commerce: CommerceModule | undefined;
if (providerFirst) commerce = await import('@happyvertical/smrt-commerce');

// The consumer's own model: declared in the app bundle, its own table.
const ConsumerLicenseSale = smrt({ tableName: 'license_sales' })(
  class LicenseSale extends SmrtObject {},
);

if (!providerFirst) commerce = await import('@happyvertical/smrt-commerce');
const ProviderLicenseSale =
  commerce?.LicenseSale as unknown as typeof SmrtObject;

const consumer = ObjectRegistry.getClassByConstructor(ConsumerLicenseSale);
const provider = ObjectRegistry.getClassByConstructor(ProviderLicenseSale);
const provided = ObjectRegistry.getClassByQualifiedName(
  '@happyvertical/smrt-commerce:LicenseSale' as never,
);
const schemas = ObjectRegistry.getAllSchemasAsDefinitions();

console.log(
  `SMRT_SAME_NAME_RESULT=${JSON.stringify({
    consumer: {
      qualifiedName: consumer?.qualifiedName,
      tableName: consumer?.schema?.tableName,
      constructorMatches: consumer?.constructor === ConsumerLicenseSale,
    },
    provider: {
      qualifiedName: provider?.qualifiedName,
      tableName: ObjectRegistry.getTableName(provider?.qualifiedName ?? ''),
      constructorMatches: provided?.constructor === ProviderLicenseSale,
    },
    tables: ['contracts', 'license_sales'].filter((table) => table in schemas),
  })}`,
);
