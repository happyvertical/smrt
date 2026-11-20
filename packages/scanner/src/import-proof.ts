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
 *   name exactly one file on disk (of every candidate TypeScript may try), a
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
 * imports map or a bundler config: each is an error naming its fix.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
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

function isRelative(specifier: string): boolean {
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

/** JSON with comments and trailing commas, as TypeScript reads tsconfig. */
function parseConfigText(source: string): Record<string, unknown> | null {
  // A UTF-8 byte order mark is valid at the start of a tsconfig.
  const text = source.startsWith('﻿') ? source.slice(1) : source;
  let out = '';
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        index++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index++;
      out += '\n';
    } else if (char === '/' && next === '*') {
      index += 2;
      while (
        index < text.length &&
        !(text[index] === '*' && text[index + 1] === '/')
      )
        index++;
      index++;
    } else {
      out += char;
    }
  }
  try {
    const parsed = JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Proves references for one scan run. Everything read from disk
 * (`package.json`, `tsconfig.json`, installed packages) is cached for the
 * run only, so a second scan sees edits made between the two.
 */
export class ImportProver {
  private readonly packages = new Map<string, PackageInfo | null>();
  private readonly suffixes = new Map<string, string[] | { reason: string }>();
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
        for (const key of [
          'dependencies',
          'peerDependencies',
          'optionalDependencies',
          'devDependencies',
        ]) {
          const map = json[key];
          if (map && typeof map === 'object') {
            for (const name of Object.keys(map)) names.add(name);
          }
        }
        info = {
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
   * may try (extensions, directory `index`, the project's `moduleSuffixes`,
   * a trailing slash meaning the directory) must leave exactly one file on
   * disk, or the import is an error. That file must be one the scan reads;
   * a file outside the scan is an error, never a reason to take another.
   */
  selectFile(
    fromFile: string,
    specifier: string,
  ): { file: string } | { reason: string } {
    const base = resolvePath(dirname(fromFile), specifier);
    const suffixes = this.moduleSuffixes(fromFile);
    if ('reason' in suffixes) return suffixes;
    const candidates: string[] = [];
    // TypeScript tries each extension in turn and, within one extension,
    // each module suffix (`Base.ios.ts`, `Base.ts`, `Base.ios.tsx`, ...).
    const add = (stem: string, extensions: readonly string[]) => {
      for (const extension of extensions) {
        for (const suffix of suffixes) {
          candidates.push(`${stem}${suffix}${extension}`);
        }
      }
    };
    const written = /(\.d)?\.([mc]?)([tj])s(x?)$/.exec(base);
    // A trailing slash (`./Base/`) asks for the directory only.
    const directoryOnly = /[\\/]$/.test(specifier);
    if (directoryOnly) {
      if (isFile(join(base, 'package.json'))) {
        return {
          reason: `'${specifier}' names a directory with its own package.json; import the file that declares the class`,
        };
      }
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
      if (isFile(join(base, 'package.json'))) {
        return {
          reason: `'${specifier}' names a directory with its own package.json; import the file that declares the class`,
        };
      }
      add(join(base, 'index'), ['.ts', '.tsx', '.d.ts']);
      add(base, ['.js', '.jsx']);
      add(join(base, 'index'), ['.js', '.jsx']);
    }
    // Which candidate TypeScript takes depends on the resolution mode
    // (`bundler` checks `Base.js` before `Base/index.ts`, a trailing slash
    // skips files, ...). Rather than mirror every mode, a specifier is
    // accepted only when exactly one candidate exists on disk.
    const existing = [...new Set(candidates.filter(isFile))];
    if (existing.length > 1) {
      return {
        reason: `'${specifier}' could name more than one file (${existing.join(', ')}), and which one is loaded depends on the module resolution mode; make the import name exactly one file (write its extension, or the directory's index file, and rename the other files if they still match)`,
      };
    }
    const selected = existing[0];
    if (!selected) return { reason: `'${specifier}' names no file` };
    if (/\.d\.[mc]?ts$/.test(selected) || /\.[mc]?jsx?$/.test(selected)) {
      return {
        reason: `'${specifier}' selects ${selected}, which is not TypeScript source the scan reads; import the source file that declares the class`,
      };
    }
    return { file: resolvePath(selected) };
  }

  /**
   * `compilerOptions.moduleSuffixes` of the nearest `tsconfig.json` above
   * `file` (following `extends`), `['']` when none sets it, or why the
   * configuration could not be read: a suffix list the scan cannot read is
   * never taken as absent, since it decides which file an import names.
   */
  private moduleSuffixes(file: string): string[] | { reason: string } {
    let dir = dirname(file);
    for (;;) {
      const cached = this.suffixes.get(dir);
      if (cached) return cached;
      const config = join(dir, 'tsconfig.json');
      if (isFile(config)) {
        const found = readModuleSuffixes(config, 0);
        const suffixes =
          found && 'reason' in found
            ? found
            : found && found.length > 0
              ? found
              : [''];
        this.suffixes.set(dirname(file), suffixes);
        return suffixes;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        this.suffixes.set(dirname(file), ['']);
        return [''];
      }
      dir = parent;
    }
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

const MAX_EXTENDS_DEPTH = 8;

/**
 * `moduleSuffixes` set by `file` or the configs it extends; `null` when none
 * sets it; `{ reason }` when a config cannot be read (malformed JSON, an
 * `extends` chain deeper than the limit, a suffix list that is not strings).
 */
function readModuleSuffixes(
  file: string,
  depth: number,
): string[] | null | { reason: string } {
  if (depth > MAX_EXTENDS_DEPTH) {
    return {
      reason: `${file} is reached through more than ${MAX_EXTENDS_DEPTH} levels of tsconfig \`extends\`, so the scan cannot read its \`moduleSuffixes\`; shorten the chain`,
    };
  }
  if (!isFile(file)) return null;
  const config = parseConfigText(readFileSync(file, 'utf8'));
  if (!config) {
    return {
      reason: `${file} could not be parsed, so the scan cannot read its \`moduleSuffixes\` (which decide the file an import names); fix the JSON`,
    };
  }
  const options = (config.compilerOptions ?? {}) as Record<string, unknown>;
  if (options.moduleSuffixes !== undefined) {
    const suffixes = options.moduleSuffixes;
    if (
      !Array.isArray(suffixes) ||
      suffixes.some((suffix) => typeof suffix !== 'string')
    ) {
      return {
        reason: `\`compilerOptions.moduleSuffixes\` in ${file} is not a list of strings; fix it`,
      };
    }
    return suffixes as string[];
  }
  const parents = Array.isArray(config.extends)
    ? config.extends
    : config.extends
      ? [config.extends]
      : [];
  // A later entry of an `extends` array overrides an earlier one.
  for (const parent of [...parents].reverse()) {
    if (typeof parent !== 'string') continue;
    const target = resolveExtends(file, parent);
    const inherited = target ? readModuleSuffixes(target, depth + 1) : null;
    if (inherited) return inherited;
  }
  return null;
}

function resolveExtends(from: string, parent: string): string | undefined {
  if (isRelative(parent)) {
    const target = resolvePath(dirname(from), parent);
    return isFile(target) ? target : `${target}.json`;
  }
  const require = createRequire(from);
  for (const candidate of [
    parent,
    `${parent}.json`,
    `${parent}/tsconfig.json`,
  ]) {
    try {
      return require.resolve(candidate);
    } catch {
      // try the next form
    }
  }
  return undefined;
}
