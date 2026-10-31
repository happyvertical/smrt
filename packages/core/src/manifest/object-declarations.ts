/**
 * Manifest -> generated object-type declaration selection.
 *
 * Every emitter of the per-object `XData` row interfaces (the physical
 * `smrt-objects.d.ts` / `smrt-types.d.ts` prebuild files, the Vite ambient
 * `virtual-modules.d.ts`, the `@smrt/types` virtual module in server and client
 * mode, and the consumer fallback module) reads this selection, so they agree
 * on how many declarations exist and in which order.
 *
 * A declaration describes one CLASS, not one manifest listing. An aggregated
 * consumer manifest can list one class several times: when workspace libraries
 * are built, each library that consumes another package's model scans that
 * model's source under its own package name (#3110), so the class appears once
 * under its declaring package and again under every consumer package. Those
 * listings name the same declaring source file and class with the same fields,
 * so they collapse to a single declaration (#3296). Listings without an
 * absolute source path, or whose fields disagree, cannot be proven to be the
 * same class and keep one declaration each.
 *
 * Pure and dependency-free: the scanner, the Vite plugin, the consumer plugin
 * and the prebuild CLI all import it.
 */

import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';

/** One generated object-type declaration and the listings it describes. */
export interface ObjectDeclaration {
  /**
   * Interface name emitted for the class's row payload: `ProductData`, or a
   * package-qualified name when distinct classes share the simple name.
   */
  interfaceName: string;
  /**
   * The listing the declaration is rendered from: the first listing in
   * deterministic qualified-identity order. Every collapsed listing has the
   * same fields, so the choice never changes the declared type (only, at
   * most, the order its properties are written in).
   */
  obj: SmartObjectDefinition;
  /** Manifest key of {@link obj}. */
  manifestKey: string;
  /** Every manifest key that names this class, in qualified-identity order. */
  manifestKeys: string[];
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeSourcePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

function isAbsoluteSourcePath(filePath: string): boolean {
  return filePath.startsWith('/') || /^[A-Za-z]:\//.test(filePath);
}

/**
 * The value as it survives a manifest JSON round trip. An in-memory scanned
 * listing (Vite plugin) is merged with dependency listings read from
 * `dist/manifest.json`; `undefined`-valued keys exist only in the former, so
 * comparing raw objects would keep the same class apart.
 */
function wireShape(value: unknown): unknown {
  const json = JSON.stringify(value);
  return json === undefined ? null : JSON.parse(json);
}

/** JSON with object keys sorted at every depth, for structural comparison. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort(compareText)
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The identity of the class a manifest listing describes.
 *
 * Two listings are the same class only when they name the same class in the
 * same absolute declaring source file AND describe the same fields. A path is
 * only machine-local evidence (separately built packages can share a
 * `/app/src/...` layout), so the field shape the declaration is rendered from
 * must agree too: listings that collapse always render identical
 * declarations, and a stale or unrelated listing stays separate instead of
 * silently supplying (or losing) fields. A relative `filePath` is relative to
 * whichever root scanned it, so two equal relative paths from different
 * packages may be different files; such listings fall back to their qualified
 * name (or manifest key), which keeps them distinct.
 */
export function objectDeclarationIdentity(
  manifestKey: string,
  obj: SmartObjectDefinition,
): string {
  const filePath =
    typeof obj.filePath === 'string' ? normalizeSourcePath(obj.filePath) : '';
  if (filePath && isAbsoluteSourcePath(filePath)) {
    return `source\0${filePath}\0${obj.className}\0${canonicalJson(wireShape(obj.fields ?? {}))}`;
  }
  return `listing\0${obj.qualifiedName || manifestKey}`;
}

/**
 * Manifest entries in the deterministic qualified-identity order every
 * declaration emitter shares (#2749): qualified name (or manifest key), then
 * manifest key.
 */
function orderedEntries(
  manifest: SmartObjectManifest,
): Array<[string, SmartObjectDefinition]> {
  return Object.entries(manifest.objects ?? {}).sort(
    ([leftKey, left], [rightKey, right]) =>
      compareText(
        left.qualifiedName || leftKey,
        right.qualifiedName || rightKey,
      ) || compareText(leftKey, rightKey),
  );
}

function declarationPackage(
  manifestKey: string,
  obj: SmartObjectDefinition,
): string | undefined {
  if (obj.packageName) return obj.packageName;
  const qualifiedName = obj.qualifiedName || manifestKey;
  const separator = qualifiedName.lastIndexOf(':');
  return separator > 0 ? qualifiedName.slice(0, separator) : undefined;
}

/** `@ergot/market-core` -> `ErgotMarketCore`, a valid identifier prefix. */
function packageIdentifierPrefix(packageName: string | undefined): string {
  if (!packageName) return '';
  const prefix = packageName
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
  return /^[0-9]/.test(prefix) ? `_${prefix}` : prefix;
}

/**
 * Distinct classes that share one simple class name (#3115), with the
 * qualified interface name each was given.
 */
export interface ObjectDeclarationCollision {
  className: string;
  declarations: Array<{ interfaceName: string; objectRef: string }>;
}

/** The declaration selection plus a lookup from any listing to its name. */
export interface ObjectDeclarationIndex {
  declarations: ObjectDeclaration[];
  collisions: ObjectDeclarationCollision[];
  /**
   * The declared row interface for a listing in this manifest (by object
   * reference). A collection class resolves through the caller to its item
   * listing first; an object outside the manifest falls back to its simple
   * `${className}Data`.
   */
  interfaceNameFor(obj: SmartObjectDefinition): string;
}

/**
 * Select one declaration per class described by the manifest, in deterministic
 * qualified-identity order of each class's first listing, and name each one.
 *
 * Naming follows the qualified identity when simple names collide (#3115): a
 * class whose simple name is unique keeps `${className}Data`; distinct classes
 * sharing a simple name each get a package-qualified name
 * (`@ergot/market-core:LicenseSale` -> `ErgotMarketCoreLicenseSaleData`) and
 * none of them keeps the bare name, which would otherwise silently merge two
 * classes' fields through TypeScript declaration merging. Unique simple names
 * are reserved first, and a qualified name that is still taken gets a stable
 * numeric suffix, so every emitted name is unique and independent of manifest
 * insertion order.
 */
export function createObjectDeclarationIndex(
  manifest: SmartObjectManifest,
): ObjectDeclarationIndex {
  const byIdentity = new Map<string, ObjectDeclaration>();
  const byObject = new Map<SmartObjectDefinition, ObjectDeclaration>();
  for (const [manifestKey, obj] of orderedEntries(manifest)) {
    const identity = objectDeclarationIdentity(manifestKey, obj);
    const existing = byIdentity.get(identity);
    if (existing) {
      existing.manifestKeys.push(manifestKey);
      byObject.set(obj, existing);
      continue;
    }
    const declaration: ObjectDeclaration = {
      interfaceName: `${obj.className}Data`,
      obj,
      manifestKey,
      manifestKeys: [manifestKey],
    };
    byIdentity.set(identity, declaration);
    byObject.set(obj, declaration);
  }
  const declarations = [...byIdentity.values()];

  const byClassName = new Map<string, ObjectDeclaration[]>();
  for (const declaration of declarations) {
    const group = byClassName.get(declaration.obj.className) ?? [];
    group.push(declaration);
    byClassName.set(declaration.obj.className, group);
  }

  const used = new Set<string>();
  for (const [className, group] of byClassName) {
    if (group.length === 1) used.add(`${className}Data`);
  }
  const collisions: ObjectDeclarationCollision[] = [];
  for (const [className, group] of byClassName) {
    if (group.length === 1) continue;
    for (const declaration of group) {
      const stem = `${packageIdentifierPrefix(
        declarationPackage(declaration.manifestKey, declaration.obj),
      )}${className}`;
      let interfaceName = `${stem}Data`;
      for (let suffix = 2; used.has(interfaceName); suffix += 1) {
        interfaceName = `${stem}${suffix}Data`;
      }
      used.add(interfaceName);
      declaration.interfaceName = interfaceName;
    }
    collisions.push({
      className,
      declarations: group.map((declaration) => ({
        interfaceName: declaration.interfaceName,
        objectRef: declaration.obj.qualifiedName || declaration.manifestKey,
      })),
    });
  }

  return {
    declarations,
    collisions,
    interfaceNameFor: (obj) =>
      byObject.get(obj)?.interfaceName ?? `${obj.className}Data`,
  };
}

/**
 * Select one declaration per class described by the manifest; see
 * {@link createObjectDeclarationIndex} for identity and naming.
 */
export function selectObjectDeclarations(
  manifest: SmartObjectManifest,
): ObjectDeclaration[] {
  return createObjectDeclarationIndex(manifest).declarations;
}

/**
 * Report simple-name collisions once per generation, naming the qualified
 * interface each class was given, so a consumer that referenced the bare
 * name learns which one to use (#3115).
 */
export function warnObjectDeclarationCollisions(
  index: ObjectDeclarationIndex,
  log: (message: string) => void,
): void {
  for (const { className, declarations } of index.collisions) {
    log(
      `[smrt:types] ${declarations.length} distinct classes are named ${JSON.stringify(className)}; ` +
        `generated row types use qualified names instead of ${className}Data: ` +
        declarations
          .map(
            ({ interfaceName, objectRef }) => `${interfaceName} (${objectRef})`,
          )
          .join(', '),
    );
  }
}
