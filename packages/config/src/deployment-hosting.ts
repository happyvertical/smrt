/**
 * `@happyvertical/smrt-config/deployment/hosting`: the I/O half of hosting a
 * compose-declared application.
 *
 * Reads the declaration at an exact commit from GitHub and server-side-applies
 * the `HostedApp` composed by `composeHostedApp` (from the browser-safe
 * `@happyvertical/smrt-config/deployment` entry). It uses `fetch` and a YAML
 * parser, so it is kept apart from that entry.
 */

export {
  COMPOSE_DECLARATION_PATHS,
  COMPOSE_MAX_ALIAS_COUNT,
  COMPOSE_MAX_SOURCE_LENGTH,
  ComposeDeclarationReadError,
  type ComposeDeclarationReadErrorCode,
  type GitHubComposeDeclaration,
  type GitHubComposeSourceOptions,
  parseComposeDocument,
  readGitHubComposeDeclaration,
} from './deployment/compose-source.js';
export {
  createHostedAppApplier,
  type HostedAppApplier,
  type HostedAppApplierOptions,
  HostedAppApplyError,
} from './deployment/hosted-app-applier.js';
