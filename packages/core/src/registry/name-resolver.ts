/**
 * Name resolution module for the SMRT ObjectRegistry.
 *
 * Handles class lookup, disambiguation, and qualified name resolution.
 * All functions operate on the shared globalThis state.
 *
 * Extracted from registry.ts as part of issue #1006.
 * @see https://github.com/happyvertical/smrt/issues/1006
 */

import { ConfigurationError } from '../errors';
import type { QualifiedClassName, SmrtVisibility } from '../scanner/types.js';
import {
  createQualifiedName,
  isQualifiedName,
  parseQualifiedName,
} from '../utils/qualified-names.js';
import {
  getClasses,
  getClassNameMap,
  getConstructorIndex,
  verboseLog,
} from './shared-state';
import type { RegisteredClass, SmrtObjectConstructor } from './types';

// ── Class name map helpers ─────────────────────────────────

/**
 * Add a mapping from a lowercase simple name to a qualified key in classNameMap.
 * Supports multiple qualified keys per simple name (for ambiguity detection).
 */
export function addToClassNameMap(
  simpleNameLower: string,
  qualifiedKey: string,
): void {
  const map = getClassNameMap();
  const existing = map.get(simpleNameLower) || [];
  if (!existing.includes(qualifiedKey)) {
    existing.push(qualifiedKey);
    map.set(simpleNameLower, existing);
  }
}

/**
 * Remove a qualified key from a classNameMap entry.
 * Cleans up empty arrays.
 */
export function removeFromClassNameMap(
  simpleNameLower: string,
  qualifiedKey: string,
): void {
  const map = getClassNameMap();
  const existing = map.get(simpleNameLower);
  if (existing) {
    const idx = existing.indexOf(qualifiedKey);
    if (idx !== -1) existing.splice(idx, 1);
    if (existing.length === 0) map.delete(simpleNameLower);
  }
}

// ── Lookup functions ────────────────────────────────────────

/**
 * Check if a class is already registered (case-insensitive).
 * Returns the canonical name if found, undefined otherwise.
 */
export function getCanonicalClassName(name: string): string | undefined {
  const entries = getClassNameMap().get(name.toLowerCase());
  if (!entries || entries.length === 0) return undefined;
  if (entries.length === 1) return entries[0];
  // Ambiguous — multiple entries, return undefined
  return undefined;
}

/**
 * Check if a class exists by name (case-insensitive).
 */
export function hasClassCaseInsensitive(name: string): boolean {
  const entries = getClassNameMap().get(name.toLowerCase());
  return !!entries && entries.length > 0;
}

/**
 * Helper for class lookup with qualified name support.
 *
 * Lookup priority:
 * 1. Direct hit on classes map (works for qualified names as keys)
 * 2. If input contains ':', prefer direct qualified lookup, then fall back to
 *    an exact/simple registration when runtime source imports registered the
 *    class before package-qualified promotion happened
 * 3. classNameMap lookup by simple name (lowercase)
 *    - Unambiguous (1 entry) → return it
 *    - Ambiguous (>1 entry) → log warning, return first match
 * 4. Case-insensitive iteration fallback (backward compat)
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
    const entries = getClassNameMap().get(className.toLowerCase());

    if (entries && entries.length > 0) {
      const exactPackageMatch = entries
        .map((entry) => classes.get(entry))
        .find((candidate) => candidate?.packageName === packageName);

      if (exactPackageMatch) {
        return exactPackageMatch;
      }

      if (entries.length === 1) {
        const fallback = classes.get(entries[0]);
        if (fallback && !fallback.packageName) {
          return fallback;
        }
      }
    }

    return undefined;
  }

  // 3. classNameMap lookup by simple name
  const entries = getClassNameMap().get(name.toLowerCase());
  if (entries && entries.length > 0) {
    if (entries.length === 1) {
      // Unambiguous — return the single match
      return classes.get(entries[0]);
    }
    // Ambiguous — multiple packages define this class name
    // Return first match but log a warning (use resolveType() for strict behavior)
    verboseLog(
      `[registry] findClass("${name}") is ambiguous — ${entries.length} matches. ` +
        `Use qualified name (e.g., ${entries[0]}) for precision.`,
    );
    return classes.get(entries[0]);
  }

  // 4. Case-insensitive iteration fallback (backward compat for simple names)
  const lowerName = name.toLowerCase();
  for (const [key, value] of classes.entries()) {
    // Only match by the registered simple name, not by the full key
    if (value.name?.toLowerCase() === lowerName) {
      return value;
    }
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

  // 4. classNameMap lookup by simple name
  const entries = getClassNameMap().get(name.toLowerCase());
  if (entries && entries.length > 0) {
    if (entries.length === 1) {
      // Unambiguous — return the single match
      return classes.get(entries[0]);
    }
    // Ambiguous — multiple packages define this class name
    // In strict mode, throw instead of silently returning first match
    throw new ConfigurationError(
      `Ambiguous class name "${name}" — found in ${entries.length} packages: ` +
        `${entries.join(', ')}. ` +
        `Use a qualified name (e.g., ${entries[0]}) to disambiguate.`,
      'CONFIG_AMBIGUOUS_CLASS',
      { className: name, candidates: entries },
    );
  }

  // 5. Case-insensitive iteration fallback (backward compat for simple names)
  const lowerName = name.toLowerCase();
  for (const [key, value] of classes.entries()) {
    // Only match by the registered simple name, not by the full key
    if (value.name?.toLowerCase() === lowerName) {
      return value;
    }
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
  const entries = getClassNameMap().get(extendsValue.toLowerCase());
  if (entries && entries.length === 1) {
    // Unambiguous — use the single match's qualified key
    return entries[0];
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
