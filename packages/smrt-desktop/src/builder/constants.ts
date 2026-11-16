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
 * Packaged for the reusable workflow's release legs (preflight, signing and
 * publishing resolve them from the caller's installed package) but not copied
 * into the build tree. `release-feed.mjs` imports `minisign.mjs` and
 * `release-preflight.mjs`.
 */
export const WRAPPER_TOOLS: readonly string[] = Object.freeze([
  'scripts/release-preflight.mjs',
  'scripts/release-environment.mjs',
  'scripts/release-feed.mjs',
  'scripts/minisign.mjs',
]);

/**
 * The locked Tauri CLI the signing job installs with `npm ci --ignore-scripts`
 * (a copy of these two files; `node_modules` is never packaged).
 */
export const WRAPPER_SIGNING_TOOLS: readonly string[] = Object.freeze([
  'signing-tools/package.json',
  'signing-tools/package-lock.json',
]);

/**
 * The committed Node pin table, outside `wrapper/`. The release preflight
 * parses it without executing it (`--node-pins`).
 */
export const NODE_PINS_PACKAGE_PATH = 'src/bundler/node-pins.ts';

/** Every path `package.json` `files` must list for the wrapper (README too). */
export const WRAPPER_PACKAGE_PATHS: readonly string[] = Object.freeze([
  ...WRAPPER_FILES,
  ...WRAPPER_DIRS,
  ...WRAPPER_SCRIPTS,
  ...WRAPPER_TOOLS,
  ...WRAPPER_SIGNING_TOOLS,
  'README.md',
]);

/** The installer kind each OS gets (the AppImage is not supported in v1). */
export const INSTALLER_KINDS = Object.freeze({
  darwin: { bundles: 'app', directory: 'macos', match: /\.app$/ },
  win32: { bundles: 'nsis', directory: 'nsis', match: /-setup\.exe$/ },
  linux: { bundles: 'deb', directory: 'deb', match: /\.deb$/ },
} as const);

/**
 * Written as the updater public key when the product has none. Deliberately not
 * a valid key (the release preflight rejects it as a placeholder), so an
 * installer built without `updaterPublicKey` never trusts the wrapper's own
 * committed key. Not a default for `updaterPublicKey`: nothing is configured.
 */
export const MISSING_UPDATER_KEY_PLACEHOLDER =
  'PLACEHOLDER-NO-UPDATER-KEY-CONFIGURED';

export const SCRATCH_OVERLAY = 'tauri.build.json';
export const PRODUCT_ICON_DIR = 'icons/product';
