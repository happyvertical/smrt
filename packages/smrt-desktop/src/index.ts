export type {
  DesktopContractErrorCode,
  DesktopContractErrorOptions,
  InstallErrorCode,
} from './errors.js';
export { DesktopContractError } from './errors.js';
export { SecretString } from './secret-string.js';
export type { SidecarManifestV1 } from './sidecar-manifest.js';
export {
  buildSidecarEnv,
  parseSidecarManifest,
  RESERVED_ENV_KEYS,
} from './sidecar-manifest.js';
