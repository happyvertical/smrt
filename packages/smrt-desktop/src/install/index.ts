export type { BundleManifestV1 } from './bundle-manifest.js';
export {
  assertBundleMatchesSidecar,
  BUNDLE_MANIFEST_FILENAME,
  parseBundleManifest,
  serializeBundleManifest,
} from './bundle-manifest.js';
export type {
  InstallationPlatform,
  InstallationRecordV1,
} from './installation-record.js';
export {
  INSTALLATION_RECORD_FILENAME,
  parseInstallationRecord,
  serializeInstallationRecord,
} from './installation-record.js';
export type {
  LocateInstallationOptions,
  VerifiedInstallation,
} from './locate.js';
export { locateInstallation } from './locate.js';
export type { LocationOptions } from './locations.js';
export {
  DESKTOP_SHELL_DIRNAME,
  resolveAppLocalDataDir,
  resolveDesktopShellDir,
} from './locations.js';
