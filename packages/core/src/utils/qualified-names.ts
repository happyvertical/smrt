/**
 * Utilities for working with qualified class names in the SMRT framework.
 *
 * Qualified names follow the format: "@package/name:ClassName"
 * Example: "@happyvertical/smrt-core:Product"
 *
 * This format uniquely identifies classes across packages, eliminating
 * name collisions when multiple packages define classes with the same name.
 */

import type { QualifiedClassName } from '../scanner/types.js';

/**
 * Creates a qualified class name from package name and class name.
 *
 * @param packageName - The npm package name (e.g., "@happyvertical/smrt-core")
 * @param className - The class name (e.g., "Product")
 * @returns Qualified name in format "@package/name:ClassName"
 *
 * @example
 * createQualifiedName('@happyvertical/smrt-core', 'Product')
 * // Returns: "@happyvertical/smrt-core:Product"
 */
export function createQualifiedName(
  packageName: string,
  className: string,
): QualifiedClassName {
  if (!packageName) {
    throw new Error(
      `Cannot create qualified name: packageName is required. ` +
        `Got className="${className}" but no packageName.`,
    );
  }
  if (!className) {
    throw new Error(
      `Cannot create qualified name: className is required. ` +
        `Got packageName="${packageName}" but no className.`,
    );
  }
  return `${packageName}:${className}` as QualifiedClassName;
}

/**
 * Result of parsing a qualified class name.
 */
export interface ParsedQualifiedName {
  /** The package name (e.g., "@happyvertical/smrt-core") */
  packageName: string;
  /** The class name (e.g., "Product") */
  className: string;
}

/**
 * Parses a qualified class name into its components.
 *
 * @param qualifiedName - The qualified name to parse
 * @returns Object with packageName and className
 * @throws Error if the name is not a valid qualified name
 *
 * @example
 * parseQualifiedName('@happyvertical/smrt-core:Product')
 * // Returns: { packageName: '@happyvertical/smrt-core', className: 'Product' }
 */
export function parseQualifiedName(qualifiedName: string): ParsedQualifiedName {
  if (!isQualifiedName(qualifiedName)) {
    throw new Error(
      `Invalid qualified name: "${qualifiedName}". ` +
        `Expected format: "@package/name:ClassName"`,
    );
  }

  // Use lastIndexOf to handle edge cases like "@scope/pkg:Nested:Class"
  // (though class names shouldn't have colons, this is defensive)
  const colonIndex = qualifiedName.lastIndexOf(':');

  return {
    packageName: qualifiedName.slice(0, colonIndex),
    className: qualifiedName.slice(colonIndex + 1),
  };
}

/**
 * Checks if a name is a valid qualified class name.
 *
 * A valid qualified name:
 * - Contains a colon (:) separating package and class
 * - Has a package name with a forward slash (scoped npm package)
 * - Has a non-empty class name after the colon
 *
 * @param name - The name to check
 * @returns true if the name is a valid qualified class name
 *
 * @example
 * isQualifiedName('@happyvertical/smrt-core:Product') // true
 * isQualifiedName('Product') // false
 * isQualifiedName('smrt-core:Product') // false (no @ scope)
 */
export function isQualifiedName(name: string): name is QualifiedClassName {
  if (!name || typeof name !== 'string') {
    return false;
  }

  const colonIndex = name.lastIndexOf(':');
  if (colonIndex === -1) {
    return false;
  }

  const packageName = name.slice(0, colonIndex);
  const className = name.slice(colonIndex + 1);

  // Package name must be a scoped npm package (contains @)
  // and have a path (contains /)
  if (!packageName.startsWith('@') || !packageName.includes('/')) {
    return false;
  }

  // Class name must be non-empty
  if (!className) {
    return false;
  }

  return true;
}

/**
 * Extracts just the class name from a qualified name or simple name.
 * Useful when you need the class name regardless of whether
 * the input is qualified or not.
 *
 * @param name - Qualified name or simple class name
 * @returns The simple class name
 *
 * @example
 * getClassName('@happyvertical/smrt-core:Product') // 'Product'
 * getClassName('Product') // 'Product'
 */
export function getClassName(name: string): string {
  if (isQualifiedName(name)) {
    return parseQualifiedName(name).className;
  }
  return name;
}

/**
 * Extracts the package name from a qualified name.
 * Returns undefined if the name is not qualified.
 *
 * @param name - Qualified name or simple class name
 * @returns The package name, or undefined if not qualified
 *
 * @example
 * getPackageFromQualifiedName('@happyvertical/smrt-core:Product')
 * // Returns: '@happyvertical/smrt-core'
 *
 * getPackageFromQualifiedName('Product')
 * // Returns: undefined
 */
export function getPackageFromQualifiedName(name: string): string | undefined {
  if (isQualifiedName(name)) {
    return parseQualifiedName(name).packageName;
  }
  return undefined;
}

/**
 * Compares two qualified names for equality.
 * Case-sensitive comparison.
 *
 * @param a - First qualified name
 * @param b - Second qualified name
 * @returns true if the qualified names are equal
 */
export function qualifiedNamesEqual(a: string, b: string): boolean {
  return a === b;
}

/**
 * Checks if a qualified name belongs to a specific package.
 *
 * @param qualifiedName - The qualified name to check
 * @param packageName - The package name to match against
 * @returns true if the qualified name is from the specified package
 *
 * @example
 * isFromPackage('@happyvertical/smrt-core:Product', '@happyvertical/smrt-core')
 * // Returns: true
 */
export function isFromPackage(
  qualifiedName: string,
  packageName: string,
): boolean {
  if (!isQualifiedName(qualifiedName)) {
    return false;
  }
  const parsed = parseQualifiedName(qualifiedName);
  return parsed.packageName === packageName;
}

/**
 * Checks if a qualified name (like `_meta_type`) matches a short class name.
 * This is useful for STI filtering where the database stores qualified names
 * but code often uses short names for comparisons.
 *
 * @param qualifiedName - The qualified name or simple name to check (e.g., from `_meta_type`)
 * @param shortName - The short class name to match against
 * @returns true if the class name portion matches
 *
 * @example
 * ```typescript
 * // Filtering STI records by type
 * const meetings = events.filter(e => isType(e._meta_type, 'Meeting'));
 *
 * // Works with both qualified and simple names
 * isType('@happyvertical/praeco:MeetingRecap', 'MeetingRecap') // true
 * isType('@happyvertical/praeco:MeetingRecap', 'Article') // false
 * isType('MeetingRecap', 'MeetingRecap') // true (simple name passthrough)
 * ```
 */
export function isType(
  qualifiedName: string | null | undefined,
  shortName: string,
): boolean {
  if (!qualifiedName) {
    return false;
  }
  return getClassName(qualifiedName) === shortName;
}
