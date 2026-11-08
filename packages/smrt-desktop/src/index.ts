export type {
  DesktopContractErrorCode,
  DesktopContractErrorOptions,
  InstallErrorCode,
  RendezvousErrorCode,
} from './errors.js';
export { DesktopContractError } from './errors.js';
export type {
  BundleManifestV1,
  InstallationPlatform,
  InstallationRecordV1,
  LocateInstallationOptions,
  LocationOptions,
  VerifiedInstallation,
} from './install/index.js';
export {
  assertBundleMatchesSidecar,
  BUNDLE_MANIFEST_FILENAME,
  DESKTOP_SHELL_DIRNAME,
  INSTALLATION_RECORD_FILENAME,
  locateInstallation,
  parseBundleManifest,
  parseInstallationRecord,
  resolveAppLocalDataDir,
  resolveDesktopShellDir,
  serializeBundleManifest,
  serializeInstallationRecord,
} from './install/index.js';
export type {
  DesktopFs,
  FileHandleLike,
  StatsLike,
} from './internal/fs-seam.js';
export * from './rendezvous/index.js';
export { SecretString } from './secret-string.js';
export type { SidecarManifestV1 } from './sidecar-manifest.js';
export {
  buildSidecarEnv,
  parseSidecarManifest,
  RESERVED_ENV_KEYS,
} from './sidecar-manifest.js';
