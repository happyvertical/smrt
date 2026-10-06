/**
 * Packages that are s-m-r-t infrastructure, not domain modules a visitor would
 * "pick": they publish a `manifest.json` (or none) but carry no business models
 * worth mocking up. Everything else that exports `./manifest.json` and declares
 * at least one model is a catalog package, discovered from the registry.
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
