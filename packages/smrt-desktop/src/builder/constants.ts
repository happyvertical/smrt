/**
 * What `smrt desktop build` takes from the installed package and which tools it
 * pins. The list of wrapper files is the contract with `package.json` `files`
 * (`package-contents.test.ts` checks both directions).
 */

/**
 * Exact Tauri CLI release this command accepts. It is the same version the
 * repository workflows install (`TAURI_CLI_VERSION` in
 * `.github/workflows/desktop-release.yml`; a test keeps them equal), so a
 * consumer builds with the CLI the wrapper's lockfile was tested with.
 */
export const TAURI_CLI_VERSION = '2.12.4';

/** Files copied from the packaged wrapper into the scratch build tree. */
export const WRAPPER_FILES: readonly string[] = Object.freeze([
  'Cargo.toml',
  'Cargo.lock',
  'build.rs',
  'tauri.conf.json',
]);

/** Directories copied (regular files only) from the packaged wrapper. */
export const WRAPPER_DIRS: readonly string[] = Object.freeze([
  'capabilities',
  'frontend',
  'icons',
  'src',
]);

/** Scripts copied into the scratch tree (the launch smoke and its support). */
export const WRAPPER_SCRIPTS: readonly string[] = Object.freeze([
  'scripts/launch-smoke.mjs',
  'scripts/smoke-support.mjs',
]);

/**
 * Packaged for the preflight (`release-preflight.mjs`, run by the reusable
 * workflow before any signing step) but not copied into the build tree.
 */
export const WRAPPER_TOOLS: readonly string[] = Object.freeze([
  'scripts/release-preflight.mjs',
]);

/** Every path `package.json` `files` must list for the wrapper (README too). */
export const WRAPPER_PACKAGE_PATHS: readonly string[] = Object.freeze([
  ...WRAPPER_FILES,
  ...WRAPPER_DIRS,
  ...WRAPPER_SCRIPTS,
  ...WRAPPER_TOOLS,
  'README.md',
]);

/** The installer kind each OS gets (the AppImage is not supported in v1). */
export const INSTALLER_KINDS = Object.freeze({
  darwin: { bundles: 'app', directory: 'macos', match: /\.app$/ },
  win32: { bundles: 'nsis', directory: 'nsis', match: /-setup\.exe$/ },
  linux: { bundles: 'deb', directory: 'deb', match: /\.deb$/ },
} as const);

export const SCRATCH_OVERLAY = 'tauri.build.json';
export const PRODUCT_ICON_DIR = 'icons/product';
