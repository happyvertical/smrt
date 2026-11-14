/**
 * The build's schema: the one value `smrt db:migrate`, `migrateSmrtSchemas`
 * and the startup check all read (#4929, #4928).
 *
 * "The build" is the app's project manifest, the first of
 * {@link PROJECT_MANIFEST_PATHS} under the project root: the manifest the
 * app's bundled description (`.smrt/build-schema.js`) is written from. Its
 * `schemaFingerprint` is the stamp. Startup compares that stamp with the last
 * migrate record and never looks at the live registry, so what a process has
 * imported so far does not matter. Migrate records the fingerprint of its
 * planned schema restricted to the build's tables and the build's package
 * list, which equal the stamp and the same list by construction.
 */
import { existsSync, join, readFileSync } from '../manifest/node-host.js';
import { isRefusedTestArtifact } from '../manifest/test-artifacts.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import {
  manifestTableEntries,
  tryComputeManifestSchemaFingerprint,
} from './schema-fingerprint.js';

/**
 * Project manifest locations, in the order `smrt db:migrate` reads them (its
 * schema contract accepts only these). Startup reads the same order, so both
 * sides read the same file.
 *
 * `.smrt/manifest.json` is first because the build's description that ships in
 * the app's bundle is written from it, in the same publish: migrate and the
 * bundled app agree by construction. A `dist/manifest.json` is a published
 * library manifest (it may list only a package's own objects, as the shell's
 * does); it is the build only when nothing else exists, for example when
 * migrating in a library's own directory with no `.smrt` output.
 */
export const PROJECT_MANIFEST_PATHS = [
  '.smrt/manifest.json',
  'dist/manifest.json',
  'src/manifest/manifest.json',
] as const;

/** Environment variable naming the build's project manifest file. */
export const BUILD_MANIFEST_ENV = 'SMRT_BUILD_MANIFEST';

export interface BuildSchema {
  /** The build's stamp; undefined when the build could not compute one. */
  fingerprint?: string;
  /** Why there is no fingerprint (for the startup message). */
  missingReason?: string;
  /** Each table of the build, with the packages that contribute to it. */
  tables: Record<string, string[]>;
  /** Packages that contribute tables to the build, sorted. */
  packages: string[];
  /** Where the build schema came from (a path, or `registered`). */
  source: string;
  /**
   * Set when another project manifest exists that describes a different
   * schema: names the one used and why. Never read from a bundled module.
   */
  notice?: string;
}

type ManifestLike = Pick<SmartObjectManifest, 'objects'> &
  Partial<Pick<SmartObjectManifest, 'packageName' | 'schemaFingerprint'>>;

function entryPackage(
  key: string,
  object: { packageName?: string },
  manifestPackage?: string,
): string {
  if (object.packageName) return object.packageName;
  const separator = key.lastIndexOf(':');
  if (separator > 0) return key.slice(0, separator);
  return manifestPackage ?? '<unqualified>';
}

/** Describe a project manifest as the build's schema. Pure; no I/O. */
export function describeManifestSchema(
  manifest: ManifestLike,
  source = 'manifest',
): BuildSchema {
  const tables: Record<string, Set<string>> = {};
  for (const { source: key, schema } of manifestTableEntries(manifest)) {
    const hasColumns = Object.keys(schema.columns ?? {}).length > 0;
    const ddl = typeof schema.ddl === 'string' ? schema.ddl.trim() : '';
    if (!schema.tableName || (!hasColumns && !ddl)) continue;
    tables[schema.tableName] ??= new Set();
    tables[schema.tableName].add(
      entryPackage(key, manifest.objects[key], manifest.packageName),
    );
  }
  let missingReason: string | undefined;
  // Read the stamp. A manifest written before stamps existed gets the value
  // from the same function the generator uses.
  const fingerprint =
    manifest.schemaFingerprint ??
    tryComputeManifestSchemaFingerprint(manifest, (error) => {
      missingReason = error.message;
    });
  const byTable = Object.fromEntries(
    Object.entries(tables)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([table, owners]) => [table, [...owners].sort()]),
  );
  return {
    ...(fingerprint ? { fingerprint } : {}),
    ...(missingReason ? { missingReason } : {}),
    tables: byTable,
    packages: [...new Set(Object.values(byTable).flat())].sort(),
    source,
  };
}

/** `Symbol.for()` key of this process's build schema slot on `globalThis`. */
export const BUILD_SCHEMA_GLOBAL = '@happyvertical/smrt-core:build-schema';
const REGISTERED = Symbol.for(BUILD_SCHEMA_GLOBAL);
type Slot = { [REGISTERED]?: BuildSchema };

/**
 * The build registered in this process, if any (by `registerBuildSchema()` or
 * by the app's generated `.smrt/build-schema.js`). The startup check keeps it
 * with each cached result and checks again when it changed, so a query that
 * ran before the app's registration never fixes the answer for the process.
 */
export function registeredBuildSchema(): BuildSchema | undefined {
  return (globalThis as Slot)[REGISTERED];
}

/** File name of the app's generated build module, beside `.smrt/manifest.json`. */
export const BUILD_SCHEMA_MODULE = 'build-schema.js';

/**
 * Source of `.smrt/build-schema.js`: it stores
 * `describeManifestSchema(manifest)` of the project manifest written in the
 * same publish in the build schema slot. It imports nothing, so it runs under
 * plain Node, in any bundle, and before smrt-core loads. The app's generated
 * registration imports it first, so the build's stamp travels inside the
 * bundle (#4929). Never written for a library's published output.
 */
export function generateBuildSchemaModule(manifest: ManifestLike): string {
  const build = describeManifestSchema(manifest, 'bundled build');
  return [
    "// Generated by smrt with .smrt/manifest.json. This app build's schema: migrate",
    '// records it and startup compares it (#4929). Do not edit.',
    // Typed for consumer projects that check JavaScript (checkJs + strict):
    // a JSDoc cast, since typeof globalThis has no symbol index.
    '/** @type {Record<symbol, unknown>} */ (/** @type {unknown} */ (globalThis))[',
    `  Symbol.for(${JSON.stringify(BUILD_SCHEMA_GLOBAL)})`,
    `] = JSON.parse(${JSON.stringify(JSON.stringify(build))});`,
    '',
  ].join('\n');
}

/**
 * Register the build's schema for this process: the project manifest object
 * (for a bundle that ships no files, import the same `.smrt/manifest.json`)
 * or a described {@link BuildSchema}. `undefined` clears it. The CLI
 * registers the project manifest it discovered.
 */
export function registerBuildSchema(
  build: ManifestLike | BuildSchema | undefined,
): void {
  const slot = globalThis as Slot;
  if (!build) {
    delete slot[REGISTERED];
    return;
  }
  slot[REGISTERED] =
    'objects' in build ? describeManifestSchema(build, 'registered') : build;
}

/** Read a project manifest file. Undefined when absent, unreadable or a test artifact. */
export function readBuildSchemaFile(path: string): BuildSchema | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const manifest = JSON.parse(readFileSync(path, 'utf-8')) as ManifestLike;
    if (
      !manifest?.objects ||
      typeof manifest.objects !== 'object' ||
      isRefusedTestArtifact(manifest, path)
    )
      return undefined;
    return describeManifestSchema(manifest, path);
  } catch {
    return undefined;
  }
}

/**
 * When `build` was read from one project manifest and another candidate under
 * `projectRoot` describes a different schema, say so and name which was used
 * and why. Never silent: two manifests that disagree are two different builds.
 */
export function noteAlternativeManifests(
  build: BuildSchema,
  projectRoot: string,
): BuildSchema {
  const used = build.source.replaceAll('\\', '/');
  const isUsed = (candidate: string) =>
    used === candidate || used.endsWith(`/${candidate}`);
  const different: string[] = [];
  for (const candidate of PROJECT_MANIFEST_PATHS) {
    if (isUsed(candidate)) continue;
    const other = readBuildSchemaFile(join(projectRoot, candidate));
    if (!other) continue;
    const sameTables =
      JSON.stringify(build.tables) === JSON.stringify(other.tables);
    const sameStamp =
      !build.fingerprint ||
      !other.fingerprint ||
      build.fingerprint === other.fingerprint;
    if (!sameTables || !sameStamp)
      different.push(
        `${candidate} (${Object.keys(other.tables).length} table(s), ${other.packages.length} package(s), stamp ${other.fingerprint?.slice(0, 12) ?? 'none'})`,
      );
  }
  if (!different.length) return build;
  const isApp = isUsed('.smrt/manifest.json');
  return {
    ...build,
    notice: `Two project manifests describe different schemas. Using ${build.source} (${Object.keys(build.tables).length} table(s), ${build.packages.length} package(s), stamp ${build.fingerprint?.slice(0, 12) ?? 'none'}) as the build${isApp ? ": the app's bundled description is written from it" : ': it is the first project manifest present'}. Not used: ${different.join('; ')}. A manifest published for a library is not the app's build.`,
  };
}

/** The first project manifest under `projectRoot`, in the CLI's order. */
export function readProjectBuildSchema(
  projectRoot: string,
): BuildSchema | undefined {
  for (const candidate of PROJECT_MANIFEST_PATHS) {
    const build = readBuildSchemaFile(join(projectRoot, candidate));
    if (build) return noteAlternativeManifests(build, projectRoot);
  }
  return undefined;
}

/**
 * This process's build schema: a registered one, else the file named by
 * `SMRT_BUILD_MANIFEST`, else the project manifest under the working
 * directory. Under `NODE_ENV=test` only the first two count, so a package's
 * test run never takes the package's own manifest for an app build.
 */
export function resolveBuildSchema(): BuildSchema | undefined {
  const registered = (globalThis as Slot)[REGISTERED];
  if (registered) return registered;
  if (typeof process === 'undefined' || !process.env) return undefined;
  const named = process.env[BUILD_MANIFEST_ENV];
  if (named) return readBuildSchemaFile(named);
  if (process.env.NODE_ENV === 'test') return undefined;
  return readProjectBuildSchema(process.cwd());
}
