#!/usr/bin/env node

/**
 * PR- and publish-time guard: verify every object `dist/manifest.json` advertises is
 * actually importable from the built package. A manifest can be *complete*
 * (see `verify-manifest-completeness.mjs`, issue #1483 — every source object
 * appears in the manifest) while still being *wrong*: an object scanned from
 * a file that only a non-root `exports` subpath serves (e.g. `./server`)
 * needs `importPath` stamped so consumers import it from the right
 * specifier. Without that, the manifest advertises a name the package root
 * never exports, and a dynamic import filtered on the manifest's object list
 * silently returns nothing for it — exactly how
 * `DataSurfaceActionIdempotencyState` broke anytown.ai's `.smrt/register.js`
 * export path in `@happyvertical/smrt-agents@0.49.4`.
 *
 * Usage: node scripts/verify-manifest-exports.mjs [packageDir]
 *   - packageDir defaults to the current working directory (so `prepack` can
 *     invoke it without arguments from each package directory).
 *
 * Exit codes:
 *   0 — every manifest object resolves to a real export, or the check does
 *       not apply (no manifest / no dist / no exports map to validate against).
 *   1 — at least one manifest object is not importable from the module its
 *       `importPath` (or the package root) resolves to.
 *
 * @see https://github.com/happyvertical/smrt/issues/2845
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const packageDir = resolve(process.argv[2] ?? process.cwd());
const packageJsonPath = resolve(packageDir, 'package.json');

function skip(reason) {
  console.log(`[verify-manifest-exports] ⏭️  skipped (${reason}).`);
  process.exit(0);
}

if (!existsSync(packageJsonPath)) {
  skip(`no package.json at ${packageJsonPath}`);
}

let packageJson;
try {
  packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
} catch (error) {
  console.error(
    `[verify-manifest-exports] ❌ could not parse package.json: ${error.message}`,
  );
  process.exit(1);
}

const packageName = packageJson.name;
const exportsMap = packageJson.exports;

if (!packageName || !exportsMap || typeof exportsMap !== 'object') {
  skip('package.json has no name/exports map to validate against');
}

/**
 * Resolve a package.json `exports` condition (a string, or an object with
 * `import`/`default`/`require`/`types`) to an absolute path.
 */
function resolveExportTarget(condition) {
  const target =
    typeof condition === 'string'
      ? condition
      : (condition?.import ?? condition?.default ?? condition?.require ??
        condition?.types);
  return typeof target === 'string' ? resolve(packageDir, target) : undefined;
}

// Resolve the manifest through the package's own `exports` entry, not a
// hardcoded `dist/manifest.json`. A package that publishes from a
// non-default layout (e.g. `@happyvertical/smrt-products`, whose manifest is
// `dist/lib/manifest.json`) would otherwise silently `skip()` here — the
// exact #2845 failure mode staying unchecked for that package. Falls back to
// the conventional `dist/manifest.json` only when the package declares
// neither export, to preserve the check for a package that relies on the
// bare-path convention without an explicit `exports` entry.
//
// Prefer `./manifest.json` over `./manifest`: most packages point both at
// the same `dist/manifest.json`, but `@happyvertical/smrt-core` uses
// `./manifest` for an unrelated JS module (manifest *utilities*, not
// manifest *data* — `dist/manifest.js` re-exports `ManifestGenerator` et
// al.) while `./manifest.json` still points at the real data. The `.json`
// suffix unambiguously means "the data", so it wins when both are declared.
// (`verify-manifest-completeness.mjs`'s own `resolveManifestPath` has the
// same ambiguity but never hits it in practice: it hardcodes a skip list —
// `core`, `types`, `config`, `scanner`, `vitest`, `smrt-playground` — of
// framework-infrastructure packages that don't use the scanner manifest at
// all, so it never resolves `core`'s `./manifest` this way.)
const manifestPath =
  resolveExportTarget(exportsMap['./manifest.json'] ?? exportsMap['./manifest']) ??
  resolve(packageDir, 'dist/manifest.json');

if (!existsSync(manifestPath)) {
  skip(`no manifest at ${manifestPath}`);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(
    `[verify-manifest-exports] ❌ could not parse manifest at ${manifestPath}: ${error.message}`,
  );
  process.exit(1);
}

const objects = manifest.objects ?? {};

/**
 * Resolve an `importPath` (or the bare package name, meaning the root "."
 * entry) to the dist file it loads, using the package's own `exports` map —
 * the same map consumers resolve against.
 */
function resolveDistFile(importPath) {
  const subpath =
    importPath === packageName
      ? '.'
      : `.${importPath.slice(packageName.length)}`;
  return resolveExportTarget(exportsMap[subpath]);
}

const moduleCache = new Map();
async function loadModule(distFile) {
  if (moduleCache.has(distFile)) return moduleCache.get(distFile);
  const promise = existsSync(distFile)
    ? import(pathToFileURL(distFile).href).catch((error) => ({
        __loadError: error,
      }))
    : Promise.resolve({ __loadError: new Error(`file does not exist`) });
  moduleCache.set(distFile, promise);
  return promise;
}

// Node error codes that mean "this environment cannot load this kind of
// file at all", not "this file is wrong" — e.g. a package whose root entry
// re-exports Svelte UI components (`.svelte` files) alongside its SmrtObject
// classes is meant for a bundler-aware consumer, not a bare `node --eval
// import()`. Confirmed against a real package in this repo:
// `@happyvertical/smrt-products`' `dist/lib/index.js` statically imports a
// `.svelte` file transitively (via `@happyvertical/smrt-ui`), which fails
// with exactly this code even though every one of its 12 manifest objects is
// genuinely exported. Warn instead of failing the release for these — this
// guard cannot render a verdict on export correctness when the runtime
// itself cannot parse the required file type.
const ENVIRONMENT_LOAD_ERROR_CODES = new Set([
  'ERR_UNKNOWN_FILE_EXTENSION',
  'ERR_UNSUPPORTED_ESM_URL_SCHEME',
]);

/**
 * True only for the package *root* importPath. The root barrel of a UI-bearing
 * package is legitimately bundler-only (the `smrt-products` case described
 * above), so an environment load error there stays a warning. Any other
 * `importPath` is a subpath the manifest deliberately stamped — `./server`
 * above all — and the consumer plugin emits it verbatim into a generated
 * `.smrt/register.js` that the `smrt` CLI imports under plain Node for
 * `db:migrate`. A subpath that cannot be loaded that way is a real defect, not
 * an environment limitation: `@happyvertical/smrt-agents/server` reached a
 * `.svelte` component barrel through `@happyvertical/smrt-ui/data` and broke
 * `db:migrate` for every object in the consuming app (issue #2924).
 */
function isBundlerOnlyImportPath(importPath) {
  return importPath === packageName;
}

/**
 * True for a manifest object that is itself an auto-derived `SmrtCollection`
 * companion class (e.g. `AgentSessionCollection` for `AgentSession`), using
 * the same signal `consumer-plugin/index.ts`'s own `isCollectionClass` reads
 * (`extends === 'SmrtCollection'` or a set `extendsTypeArg`). Collections are
 * frequently and legitimately excluded from a package's public export
 * surface — confirmed against `@happyvertical/smrt-chat`, whose
 * `src/index.ts` deliberately withholds `AgentSessionCollection`,
 * `ChatMessageCollection`, and 6 siblings (issue #1392 / "S5"): exposing the
 * raw collection lets a consumer call e.g. `messages.create({ senderProfileId,
 * role })`, bypassing the authorized `ChatService` facade entirely. No
 * manifest producer marks that distinction (the schema's own `hasCollection`
 * field exists for it but nothing upstream ever writes it — see the note
 * above on `collectionExportName`), so this guard cannot tell an
 * intentionally-withheld collection export from a genuine regression and
 * does not guess: it verifies only non-collection objects.
 */
function isCollectionCompanion(objectDef) {
  return (
    objectDef.extends === 'SmrtCollection' ||
    objectDef.extendsTypeArg !== undefined
  );
}

function isExcludedFromVerification(objectDef) {
  return isCollectionCompanion(objectDef);
}

const failures = [];
const warnings = [];

for (const [objectKey, objectDef] of Object.entries(objects)) {
  // `isExcludedFromVerification` governs EXPORT-NAME verification only. The
  // plain-Node loadability of a non-root `importPath` is checked first, for
  // every object, because the two questions are independent: an object can be
  // legitimately absent as a collection companion while the entry it names
  // still has to import under plain Node. API/CLI/MCP settings do not exempt
  // public model exports: generated consumer registration imports them.
  const excludedFromExportCheck = isExcludedFromVerification(objectDef);

  const importPath = objectDef.importPath ?? packageName;
  const distFile = resolveDistFile(importPath);

  if (!distFile) {
    // A non-root importPath that resolves to no `exports` entry is unloadable
    // for the same reason as the cases below: the consumer plugin emits the
    // specifier verbatim, and Node answers `ERR_PACKAGE_PATH_NOT_EXPORTED`.
    // That breaks `.smrt/register.js` whether or not the object also has an
    // export name worth verifying, so the exclusion does not apply.
    if (excludedFromExportCheck && isBundlerOnlyImportPath(importPath)) continue;
    failures.push({
      kind: 'mismatch',
      message: `${objectKey}: importPath "${importPath}" does not match any package.json "exports" entry`,
    });
    continue;
  }

  const moduleNamespace = await loadModule(distFile);
  if (moduleNamespace.__loadError) {
    const loadError = moduleNamespace.__loadError;
    if (ENVIRONMENT_LOAD_ERROR_CODES.has(loadError.code)) {
      if (!isBundlerOnlyImportPath(importPath)) {
        // A dedicated non-root subpath is a deliberate "load me from here"
        // declaration, and the specifier the consumer plugin emits verbatim
        // into a plain-Node `.smrt/register.js`. Tolerating an unparseable
        // file type there is how #2924 shipped. This applies regardless of
        // `excludedFromExportCheck`.
        failures.push({
          kind: 'bundler-only-subpath',
          message: `${objectKey}: "${importPath}" is not loadable under plain Node (${loadError.code}: ${loadError.message})`,
        });
        continue;
      }
      // A bundler-only ROOT barrel stays a warning (the documented
      // smrt-products case). A collection companion contributes no warning
      // because its export name is not verified, and counting it would
      // skew the summary's verified/unverifiable split.
      if (excludedFromExportCheck) continue;
      warnings.push(
        `${objectKey}: could not verify — loading "${distFile}" hit an environment limitation (${loadError.code}: ${loadError.message}), not evaluated as a failure`,
      );
      continue;
    }
    // Distinct from a real export mismatch: the manifest's importPath may be
    // entirely correct, but importing the target failed for an unrelated
    // reason (an import-time side effect, a native/optional dependency
    // missing in this environment, or similar). Do not tell the operator to
    // "fix the importPath" for a load error.
    //
    // For a non-root importPath the collection exclusion does NOT apply: the
    // entry is unloadable under plain Node, so `.smrt/register.js` breaks in a
    // consuming app. This includes ordinary module errors as well as unknown
    // file types.
    if (excludedFromExportCheck && isBundlerOnlyImportPath(importPath)) continue;
    failures.push({
      kind: 'load-error',
      message: `${objectKey}: failed to load "${distFile}" (${loadError.message})`,
    });
    continue;
  }

  if (excludedFromExportCheck) continue;

  const exportName = objectDef.exportName ?? objectDef.className ?? objectKey;
  if (!(exportName in moduleNamespace)) {
    failures.push({
      kind: 'mismatch',
      message: `${objectKey}: manifest advertises "${exportName}" from "${importPath}", but the built module does not export it`,
    });
    continue;
  }

  // Note: `collectionExportName` is intentionally NOT checked here. Every
  // manifest producer defaults it to `${className}Collection` whether or not
  // a real Collection subclass exists for the object (confirmed against
  // packages/agents/dist/manifest.json: `DataSurfaceActionIdempotencyState`
  // carries `collectionExportName: "DataSurfaceActionIdempotencyStateCollection"`
  // even though `dist/server.js` never exports it). No producer in this repo
  // populates a "this collection export is real" flag the manifest schema
  // declared for that purpose (`hasCollection` — see
  // `consumer-plugin/index.ts`'s own comment calling it a "consumer-only
  // marker" that nothing upstream ever writes), so this guard cannot tell a
  // legitimately-absent default from a dropped real export and does not
  // guess. Collection-export parity is out of scope until a producer stamps
  // that signal; only the primary object export is verified here.
}

if (failures.length > 0) {
  const hasMismatch = failures.some((failure) => failure.kind === 'mismatch');
  const hasLoadError = failures.some((failure) => failure.kind === 'load-error');
  const hasBundlerOnlySubpath = failures.some(
    (failure) => failure.kind === 'bundler-only-subpath',
  );

  console.error(
    `\n[verify-manifest-exports] ❌ ${packageName}: ${failures.length} manifest object(s) failed verification.`,
  );
  for (const failure of failures) {
    console.error(`[verify-manifest-exports]    - ${failure.message}`);
  }
  if (hasMismatch) {
    console.error(
      '[verify-manifest-exports]    Fix (mismatch): stamp the correct importPath in the manifest generator (see resolveImportPaths in packages/core/src/scanner/manifest-generator.ts), or restore the missing export.',
    );
  }
  if (hasLoadError) {
    console.error(
      '[verify-manifest-exports]    Fix (load error): the importPath may be correct — importing the target module itself failed. Check for an import-time side effect, a missing native/optional dependency in this environment, or a build issue unrelated to importPath.',
    );
  }
  if (hasBundlerOnlySubpath) {
    console.error(
      '[verify-manifest-exports]    Fix (bundler-only subpath): a non-root importPath must import cleanly under plain Node, because the consumer plugin emits it verbatim into a generated .smrt/register.js that the smrt CLI loads with a bare import() for db:migrate. Route the entry at a Svelte-free module (e.g. @happyvertical/smrt-ui/data-surface rather than the @happyvertical/smrt-ui/data component barrel) — see issue #2924.',
    );
  }
  console.error(
    '[verify-manifest-exports]    Guards issue #2845 (a manifest advertising DataSurfaceActionIdempotencyState from the package root when it only lived behind "./server" broke consumer registration).',
  );
  process.exit(1);
}

if (warnings.length > 0) {
  console.warn(
    `[verify-manifest-exports] ⚠️  ${packageName}: ${warnings.length} object(s) could not be verified in this environment (not a failure).`,
  );
  for (const warning of warnings) {
    console.warn(`[verify-manifest-exports]    - ${warning}`);
  }
}

const excludedCount = Object.values(objects).filter(
  isExcludedFromVerification,
).length;
const verifiedCount =
  Object.keys(objects).length - warnings.length - excludedCount;
console.log(
  `[verify-manifest-exports] ✅ ${packageName}: ${verifiedCount} manifest object(s) resolve to real exports${warnings.length > 0 ? ` (${warnings.length} unverifiable)` : ''}${excludedCount > 0 ? ` (${excludedCount} not checked: collection companion)` : ''}.`,
);
process.exit(0);
