/**
 * `@happyvertical/smrt-desktop`: the versioned sidecar manifest the runtime
 * bundler writes and the Tauri wrapper reads. The bundler is `./bundler`
 * (`smrt desktop bundle`).
 *
 * The root is an explicit list of named exports: a new internal export cannot
 * become public by accident.
 */

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
