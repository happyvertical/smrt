/**
 * Import proof: which class a reference in a scanned file names, proven from
 * that file, the one file its relative import selects, and the nearest
 * `package.json`, or a scan error that says how to write it instead.
 *
 * Parents (`extends`), relationship targets, `@report` sources and a
 * collection's item go through it. Only these forms are accepted:
 *
 * - **same file**: a class declared in the importing file;
 * - **relative**: a named or default import whose relative specifier can
 *   name exactly one file on disk (of every candidate TypeScript may try,
 *   with no platform module-suffix variant such as `Base.ios.ts` beside
 *   it, in a project whose tsconfig does not mention `moduleSuffixes`), a
 *   scanned file that declares the class itself and exports it under its
 *   own name;
 * - **framework**: a framework base exported by the framework package
 *   (`@happyvertical/smrt-core`, or `@happyvertical/smrt-reports` for the
 *   report bases);
 * - **package**: a named import or namespace member from `@scope/pkg` or
 *   `@scope/pkg/subpath`, where `@scope/pkg` is declared in the nearest
 *   `package.json` above the importing file and is not that package itself.
 *   Generation confirms it against the package's manifest, including that the
 *   full specifier is the entry the package declares the class at.
 *
 * Nothing is resolved through an alias, a barrel, a re-export, `baseUrl`, an
 * imports map or a bundler config: each is an error naming its fix. No
 * tsconfig is read, so no compiler option changes which file is accepted.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  basename,
  dirname,
  join,
  resolve as resolvePath,
  sep,
} from 'node:path';
import type {
  RawClassDefinition,
  RawImportBinding,
  RawModuleExports,
} from './types.js';

/** The package that exports the framework base classes. */
export const FRAMEWORK_PACKAGE = '@happyvertical/smrt-core';

/** Framework bases another framework package declares. */
const FRAMEWORK_BASE_PACKAGES: Readonly<Record<string, string>> = {
  SmrtReport: '@happyvertical/smrt-reports',
  SmrtReportCollection: '@happyvertical/smrt-reports',
};

/** The framework package that declares the base `name`. */
export function frameworkPackageOf(name: string): string {
  return FRAMEWORK_BASE_PACKAGES[name] ?? FRAMEWORK_PACKAGE;
}

/** Whether `exportName` of `packageName` is a framework base class. */
export function isFrameworkExport(
  packageName: string,
  exportName: string,
  frameworkBases: ReadonlySet<string>,
): boolean {
  if (!frameworkBases.has(exportName)) return false;
  return (
    packageName === FRAMEWORK_PACKAGE ||
    FRAMEWORK_BASE_PACKAGES[exportName] === packageName
  );
}

/** One scanned module, as the proof needs it. */
export interface ProofModule {
  /** Top-level classes the file declares, by name. */
  classes: Map<string, RawClassDefinition>;
  imports: Record<string, RawImportBinding>;
  /** Type-only import bindings, read only for a collection's type argument. */
  typeImports?: Record<string, RawImportBinding>;
  exports?: RawModuleExports;
}

/** The nearest `package.json` above a file. */
export interface PackageInfo {
  dir: string;
  name?: string;
  /** Names in `dependencies`, `peerDependencies`, `optionalDependencies`, `devDependencies`. */
  dependencies: ReadonlySet<string>;
}

/** What a reference is, or why the scan cannot accept it. */
export type Proof =
  | { kind: 'class'; definition: RawClassDefinition }
  | { kind: 'framework'; name: string }
  | {
      kind: 'package';
      packageName: string;
      exportName: string;
      specifier: string;
    }
  | { kind: 'error'; reason: string };

const FIX_RELATIVE =
  'import it by relative path from the file that declares it, or, for another package’s class, by that package’s name declared in package.json';

/** `@scope/pkg` of `@scope/pkg` or `@scope/pkg/sub`, else `undefined`. */
export function scopedPackageOf(specifier: string): string | undefined {
  return /^(@[a-z0-9][\w.~-]*\/[a-z0-9][\w.~-]*)(?:\/.*)?$/i.exec(
    specifier,
  )?.[1];
}

/** Whether `specifier` is a relative or absolute path, not a package name. */
export function isRelative(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/')
  );
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Platform words that a module-suffix setting (a tsconfig `moduleSuffixes`,
 * or a React Native / Electron / web bundler's platform extensions) appends
 * to a module name. A file beside `Base.ts` is a variant of `./Base` only
 * when everything between `Base.` and its extension is made of these words
 * (`Base.ios.ts`, `Base.native.ios.tsx`, `Base.web.d.ts`). Any other dotted
 * name (`Base.types.ts`, `Base.schema.ts`, `Base.svelte.ts`, `Base.test.ts`,
 * `Base.mock.ts`) is an ordinary companion file. A project that configures
 * other suffixes is refused as a whole (see {@link moduleSuffixesConfigs}).
 */
export const MODULE_SUFFIX_WORDS: ReadonlySet<string> = new Set([
  'ios',
  'android',
  'native',
  'web',
  'windows',
  'macos',
  'electron',
  'node',
  'browser',
]);

/** What follows `Base.` in a variant: dotted words, then a TS/JS extension. */
const VARIANT_REST =
  /^([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*?)\.(?:d\.)?[mc]?[jt]sx?$/;

/** Whether `suffix` (`ios`, `native.ios`) is made only of platform words. */
function isModuleSuffix(suffix: string): boolean {
  return suffix
    .split('.')
    .every((word) => MODULE_SUFFIX_WORDS.has(word.toLowerCase()));
}

/**
 * The `tsconfig*.json` files directly in `projectRoot` whose text mentions
 * `moduleSuffixes`. The scan does not read tsconfig structure; a project
 * that may configure module suffixes is refused, so a suffix the scan does
 * not know (`.mock`, a compound one) can never select another file than
 * the one the scan accepts. Unreadable directories and files mention
 * nothing.
 */
export function moduleSuffixesConfigs(projectRoot: string): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(projectRoot).sort();
  } catch {
    return [];
  }
  return entries
    .filter((entry) => /^tsconfig.*\.json$/i.test(entry))
    .map((entry) => join(projectRoot, entry))
    .filter((file) => {
      if (!isFile(file)) return false;
      try {
        return readFileSync(file, 'utf8').includes('moduleSuffixes');
      } catch {
        return false;
      }
    });
}

/**
 * Fields of a directory's package.json that choose the file a directory
 * import loads, for TypeScript or a bundler.
 */
const DIRECTORY_ENTRY_FIELDS = [
  'main',
  'module',
  'exports',
  'types',
  'typings',
  'browser',
] as const;

/**
 * Whether the package.json at `manifest` exists and declares the entry its
 * directory loads (or cannot be read, so it might).
 */
function declaresDirectoryEntry(manifest: string): boolean {
  if (!isFile(manifest)) return false;
  try {
    const json = JSON.parse(readFileSync(manifest, 'utf8')) as unknown;
    if (!json || typeof json !== 'object' || Array.isArray(json)) return true;
    return DIRECTORY_ENTRY_FIELDS.some((field) => Object.hasOwn(json, field));
  } catch {
    return true;
  }
}

/**
 * Keys of a package.json that only marks the module format of the files
 * below it (`dist/esm/package.json` with `{ "type": "module" }`). Such a file
 * declares no package; any other key (a name, dependencies, scripts,
 * `private`) makes it the package that decides.
 */
const MODULE_FORMAT_KEYS: ReadonlySet<string> = new Set([
  'type',
  'sideEffects',
  'browser',
  'main',
  'module',
]);

/**
 * Proves references for one scan run. Everything read from disk
 * (`package.json`, directory listings, installed packages) is cached for the
 * run only, so a second scan sees edits made between the two. No tsconfig is
 * read: the file a relative import names is decided by the files on disk.
 */
export class ImportProver {
  private readonly packages = new Map<string, PackageInfo | null>();
  private readonly directories = new Map<string, readonly string[]>();
  private readonly installed = new Map<string, string | null>();

  constructor(
    private readonly modules: ReadonlyMap<string, ProofModule>,
    /** Directory generation resolves dependency manifests from. */
    private readonly projectRoot: string | undefined,
    /** Names of the framework base classes. */
    private readonly frameworkBases: ReadonlySet<string>,
  ) {}

  /** The nearest `package.json` above `file`, or `null`. */
  packageOf(file: string): PackageInfo | null {
    return this.packageAt(dirname(file));
  }

  private packageAt(dir: string): PackageInfo | null {
    const cached = this.packages.get(dir);
    if (cached !== undefined) return cached;
    let info: PackageInfo | null = null;
    const manifest = join(dir, 'package.json');
    if (isFile(manifest)) {
      try {
        const json = JSON.parse(readFileSync(manifest, 'utf8')) as Record<
          string,
          unknown
        >;
        const names = new Set<string>();
        let declaresDependencies = false;
        for (const key of [
          'dependencies',
          'peerDependencies',
          'optionalDependencies',
          'devDependencies',
        ]) {
          const map = json[key];
          if (map && typeof map === 'object') {
            declaresDependencies = true;
            for (const name of Object.keys(map)) names.add(name);
          }
        }
        // A package.json that only marks the module format (a nested
        // `{ "type": "module" }`, as in `dist/esm/`) does not declare a
        // package; the one above it does. Any other key (a name, a
        // dependency map, `private`, scripts) makes this file decide, so an
        // unnamed private project never inherits its parent's dependencies.
        const keys = Object.keys(json);
        const formatMarker =
          keys.includes('type') &&
          keys.every((key) => MODULE_FORMAT_KEYS.has(key));
        info =
          formatMarker && !declaresDependencies
            ? (() => {
                const parent = dirname(dir);
                return parent === dir ? null : this.packageAt(parent);
              })()
            : {
                dir,
                name: typeof json.name === 'string' ? json.name : undefined,
                dependencies: names,
              };
      } catch {
        info = { dir, dependencies: new Set() };
      }
    } else {
      const parent = dirname(dir);
      info = parent === dir ? null : this.packageAt(parent);
    }
    this.packages.set(dir, info);
    return info;
  }

  /**
   * The class binding `imported` (an export name, or `'default'`) of the
   * module `specifier` names, imported from `fromFile`.
   */
  proveImport(fromFile: string, specifier: string, imported: string): Proof {
    if (isRelative(specifier)) {
      // Inside the framework package, a framework base name is the
      // framework's own class, however its sources import it.
      if (
        this.frameworkBases.has(imported) &&
        this.packageOf(fromFile)?.name === frameworkPackageOf(imported)
      ) {
        return { kind: 'framework', name: imported };
      }
      const selected = this.selectFile(fromFile, specifier);
      if ('reason' in selected)
        return { kind: 'error', reason: selected.reason };
      return this.declaredExport(selected.file, specifier, imported);
    }
    const packageName = scopedPackageOf(specifier);
    if (!packageName) {
      return {
        kind: 'error',
        reason: `'${specifier}' is neither a relative path nor a scoped package (a tsconfig \`paths\` alias, a \`baseUrl\` import, an imports map entry or a bundler alias is not read); ${FIX_RELATIVE}`,
      };
    }
    if (imported === 'default') {
      return {
        kind: 'error',
        reason: `it is the default export of ${specifier}, and a package manifest does not record which class that is; import it by its class name`,
      };
    }
    // The framework package's own export of a base: its name is the proof.
    if (isFrameworkExport(packageName, imported, this.frameworkBases)) {
      return { kind: 'framework', name: imported };
    }
    const info = this.packageOf(fromFile);
    if (info?.name === packageName) {
      return {
        kind: 'error',
        reason: `'${specifier}' is this package’s own name; import your own classes by relative path from the file that declares them`,
      };
    }
    if (!info || !info.dependencies.has(packageName)) {
      return {
        kind: 'error',
        reason: `${packageName} is not declared in ${info ? join(info.dir, 'package.json') : 'any package.json above the file'}; declare the package that exports it as a dependency (SMRT packages are scoped), or import a class of this package by relative path`,
      };
    }
    const copies = this.installedCopies(fromFile, packageName);
    if (copies) {
      return {
        kind: 'error',
        reason: `two copies of ${packageName} are installed: ${copies[0]} (the one this file loads) and ${copies[1]} (the one the build reads the manifest of); install one copy so the class and its manifest come from the same package`,
      };
    }
    return { kind: 'package', packageName, exportName: imported, specifier };
  }

  /**
   * A name used in `file` without an import: a class declared there. A
   * global of a framework base's name is not the framework base; only its
   * import from the framework package proves that.
   */
  proveLocal(file: string, name: string, frameworkName: boolean): Proof {
    const declared = this.modules.get(file)?.classes.get(name);
    if (declared) return { kind: 'class', definition: declared };
    return {
      kind: 'error',
      reason: `\`${name}\` is neither declared in this file nor imported; ${
        frameworkName
          ? `import { ${name} } from '${frameworkPackageOf(name)}'`
          : 'import it from the file or package that declares it'
      }`,
    };
  }

  /**
   * The class `file` declares and exports as `imported` (its own name, or
   * `default`): never a re-export, an import passed on, or a renamed export.
   */
  private declaredExport(
    file: string,
    specifier: string,
    imported: string,
  ): Proof {
    const module = this.modules.get(file);
    if (!module) {
      return {
        kind: 'error',
        reason: `'${specifier}' selects ${file}, which the scan does not read; add the file to the scan include, or move the class`,
      };
    }
    const fix = `import it from the file that declares it`;
    const entry = module.exports?.named[imported];
    if (!entry) {
      return {
        kind: 'error',
        reason:
          imported !== 'default' && (module.exports?.star.length ?? 0) > 0
            ? `${file} does not declare \`${imported}\` (it re-exports other modules with \`export *\`); ${fix}`
            : `${file} exports no binding named \`${imported}\``,
      };
    }
    if ('from' in entry) {
      return {
        kind: 'error',
        reason: `${file} re-exports \`${imported}\` from '${entry.from}' rather than declaring it; ${fix}`,
      };
    }
    if (imported !== 'default' && entry.local !== imported) {
      return {
        kind: 'error',
        reason: `${file} exports \`${entry.local || 'a value'}\` under the name \`${imported}\`; export each class under its own name, and import that name`,
      };
    }
    const declared = entry.local ? module.classes.get(entry.local) : undefined;
    if (!declared) {
      return {
        kind: 'error',
        reason: module.imports[entry.local]
          ? `${file} passes on \`${entry.local}\`, imported from '${module.imports[entry.local].source}', rather than declaring it; ${fix}`
          : `the \`${imported}\` export of ${file} is not a class`,
      };
    }
    return { kind: 'class', definition: declared };
  }

  /**
   * The one file a relative specifier can name: every candidate TypeScript
   * may try (extensions, directory `index`, a trailing slash meaning the
   * directory) must leave exactly one file on disk, or the import is an
   * error. A platform module-suffix variant beside a candidate (`Base.ios.ts`
   * beside `Base.ts`, see {@link MODULE_SUFFIX_WORDS}) is an error too: the
   * scan reads no tsconfig, and a variant is a file a `moduleSuffixes`
   * setting or a bundler may load instead (a project whose tsconfig mentions
   * `moduleSuffixes` fails the scan as a whole). A
   * directory's package.json is a candidate only when it declares an entry
   * (see {@link DIRECTORY_ENTRY_FIELDS}). The file must be one the scan
   * reads; a file outside the scan is an error, never a reason to take
   * another.
   */
  selectFile(
    fromFile: string,
    specifier: string,
  ): { file: string } | { reason: string } {
    const { existing, variants } = this.candidatesOf(fromFile, specifier);
    if (variants.length > 0) {
      return {
        reason: `'${specifier}' could also name ${variants.join(', ')}: a platform module-suffix variant (\`.ios\`, \`.native\`, \`.web\`, ...) is loaded instead when a tsconfig \`moduleSuffixes\` or a bundler selects it, and the scan reads neither; import the variant by its full name (\`./${basename(variants[0]).replace(/\.(?:d\.)?[mc]?[jt]sx?$/, '')}\`), or rename the files so that no variant sits beside the file you import`,
      };
    }
    if (existing.length > 1) {
      return {
        reason: `'${specifier}' could name more than one file (${existing.join(', ')}), and which one is loaded depends on the module resolution mode; make the import name exactly one file (write its extension, or the directory's index file, and rename the other files if they still match)`,
      };
    }
    const selected = existing[0];
    if (!selected) return { reason: `'${specifier}' names no file` };
    if (basename(selected) === 'package.json') {
      return {
        reason: `'${specifier}' names a directory whose package.json declares the entry it loads (${selected}); import the file that declares the class (\`${specifier.replace(/[\\/]+$/, '')}/index\`, or the class's own file)`,
      };
    }
    if (/\.d\.[mc]?ts$/.test(selected) || /\.[mc]?jsx?$/.test(selected)) {
      return {
        reason: `'${specifier}' selects ${selected}, which is not TypeScript source the scan reads; import the source file that declares the class`,
      };
    }
    return { file: resolvePath(selected) };
  }

  /**
   * Every file a relative specifier could load in some resolution mode or
   * configuration: the existing candidates and the module-suffix variants
   * beside them. A directory package.json that declares an entry stands for
   * every scanned file below its directory, since its entry (`main`,
   * `exports`, ...) may select any of them. Used to judge whether a
   * reference the proof refused would have reached a class of the scan.
   */
  possibleFiles(fromFile: string, specifier: string): string[] {
    const { existing, variants } = this.candidatesOf(fromFile, specifier);
    const files = new Set<string>();
    for (const file of [...existing, ...variants]) {
      if (basename(file) !== 'package.json') {
        files.add(resolvePath(file));
        continue;
      }
      const directory = `${resolvePath(dirname(file))}${sep}`;
      for (const scanned of this.modules.keys()) {
        if (resolvePath(scanned).startsWith(directory)) {
          files.add(resolvePath(scanned));
        }
      }
    }
    return [...files];
  }

  /**
   * The candidates of a relative specifier that exist on disk (a directory
   * package.json that declares an entry included), and the module-suffix
   * variants beside the stems it tries.
   */
  private candidatesOf(
    fromFile: string,
    specifier: string,
  ): { existing: string[]; variants: string[] } {
    const base = resolvePath(dirname(fromFile), specifier);
    const candidates: string[] = [];
    const stems = new Set<string>();
    const add = (stem: string, extensions: readonly string[]) => {
      stems.add(stem);
      for (const extension of extensions)
        candidates.push(`${stem}${extension}`);
    };
    // A directory's package.json that declares an entry decides what the
    // directory loads, so it is one more candidate; one that only marks the
    // module format (`{ "type": "module" }`) chooses nothing.
    const directoryEntry = (directory: string) => {
      const manifest = join(directory, 'package.json');
      if (declaresDirectoryEntry(manifest)) candidates.push(manifest);
    };
    const written = /(\.d)?\.([mc]?)([tj])s(x?)$/.exec(base);
    // A trailing slash (`./Base/`) asks for the directory only.
    const directoryOnly = /[\\/]$/.test(specifier);
    if (directoryOnly) {
      directoryEntry(base);
      add(join(base, 'index'), ['.ts', '.tsx', '.d.ts', '.js', '.jsx']);
    } else if (written) {
      // An explicit extension: TypeScript strips it and tries the
      // extensions that may stand behind it, in this order.
      const stem = base.slice(0, -written[0].length);
      const [, , flavour, , jsx] = written;
      add(
        stem,
        flavour === 'm'
          ? ['.mts', '.d.mts', '.mjs']
          : flavour === 'c'
            ? ['.cts', '.d.cts', '.cjs']
            : jsx
              ? ['.tsx', '.ts', '.d.ts', '.jsx', '.js']
              : ['.ts', '.tsx', '.d.ts', '.js', '.jsx'],
      );
    } else {
      add(base, ['.ts', '.tsx', '.d.ts']);
      directoryEntry(base);
      add(join(base, 'index'), ['.ts', '.tsx', '.d.ts']);
      add(base, ['.js', '.jsx']);
      add(join(base, 'index'), ['.js', '.jsx']);
    }
    // Which candidate TypeScript takes depends on the resolution mode
    // (`bundler` checks `Base.js` before `Base/index.ts`, a trailing slash
    // skips files, ...) and on the project's `moduleSuffixes`. Rather than
    // mirror every mode and read every config, a specifier is accepted only
    // when exactly one candidate exists on disk and no variant sits beside
    // one.
    const existing = [...new Set(candidates.filter(isFile))];
    const variants = [...stems].flatMap((stem) => this.variantFiles(stem));
    return { existing, variants };
  }

  /**
   * Files beside `stem` whose name is `<stem name>.<suffix>.<extension>`,
   * where the suffix is made only of {@link MODULE_SUFFIX_WORDS} (one word
   * or several, `native.ios`): the files a platform module-suffix setting
   * or bundler may load for the stem instead.
   */
  private variantFiles(stem: string): string[] {
    const directory = dirname(stem);
    const prefix = `${basename(stem)}.`;
    return this.entriesOf(directory)
      .filter((entry) => {
        if (!entry.startsWith(prefix)) return false;
        const suffix = VARIANT_REST.exec(entry.slice(prefix.length))?.[1];
        return (
          suffix !== undefined &&
          isModuleSuffix(suffix) &&
          isFile(join(directory, entry))
        );
      })
      .map((entry) => join(directory, entry));
  }

  /** The names in `directory`, sorted; none when it cannot be listed. */
  private entriesOf(directory: string): readonly string[] {
    const cached = this.directories.get(directory);
    if (cached) return cached;
    let entries: string[] = [];
    try {
      entries = readdirSync(directory).sort();
    } catch {
      // A directory that does not exist has no variants.
    }
    this.directories.set(directory, entries);
    return entries;
  }

  /**
   * Two different installed copies of `packageName`, one resolved from the
   * importing file and one from the project root generation reads
   * manifests from; `undefined` when they are the same (or either is not
   * installed).
   */
  private installedCopies(
    fromFile: string,
    packageName: string,
  ): [string, string] | undefined {
    if (!this.projectRoot) return undefined;
    const fromImporter = this.installedFrom(dirname(fromFile), packageName);
    const fromRoot = this.installedFrom(this.projectRoot, packageName);
    return fromImporter && fromRoot && fromImporter !== fromRoot
      ? [fromImporter, fromRoot]
      : undefined;
  }

  private installedFrom(dir: string, packageName: string): string | null {
    const key = `${dir}\u0000${packageName}`;
    const cached = this.installed.get(key);
    if (cached !== undefined) return cached;
    let found: string | null = null;
    for (let current = dir; ; ) {
      const candidate = join(current, 'node_modules', packageName);
      if (existsSync(join(candidate, 'package.json'))) {
        try {
          found = realpathSync(candidate);
        } catch {
          found = candidate;
        }
        break;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    this.installed.set(key, found);
    return found;
  }
}
