/**
 * `@happyvertical/smrt-desktop/builder`: `smrt desktop build` (Node only).
 *
 * Separate from the root and from `./bundler` on purpose: it uses
 * `node:child_process` and `node:fs`. See the package README, "Building an
 * installer".
 */

export {
  INSTALLER_KINDS,
  TAURI_CLI_VERSION,
  WRAPPER_PACKAGE_PATHS,
} from './constants.js';
export type { BuildErrorCode, BuildStage } from './errors.js';
export { BUILD_ERROR_CODES, BUILD_STAGES, BuildError } from './errors.js';
export type {
  BuildFs,
  BuildOptionsInput,
  BuildPlan,
  BuildResult,
  BuildSeams,
  ChildRequest,
} from './run.js';
export {
  buildToolchainEnv,
  createBuildPlan,
  runBuild,
} from './run.js';
export { createBuildSeams, findPackageRoot } from './runtime.js';
