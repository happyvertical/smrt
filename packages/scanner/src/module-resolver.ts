/**
 * Resolves an imported binding to the one declaration it names, the way the
 * module system binds it. Parents (`extends`), relationship targets and
 * `@report` sources all go through it, so no name is ever matched by its
 * spelling alone.
 *
 * A specifier names one module:
 * - a relative path: a scanned file (with TypeScript's extension and `index`
 *   rules);
 * - a project path alias declared in `tsconfig.json` `paths`: the scanned
 *   file it maps to. An alias wins over an installed package of the same
 *   name, as it does for TypeScript;
 * - anything else: a package, identified by its name. The scan does not read
 *   a package's source; its export is confirmed at generation against the
 *   package's manifest.
 *
 * Within a scanned module, an exported name is followed through
 * `export { A as B }`, `export { A }` of an import, `export { A } from`,
 * `export *` and default exports, to the class that declares it.
 *
 * Anything that does not resolve to exactly one declaration (a module
 * outside the scan, an export that is not a class, a package's default
 * export, two `export *` sources with the name) is unresolved, with the
 * reason; callers report it as a scan error and never fall back to a
 * same-named class.
 */

import { dirname, resolve as resolvePath } from 'node:path';
import { pathAliasCandidates } from './tsconfig-paths.js';
import type {
  RawClassDefinition,
  RawImportBinding,
  RawModuleExports,
} from './types.js';

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx'];
const MAX_DEPTH = 16;

/** The package that exports the framework base classes. */
export const FRAMEWORK_PACKAGE = '@happyvertical/smrt-core';

/**
 * Framework base classes another framework package declares: a binding is
 * that base only when it is this package's export (or the core package's).
 */
const FRAMEWORK_BASE_PACKAGES: Readonly<Record<string, string>> = {
  SmrtReport: '@happyvertical/smrt-reports',
  SmrtReportCollection: '@happyvertical/smrt-reports',
};

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

/** One scanned module, as the resolver needs it. */
export interface ResolverModule {
  /** Top-level classes the file declares, by name. */
  classes: Map<string, RawClassDefinition>;
  imports: Record<string, RawImportBinding>;
  exports?: RawModuleExports;
}

/** What an imported binding is. */
export type ResolvedBinding =
  | { kind: 'class'; definition: RawClassDefinition }
  | { kind: 'package'; packageName: string; exportName: string }
  | { kind: 'unresolved'; reason: string };

/**
 * The package a bare specifier names: `@scope/pkg` for a scoped one, the
 * first segment otherwise; `undefined` for a relative, absolute or protocol
 * specifier.
 */
export function packageOfSpecifier(specifier: string): string | undefined {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    /^[a-z]+:/i.test(specifier)
  ) {
    return undefined;
  }
  const parts = specifier.split('/');
  const name = specifier.startsWith('@')
    ? parts.length >= 2
      ? `${parts[0]}/${parts[1]}`
      : undefined
    : parts[0];
  // Only a valid npm package name (`$lib`, `@/lib` and `~/x` are aliases).
  return name && NPM_NAME.test(name) ? name : undefined;
}

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

export class ModuleResolver {
  constructor(
    private readonly modules: Map<string, ResolverModule>,
    private readonly projectRoot: string | undefined,
  ) {}

  /** Whether `file` is a module the scan read (and so resolves strictly). */
  has(file: string): boolean {
    return this.modules.has(file);
  }

  /**
   * The binding `imported` (an export name, or `'default'`) of the module
   * `specifier` names, imported from `fromFile`.
   */
  resolveImport(
    fromFile: string,
    specifier: string,
    imported: string,
    depth = 0,
  ): ResolvedBinding {
    const target = this.resolveSpecifier(fromFile, specifier);
    if ('reason' in target)
      return { kind: 'unresolved', reason: target.reason };
    if ('packageName' in target) {
      if (imported === 'default') {
        return {
          kind: 'unresolved',
          reason: `it is the default export of ${target.packageName}, and a package manifest does not record which class that is; import it by its class name`,
        };
      }
      return {
        kind: 'package',
        packageName: target.packageName,
        exportName: imported,
      };
    }
    return this.resolveExport(target.file, imported, depth + 1, new Set());
  }

  /**
   * The class a name declared or imported in `file` binds: a class declared
   * there, or the import it refers to.
   */
  resolveLocal(file: string, name: string, depth = 0): ResolvedBinding {
    const module = this.modules.get(file);
    if (!module) {
      return { kind: 'unresolved', reason: `${file} is not part of the scan` };
    }
    const declared = module.classes.get(name);
    if (declared) return { kind: 'class', definition: declared };
    const binding = module.imports[name];
    if (binding) {
      if (binding.imported === null) {
        return {
          kind: 'unresolved',
          reason: `\`${name}\` is a namespace object, not a class`,
        };
      }
      return this.resolveImport(file, binding.source, binding.imported, depth);
    }
    return {
      kind: 'unresolved',
      reason: `\`${name}\` is neither a class declared in ${file} nor an import`,
    };
  }

  /** The class module `file` exports as `name`, followed through re-exports. */
  resolveExport(
    file: string,
    name: string,
    depth: number,
    seen: Set<string>,
  ): ResolvedBinding {
    if (depth > MAX_DEPTH) {
      return { kind: 'unresolved', reason: 'the re-export chain is too deep' };
    }
    const key = `${file}\u0000${name}`;
    if (seen.has(key)) {
      return { kind: 'unresolved', reason: 'the re-export chain is circular' };
    }
    seen.add(key);
    const module = this.modules.get(file);
    if (!module) {
      return { kind: 'unresolved', reason: `${file} is not part of the scan` };
    }
    const exported = module.exports?.named[name];
    if (exported) {
      if ('local' in exported) {
        if (!exported.local) {
          return {
            kind: 'unresolved',
            reason: `the ${name} export of ${file} is not a class`,
          };
        }
        return this.resolveLocal(file, exported.local, depth + 1);
      }
      if (exported.imported === null) {
        return {
          kind: 'unresolved',
          reason: `\`${name}\` of ${file} is a namespace object, not a class`,
        };
      }
      return this.resolveImport(file, exported.from, exported.imported, depth);
    }
    if (name !== 'default') {
      const found: ResolvedBinding[] = [];
      for (const source of module.exports?.star ?? []) {
        const result = this.resolveImport(file, source, name, depth);
        // A star export that does not provide the name is not an error.
        if (result.kind !== 'unresolved' || !isMissingExport(result)) {
          found.push(result);
        }
      }
      if (found.length === 1) return found[0];
      if (found.length > 1) {
        return {
          kind: 'unresolved',
          reason: `${file} re-exports \`${name}\` from more than one module`,
        };
      }
    }
    return missingExport(file, name);
  }

  /** The scanned module, or the package, a specifier from `fromFile` names. */
  private resolveSpecifier(
    fromFile: string,
    specifier: string,
  ): { file: string } | { packageName: string } | { reason: string } {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const file = this.findModule(resolvePath(dirname(fromFile), specifier));
      return file
        ? { file }
        : { reason: `'${specifier}' names no file the scan read` };
    }
    if (this.projectRoot) {
      const candidates = pathAliasCandidates(this.projectRoot, specifier);
      if (candidates) {
        for (const candidate of candidates) {
          const file = this.findModule(candidate);
          if (file) return { file };
        }
        return {
          reason: `'${specifier}' is a tsconfig path alias that leads to no file the scan read`,
        };
      }
    }
    const packageName = packageOfSpecifier(specifier);
    return packageName
      ? { packageName }
      : {
          reason: `'${specifier}' names no package, and no tsconfig \`paths\` entry maps it (an alias declared only in a bundler config is not read)`,
        };
  }

  private findModule(base: string): string | undefined {
    const stems = new Set([base, base.replace(/\.(?:[cm]?js|jsx)$/, '')]);
    const candidates = [base];
    for (const stem of stems) {
      for (const extension of SOURCE_EXTENSIONS) {
        candidates.push(`${stem}${extension}`);
      }
      for (const extension of SOURCE_EXTENSIONS) {
        candidates.push(resolvePath(stem, `index${extension}`));
      }
    }
    return candidates.find((candidate) => this.modules.has(candidate));
  }
}

const MISSING = 'exports no binding named';

function missingExport(file: string, name: string): ResolvedBinding {
  return { kind: 'unresolved', reason: `${file} ${MISSING} \`${name}\`` };
}

function isMissingExport(result: ResolvedBinding): boolean {
  return result.kind === 'unresolved' && result.reason.includes(MISSING);
}
