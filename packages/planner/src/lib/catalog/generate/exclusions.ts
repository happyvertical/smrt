/**
 * Packages that are s-m-r-t infrastructure, not domain modules a visitor would
 * "pick": they publish a `manifest.json` (or none) but carry no business models
 * worth mocking up. Everything else that exports `./manifest.json` and declares
 * at least one model is a catalog package, discovered from the registry.
 *
 * A listed package that declares recipes is NOT excluded: its recipes are
 * features a visitor can pick (`chat.assistant`, `fields.form-customization`),
 * so `assembleCatalog` keeps it and the exclusion applies only to a package
 * with none.
 *
 * Packages without a `./manifest.json` export (cli, app-runtime, svelte, ui,
 * vitest, ...) never need listing; they are skipped by discovery itself.
 * Short names, without the `smrt-` prefix.
 */
export const EXCLUDED_PACKAGES: Readonly<Record<string, string>> = {
  affiliates: 'deprecated compatibility shim over smrt-sales; no models',
  agents: 'agent framework (infrastructure)',
  chat: 'chat runtime and conversation infrastructure',
  core: 'the framework itself',
  features: 'feature-flag infrastructure',
  fields: 'field-policy infrastructure',
  gnode: 'federation library; no models',
  jobs: 'background-job infrastructure',
  languages: 'string-table infrastructure',
  personas: 'agent-persona infrastructure',
  playbooks: 'agent-playbook infrastructure',
  prompts: 'prompt-registry infrastructure',
  secrets: 'secret storage infrastructure',
  tenancy: 'multi-tenancy infrastructure',
};

export const PACKAGE_SCOPE = '@happyvertical/';
export const PACKAGE_PREFIX = `${PACKAGE_SCOPE}smrt-`;

/**
 * Models that are s-m-r-t bookkeeping inside a package the catalog keeps,
 * never something a visitor would add or see: dropped from the catalog, the
 * reason recorded here. Qualified names.
 */
export const EXCLUDED_MODELS: Readonly<Record<string, string>> = {
  '@happyvertical/smrt-commerce:MoneyMigrationDocument':
    'tenant money-migration journal (smrt#3988); written only by the migration',
};

/**
 * Money-model internals of smrt-commerce (smrt#3988): serialized snapshots
 * (`*Json`: tax components, registrations, credit bases, sync state), the
 * freeze identity (`moneySnapshotId`), the migration's rollback copy
 * (`legacyAmount`) and its marker and owner (`moneyModel`,
 * `moneyMigrationId`). The framework writes them; generated surfaces and
 * cookbooks never do. They stay in the catalog marked `system`, so forms,
 * lists, record pages and policies skip them while sample data still keeps
 * a line's tax snapshot.
 */
const INTERNAL_MONEY_FIELDS = new Set([
  'moneySnapshotId',
  'legacyAmount',
  'moneyModel',
  'moneyMigrationId',
]);

/** Is `field` of a model in `packageName` a framework-managed money internal? */
export function isInternalMoneyField(
  packageName: string,
  field: string,
): boolean {
  return (
    packageName === `${PACKAGE_PREFIX}commerce` &&
    (INTERNAL_MONEY_FIELDS.has(field) || /[a-z]Json$/.test(field))
  );
}
