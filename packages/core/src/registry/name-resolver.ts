/**
 * Name resolution module for the SMRT ObjectRegistry.
 *
 * Handles class lookup, disambiguation, and qualified name resolution.
 * All functions operate on the shared globalThis state.
 *
 * Release B (#1133): classNameMap is gone — the eagerly-maintained
 * lowercase-simple-name → qualified-key[] index was removed in favor of
 * on-demand iteration over the `classes` Map. Production SMRT apps carry
 * a few hundred classes at most, so the linear scan is negligible and
 * removes an entire class of cache-sync bugs (#584, #847, #951).
 *
 * Extracted from registry.ts as part of issue #1006.
 * @see https://github.com/happyvertical/smrt/issues/1006
 * @see https://github.com/happyvertical/smrt/issues/1133
 */

import { ConfigurationError } from '../errors';
import type { QualifiedClassName, SmrtVisibility } from '../scanner/types.js';
import {
  createQualifiedName,
  isQualifiedName,
  parseQualifiedName,
} from '../utils/qualified-names.js';
import { getClasses, getConstructorIndex, verboseLog } from './shared-state';
import type { RegisteredClass, SmrtObjectConstructor } from './types';

// ── Simple-name iteration (replaces classNameMap reads) ─────────────

/**
 * Return every registry key whose registered class has the given simple
 * name (case-insensitive). Replaces the old eagerly-maintained
 * `__smrtRegistryClassNameMap` lookup: we iterate `classes` instead.
 *
 * Cost is O(n) over the classes map; production SMRT apps hold low-
 * hundreds of entries so this is trivially fast. Returned keys preserve
 * insertion order, which makes the "first match wins" behavior of the old
 * map-based lookup deterministic in the same way.
 *
 * De-duplicates by RegisteredClass object identity so a class registered
 * under both a simple key and a promoted qualified key (a transitional
 * state during manifest merge) counts as a single entry — matching the
 * old classNameMap's behavior of storing each canonical qualified key once.
 * When that happens, the qualified key wins over the simple one.
 */
function registryKeysBySimpleName(simpleName: string): string[] {
  const lower = simpleName.toLowerCase();
  const classes = getClasses();
  const seen = new Map<unknown, string>();

  for (const [key, value] of classes.entries()) {
    if (value.name?.toLowerCase() !== lower) continue;

    const existing = seen.get(value);
    if (!existing) {
      seen.set(value, key);
      continue;
    }

    // Two keys for the same object: prefer the qualified form.
    if (key.includes(':') && !existing.includes(':')) {
      seen.set(value, key);
    }
  }

  return [...seen.values()];
}

// ── Lookup functions ────────────────────────────────────────

/**
 * Check if a class is already registered (case-insensitive).
 * Returns the canonical name if found, undefined otherwise. Returns
 * undefined if the simple name is ambiguous across multiple packages.
 */
export function getCanonicalClassName(name: string): string | undefined {
  const keys = registryKeysBySimpleName(name);
  if (keys.length === 1) return keys[0];
  // Zero matches, or ambiguous with >1 entries
  return undefined;
}

/**
 * Check if a class exists by name (case-insensitive).
 */
export function hasClassCaseInsensitive(name: string): boolean {
  const lower = name.toLowerCase();
  for (const value of getClasses().values()) {
    if (value.name?.toLowerCase() === lower) return true;
  }
  return false;
}

/**
 * Helper for class lookup with qualified name support.
 *
 * Lookup priority:
 * 1. Direct hit on classes map (works for qualified names as keys)
 * 2. If input contains ':', prefer direct qualified lookup, then fall back
 *    to an exact/simple registration when runtime source imports registered
 *    the class before package-qualified promotion happened
 * 3. Simple-name iteration by lowercase
 *    - Unambiguous (1 match) → return it
 *    - Ambiguous (>1 matches) → log warning, return first
 */
export function findClass(name: string): RegisteredClass | undefined {
  const classes = getClasses();

  // 1. Direct hit on classes map (fast path, works for qualified keys)
  const registered = classes.get(name);
  if (registered) {
    return registered;
  }

  // 2. Qualified lookup fallback for source-registered classes.
  // In workspace/dev mode a package can be imported from source before a
  // manifest-promoted qualified key exists. If we already have exactly the
  // requested package or a single unqualified registration for this class
  // name, treat it as the same class instead of forcing node_modules manifest
  // discovery.
  if (isQualifiedName(name)) {
    const { packageName, className } = parseQualifiedName(name);
    const keys = registryKeysBySimpleName(className);

    if (keys.length > 0) {
      const exactPackageMatch = keys
        .map((key) => classes.get(key))
        .find((candidate) => candidate?.packageName === packageName);

      if (exactPackageMatch) {
        return exactPackageMatch;
      }

      if (keys.length === 1) {
        const fallback = classes.get(keys[0]);
        if (fallback && !fallback.packageName) {
          return fallback;
        }
      }
    }

    return undefined;
  }

  // 3. Simple-name lookup
  const keys = registryKeysBySimpleName(name);
  if (keys.length > 0) {
    if (keys.length === 1) {
      return classes.get(keys[0]);
    }
    // Ambiguous — multiple packages define this class name
    // Return first match but log a warning (use resolveType() for strict behavior)
    verboseLog(
      `[registry] findClass("${name}") is ambiguous — ${keys.length} matches. ` +
        `Use qualified name (e.g., ${keys[0]}) for precision.`,
    );
    return classes.get(keys[0]);
  }

  return undefined;
}

/**
 * Strict class lookup with package-aware disambiguation.
 *
 * Unlike `findClass()` which silently returns the first match when a simple
 * name is ambiguous, this method throws a `ConfigurationError` — making it
 * safe for inheritance-critical paths.
 *
 * @throws {ConfigurationError} When simple name is ambiguous and no package context resolves it
 * @see https://github.com/happyvertical/smrt/issues/1005
 */
export function findClassStrict(
  name: string,
  fromPackage?: string,
): RegisteredClass | undefined {
  const classes = getClasses();

  // 1. Direct hit on classes map (fast path, works for qualified keys)
  const registered = classes.get(name);
  if (registered) {
    return registered;
  }

  // 2. If input is a qualified name, no fallback — it's not found
  if (isQualifiedName(name)) {
    return undefined;
  }

  // 3. If fromPackage provided, try constructing qualified name for direct lookup
  if (fromPackage) {
    const qualifiedAttempt = createQualifiedName(fromPackage, name);
    const byQualified = classes.get(qualifiedAttempt);
    if (byQualified) {
      return byQualified;
    }
  }

  // 4. Simple-name lookup
  const keys = registryKeysBySimpleName(name);
  if (keys.length > 0) {
    if (keys.length === 1) {
      return classes.get(keys[0]);
    }
    // Ambiguous — multiple packages define this class name
    // In strict mode, throw instead of silently returning first match
    throw new ConfigurationError(
      `Ambiguous class name "${name}" — found in ${keys.length} packages: ` +
        `${keys.join(', ')}. ` +
        `Use a qualified name (e.g., ${keys[0]}) to disambiguate.`,
      'CONFIG_AMBIGUOUS_CLASS',
      { className: name, candidates: keys },
    );
  }

  return undefined;
}

/**
 * Qualify an `extends` value with the parent class's package name.
 *
 * @see https://github.com/happyvertical/smrt/issues/1004
 */
export function qualifyExtendsName(
  extendsValue: string,
  currentPackage: string,
): string {
  const classes = getClasses();

  // Already qualified → pass through
  if (isQualifiedName(extendsValue)) {
    return extendsValue;
  }

  // Skip framework base classes (never registered with qualified names)
  if (
    extendsValue === 'SmrtObject' ||
    extendsValue === 'SmrtClass' ||
    extendsValue === 'SmrtCollection'
  ) {
    return extendsValue;
  }

  // Try same-package first (common case: child and parent in same package)
  const samePackageQualified = createQualifiedName(
    currentPackage,
    extendsValue,
  );
  if (classes.has(samePackageQualified)) {
    return samePackageQualified;
  }

  // Try to find the parent in any registered package
  const keys = registryKeysBySimpleName(extendsValue);
  if (keys.length === 1) {
    return keys[0];
  }

  // Fallback: return unmodified (backward compat)
  return extendsValue;
}

// ── Public lookup functions ─────────────────────────────────

/**
 * Get a registered class by name (case-insensitive).
 */
export function getClass(name: string): RegisteredClass | undefined {
  return findClass(name);
}

/**
 * Get a registered class by its constructor reference (O(1) WeakMap lookup).
 */
export function getClassByConstructor(
  ctor: SmrtObjectConstructor,
): RegisteredClass | undefined {
  const registeredName = getConstructorIndex().get(ctor);
  if (registeredName) {
    return getClasses().get(registeredName);
  }
  return undefined;
}

/**
 * Get a registered class by its qualified name (O(1) direct lookup).
 */
export function getClassByQualifiedName(
  qualifiedName: string,
): RegisteredClass | undefined {
  return getClasses().get(qualifiedName);
}

/**
 * Get a registered class by package name and class name.
 */
export function getClassInPackage(
  packageName: string,
  className: string,
): RegisteredClass | undefined {
  const qualifiedName = createQualifiedName(packageName, className);
  return getClasses().get(qualifiedName);
}

/**
 * Find all registered classes with a given simple class name.
 */
export function findClassesByName(className: string): RegisteredClass[] {
  const matches: RegisteredClass[] = [];
  const lowerName = className.toLowerCase();

  for (const registered of getClasses().values()) {
    if (registered.name.toLowerCase() === lowerName) {
      matches.push(registered);
    }
  }

  return matches;
}

/**
 * Resolve a short class name to its qualified name.
 * @throws {Error} If no class or ambiguous classes registered
 */
export function resolveType(shortName: string): QualifiedClassName {
  // If already qualified, validate and return
  if (shortName.includes(':') && shortName.startsWith('@')) {
    const registered = getClassByQualifiedName(shortName as QualifiedClassName);
    if (!registered) {
      throw new Error(
        `Class "${shortName}" is not registered. ` +
          `Make sure the package is installed and the class is decorated with @smrt().`,
      );
    }
    return shortName as QualifiedClassName;
  }

  // Find all classes with this short name
  const matches = findClassesByName(shortName);

  if (matches.length === 0) {
    throw new Error(
      `Class "${shortName}" is not registered. ` +
        `Make sure the package is installed and the class is decorated with @smrt().`,
    );
  }

  if (matches.length > 1) {
    const packageList = matches.map((m) => `  - ${m.qualifiedName}`).join('\n');
    throw new Error(
      `"${shortName}" is ambiguous. Found in multiple packages:\n${packageList}\n` +
        `Use the fully qualified name instead.`,
    );
  }

  return matches[0].qualifiedName as QualifiedClassName;
}

/**
 * Get all registered classes from a specific package.
 */
export function getClassesByPackage(
  packageName: string,
): Map<string, RegisteredClass> {
  const result = new Map<string, RegisteredClass>();

  for (const [name, registered] of getClasses().entries()) {
    if (registered.packageName === packageName) {
      result.set(name, registered);
    }
  }

  return result;
}

/**
 * Get all registered classes with a specific visibility level.
 */
export function getClassesByVisibility(
  visibility: SmrtVisibility,
): Map<string, RegisteredClass> {
  const result = new Map<string, RegisteredClass>();

  for (const [name, registered] of getClasses().entries()) {
    const classVisibility = registered.visibility || 'public';
    if (classVisibility === visibility) {
      result.set(name, registered);
    }
  }

  return result;
}

/**
 * Get all public registered classes.
 */
export function getPublicClasses(): Map<string, RegisteredClass> {
  return getClassesByVisibility('public');
}

/**
 * Get all registered classes.
 */
export function getAllClasses(): Map<string, RegisteredClass> {
  return new Map(getClasses());
}

/**
 * Get class names (simple names, deduplicated).
 */
export function getClassNames(): string[] {
  const names = Array.from(getClasses().values()).map((entry) => entry.name);
  return Array.from(new Set(names));
}

/**
 * Check if a class is registered (case-insensitive).
 */
export function hasClass(name: string): boolean {
  return findClass(name) !== undefined;
}
