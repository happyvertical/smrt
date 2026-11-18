/**
 * Shared pieces for tests that run emitted servers and routes in plain Node
 * against a stubbed `@happyvertical/smrt-core`.
 *
 * The stubs record what generated code asks the registry for; the request
 * helpers below are not stubbed. Emitted code imports them from the package
 * root, and a stub re-exports the built ones so the rule under test is the
 * shipped rule.
 */

import { fileURLToPath } from 'node:url';

/** Built root entry of this package. */
export const BUILT_CORE_ENTRY = fileURLToPath(
  new URL('../../../dist/index.js', import.meta.url),
);

/** Names emitted servers and routes import for request input and output. */
export const REQUEST_HELPER_NAMES = [
  'applyUpdateInput',
  'assertQueryAccess',
  'publicSerializerOf',
  'toPublicJSONValue',
] as const;

/**
 * One source line for a stubbed core module: the request helpers, re-exported
 * from the built package.
 */
export const REQUEST_HELPER_EXPORTS = `export { ${REQUEST_HELPER_NAMES.join(', ')} } from ${JSON.stringify(BUILT_CORE_ENTRY)};`;
