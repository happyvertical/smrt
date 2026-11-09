/**
 * `@happyvertical/smrt-desktop`: the versioned sidecar manifest and the bundle
 * manifest the runtime bundler writes. The bundler is `./bundler`
 * (`smrt desktop bundle`); the assistant-plugin launcher core is `./launcher`.
 *
 * The root is an explicit list of named exports: a new internal export cannot
 * become public by accident.
 */

export type {
  DesktopContractErrorCode,
  DesktopContractErrorOptions,
  InstallErrorCode,
} from './errors.js';
export { DesktopContractError } from './errors.js';
export type { BundleManifestV1 } from './install/index.js';
export {
  assertBundleMatchesSidecar,
  BUNDLE_MANIFEST_FILENAME,
  parseBundleManifest,
  serializeBundleManifest,
} from './install/index.js';
export type {
  DesktopFs,
  FileHandleLike,
  StatsLike,
} from './internal/fs-seam.js';
export type { SidecarManifestV1 } from './sidecar-manifest.js';
export {
  buildSidecarEnv,
  parseSidecarManifest,
  RESERVED_ENV_KEYS,
  serializeSidecarManifest,
} from './sidecar-manifest.js';
