/**
 * Inheritance resolution module for the SMRT ObjectRegistry.
 *
 * Extracted from registry.ts as part of issue #1006.
 */

import { createLogger } from '@happyvertical/logger';
import { ConfigurationError } from '../errors';
import type { SmrtObject } from '../object';
import { ObjectRegistry } from '../registry';
import type { MethodDefinition } from '../scanner/types.js';
import {
  type FieldInheritanceLink,
  resolveInheritedFields,
} from '../schema/field-inheritance';
import { prependSmrtSystemFields } from '../system-fields';
import { isFrameworkBaseClass } from './framework-base-classes';
import { findClass, findClassStrict } from './name-resolver';
import {
  getInheritanceCache,
  getInheritanceConfig,
  verboseLog,
} from './shared-state';
import { replacedDeclarations } from './subtype-lineage';
import type { RegisteredClass, RegisteredField } from './types';

const logger = createLogger({ level: 'info' });

/**
 * Runtime field shape merged across an inheritance chain.
 *
 * This is the canonical {@link RegisteredField} shape (a `FieldDefinition`
 * superset that carries the root-level `__tenancy` marker mirrored from the
 * `@tenantId` decorator alongside the canonical `_meta.__tenancy`, a runtime
 * `value`, and an open index signature for forward-compatible keys). Aliasing
 * it keeps merged fields assignable back into the
 * `Map<string, RegisteredField>` on each registered class.
 */
type InheritedFieldDefinition = RegisteredField;

/**
 * Build inheritance chain by walking prototype chain
 *
 * Walks from child → parent → ... → SmrtObject, building array from base to child.
 * Stops at SmrtObject (the framework base class).
 */
export function buildInheritanceChain(ctor: typeof SmrtObject): string[] {
  const chain: string[] = [];
  const visited = new Set<Function>();
  let current: Function | null = ctor;

  // Walk up the prototype chain
  while (current?.name) {
    if (current.name === 'SmrtObject') {
      break;
    }

    if (visited.has(current)) {
      throw ConfigurationError.circularInheritance(
        current.name,
        Array.from(chain),
      );
    }

    visited.add(current);
    chain.unshift(current.name);

    current = Object.getPrototypeOf(current);
  }

  return chain;
}

/**
 * {@link findClassStrict} for a registered class's parent. An ambiguous
 * simple `extends` is rethrown naming the subclass and its package, so the
 * error points at the class whose manifest needs a qualified parent (#4145).
 */
function findParentClassStrict(
  child: RegisteredClass,
  parentName: string,
): RegisteredClass | undefined {
  try {
    return (
      replacedDeclarations().get(parentName) ??
      findClassStrict(parentName, child.packageName)
    );
  } catch (error) {
    if (
      !(error instanceof ConfigurationError) ||
      error.code !== 'CONFIG_AMBIGUOUS_CLASS'
    ) {
      throw error;
    }
    const subclass = child.qualifiedName ?? child.name;
    throw new ConfigurationError(
      `${error.message} Subclass ${subclass} declares \`extends ${parentName}\` ` +
        `without a package; regenerate ${child.packageName ?? 'its'} manifest ` +
        `so the parent is qualified from its import (extendsQualified).`,
      'CONFIG_AMBIGUOUS_CLASS',
      {
        ...(error.details ?? {}),
        subclass,
        subclassPackage: child.packageName,
      },
      error,
    );
  }
}

export function getInheritanceChain(className: string): string[] {
  const cache = getInheritanceCache();

  // Check cache first
  const cached = cache.get(className);
  if (cached) {
    return cached;
  }

  // Get registered class
  const registered = findClass(className);
  if (!registered) {
    return [];
  }

  // Check if already computed and stored
  if (registered.inheritanceChain) {
    cache.set(className, registered.inheritanceChain);
    return registered.inheritanceChain;
  }

  // Build chain from `extends` field (works for manifest-loaded classes)
  // This is critical because manifest-loaded classes have stub constructors
  // that only extend SmrtObject, not their actual parent class.
  // The `extends` field IS stored correctly during registerFromManifest().
  const chain: string[] = [];
  const visited = new Set<RegisteredClass>(); // Cycle detection using object identity
  let current: RegisteredClass | undefined = registered;
  let circularDetected = false;
  while (current) {
    // Cycle detection: use object identity to handle cases where distinct
    // classes share the same name (e.g., histrio:Performer vs smrt-video:Performer)
    if (visited.has(current)) {
      // Self-referential (chain length 1) is expected when a child package
      // extends a parent with the same className and only one is installed.
      // Longer cycles indicate misconfigured manifests.
      if (chain.length > 1) {
        logger.warn(
          `[ObjectRegistry] Circular inheritance detected in chain: ${chain.join(' -> ')} -> ${current.name}. ` +
            `Check that '${current.extends ?? current.name}' resolves to the correct package class.`,
        );
        circularDetected = true;
      }
      break;
    }
    visited.add(current);

    // R5-canon: emit qualified names when available, matching the
    // public `ObjectRegistry.getInheritanceChain` contract. Falls back
    // to simple name for classes registered without a package context.
    chain.unshift(current.qualifiedName ?? current.name); // [ancestor, ..., descendant]
    if (!current.extends) break;

    // Skip framework base classes that are never registered
    if (
      current.extends === 'SmrtObject' ||
      current.extends === 'SmrtClass' ||
      current.extends === 'SmrtCollection'
    ) {
      break;
    }

    // Try to find the parent class
    // Issue #1004/#1005: Use findClassStrict with package context for
    // unambiguous resolution. If extends is already qualified (from
    // qualifyExtendsName), this is an O(1) direct lookup.
    // If ambiguous, let the ConfigurationError propagate — callers
    // should fix their manifests rather than silently get wrong results.
    const parent = findParentClassStrict(current, current.extends);

    // Issue #1007: Parent not found — the class is not registered.
    // After loadAllManifests() completes at startup, all classes are
    // pre-registered so this path is only hit when a package is not
    // installed or the manifest is stale. We gracefully end the chain
    // here instead of mutating registry state during a read operation.
    if (!parent) {
      verboseLog(
        `[ObjectRegistry] Parent class '${current.extends}' not found ` +
          `while building inheritance chain. Ensure the parent package ` +
          `is installed and loadAllManifests() was called at startup.`,
      );
    }

    current = parent;
  }

  // Only cache complete, non-circular chains.
  // Caching a broken chain from a circular detection would cause all future
  // lookups to return incorrect inheritance data (e.g., ["VideoShot","VideoShot"]
  // instead of ["Content","VideoShot"]), breaking STI table resolution.
  if (!circularDetected) {
    registered.inheritanceChain = chain;
    cache.set(className, chain);
  }

  return chain;
}

export async function getAllFields(
  className: string,
): Promise<Map<string, RegisteredField>> {
  let registered = findClass(className);
  if (!registered) {
    const loaded = await ObjectRegistry.tryLoadFromExternalPackage(className);
    if (!loaded) {
      return new Map();
    }

    registered = findClass(className);
  }

  if (!registered) {
    return new Map();
  }

  // Ensure manifest is loaded (handles external packages)
  await ObjectRegistry.ensureManifestLoaded(className);

  // Check if class has inheritedFields cache (set during manifest loading)
  if (registered.inheritedFields) {
    return prependSmrtSystemFields(new Map(registered.inheritedFields));
  }

  // Get config for error handling behavior
  const { onMissingAncestor } = getInheritanceConfig();

  // For local classes (not from manifests), merge fields from inheritance chain
  const chain = getInheritanceChain(className);
  const ancestors: Array<FieldInheritanceLink<InheritedFieldDefinition>> = [];

  // Walk chain from base to child (parent fields first)
  for (const ancestorName of chain) {
    // Skip framework base classes
    if (
      ancestorName === 'SmrtObject' ||
      ancestorName === 'SmrtClass' ||
      ancestorName === 'SmrtCollection'
    ) {
      continue;
    }

    try {
      await ObjectRegistry.ensureManifestLoaded(ancestorName);
    } catch {
      // Local classes and pure test fixtures may not have manifests. Continue
      // with whatever runtime metadata is already available.
    }

    const ancestor =
      replacedDeclarations().get(ancestorName) ?? findClass(ancestorName);
    if (!ancestor) {
      // Handle missing ancestors according to config
      const message = `Missing ancestor class "${ancestorName}" in inheritance chain for "${className}"`;

      if (onMissingAncestor === 'error') {
        throw new Error(
          `${message}\n\n` +
            `This usually means:\n` +
            `  1. The parent class is not registered with @smrt()\n` +
            `  2. The parent class file is not imported\n` +
            `  3. The manifest does not include the parent class\n\n` +
            `To fix:\n` +
            `  - Ensure all parent classes use @smrt() decorator\n` +
            `  - Import all parent class files before child classes\n` +
            `  - Rebuild to regenerate manifest\n` +
            `  - Or set smrt.inheritance.onMissingAncestor='warn' in config`,
        );
      } else if (onMissingAncestor === 'warn') {
        logger.warn(`[ObjectRegistry] ${message}`);
      }

      continue;
    }

    if (ancestor !== registered) ancestors.push(toLink(ancestor));
  }

  // An own-table subclass carries its concrete ancestors' fields in its own
  // table with the nearest declaration winning (#4922); a shared-table family
  // resolves by the same rule (#4940).
  const allFields = resolveRegistryFields(
    registered,
    ancestors,
    ObjectRegistry.getSTIBase(className) === null
      ? 'own-table'
      : 'shared-table',
  );

  registered.inheritedFields = new Map(allFields);

  return prependSmrtSystemFields(new Map<string, RegisteredField>(allFields));
}

function toLink(
  ancestor: RegisteredClass,
): FieldInheritanceLink<InheritedFieldDefinition> {
  return {
    name: ancestor.name,
    fields: ancestor.fields,
    frameworkBase: isFrameworkBaseClass(ancestor.name, ancestor.packageName),
  };
}

/** The one field-inheritance rule, with the registry's representation. */
function resolveRegistryFields(
  registered: RegisteredClass,
  ancestors: Array<FieldInheritanceLink<InheritedFieldDefinition>>,
  strategy: 'own-table' | 'shared-table',
): Map<string, InheritedFieldDefinition> {
  return resolveRegistryFieldMap(
    registered.name,
    ancestors,
    registered.fields,
    strategy,
  );
}

function resolveRegistryFieldMap(
  className: string,
  ancestors: Array<FieldInheritanceLink<InheritedFieldDefinition>>,
  own: Iterable<readonly [string, InheritedFieldDefinition]>,
  strategy: 'own-table' | 'shared-table',
): Map<string, InheritedFieldDefinition> {
  return resolveInheritedFields<InheritedFieldDefinition>({
    strategy,
    className,
    ancestors,
    own,
    representation: 'registry',
    onTypeMismatch: (fieldName, inheritedType, ownType, inherited) => {
      // The @tenantId decorator registers 'foreignKey' while the AST sees
      // 'text': an expected conflict, not worth a warning.
      const isTenantField =
        inherited.__tenancy?.isTenantIdField ||
        inherited._meta?.__tenancy?.isTenantIdField;
      if (isTenantField && fieldName === 'tenantId') return;
      logger.warn(
        `Field type mismatch: "${fieldName}" is ${inheritedType} in parent but ${ownType} in child. Using child type.`,
      );
    },
  });
}

/**
 * One field redeclared by a child over its parent's declaration, resolved by
 * the shared rule (`schema/field-inheritance.ts`): the child's declaration
 * wins. Kept as a small entry point for callers and tests that hold exactly
 * one pair; it is not a second implementation.
 */
export function mergeFieldConfigs(
  parentField: InheritedFieldDefinition,
  childField: InheritedFieldDefinition,
  fieldName: string,
): InheritedFieldDefinition {
  const merged = resolveRegistryFieldMap(
    'Child',
    [
      {
        name: 'Parent',
        fields: [[fieldName, parentField]],
        frameworkBase: false,
      },
    ],
    [[fieldName, childField]],
    'own-table',
  ).get(fieldName);
  return merged ?? childField;
}

/**
 * Whether `SmrtHierarchical` is among a registered class's ancestors, i.e. its
 * `parentId` is the framework's self-referencing tree link that the field
 * inheritance rule binds to the class's own table (as opposed to a foreign key
 * some concrete class declared itself).
 */
export function inheritsHierarchicalBase(registered: RegisteredClass): boolean {
  const key = registered.qualifiedName ?? registered.name;
  return getInheritanceChain(key).some((ancestorName) => {
    const ancestor =
      replacedDeclarations().get(ancestorName) ?? findClass(ancestorName);
    return (
      ancestor !== undefined &&
      ancestor !== registered &&
      ancestor.name === 'SmrtHierarchical' &&
      isFrameworkBaseClass(ancestor.name, ancestor.packageName)
    );
  });
}

/**
 * The fields of an own-table class including its ancestors' (#4922, #4940),
 * resolved synchronously from the registry as it stands. Used where the
 * authoritative schema is built without awaiting manifest loads. Other
 * classes (shared-table members, classes with no registered ancestor) return
 * their registered fields.
 */
export function getOwnTableFieldsSync(
  registered: RegisteredClass,
): Map<string, RegisteredField> {
  const key = registered.qualifiedName ?? registered.name;
  if (ObjectRegistry.getSTIBase(key) !== null) return registered.fields;
  const ancestors: Array<FieldInheritanceLink<InheritedFieldDefinition>> = [];
  for (const ancestorName of getInheritanceChain(key)) {
    if (ancestorName === key) continue;
    const ancestor =
      replacedDeclarations().get(ancestorName) ?? findClass(ancestorName);
    if (!ancestor || ancestor === registered) continue;
    ancestors.push(toLink(ancestor));
  }
  if (ancestors.length === 0) return registered.fields;
  return resolveRegistryFields(registered, ancestors, 'own-table');
}

export async function getAllMethods(
  className: string,
): Promise<Map<string, MethodDefinition>> {
  const registered = findClass(className);
  if (!registered) {
    return new Map();
  }

  // Check cache first
  if (registered.inheritedMethods) {
    return new Map(registered.inheritedMethods);
  }

  // Build merged methods from inheritance chain
  const allMethods = new Map<string, MethodDefinition>();
  const chain = getInheritanceChain(className);

  // Walk chain from base to child (parent methods first)
  for (const ancestorName of chain) {
    // Skip framework base classes (check BEFORE looking up in registry)
    if (
      ancestorName === 'SmrtObject' ||
      ancestorName === 'SmrtClass' ||
      ancestorName === 'SmrtCollection'
    ) {
      continue;
    }

    // Load manifest for ancestor class (handles external packages)
    // This ensures inherited methods from external packages are available
    try {
      await ObjectRegistry.ensureManifestLoaded(ancestorName);
    } catch (error) {
      // Manifest loading failed - this is expected for classes not in manifest
      // Continue to next ancestor
    }

    const ancestor =
      replacedDeclarations().get(ancestorName) ?? findClass(ancestorName);
    if (!ancestor) continue;

    // Merge parent methods into result
    for (const [methodName, method] of ancestor.methods) {
      // Child methods override parent methods (no merging)
      allMethods.set(methodName, method);
    }
  }

  // Cache the merged result
  registered.inheritedMethods = allMethods;

  return new Map(allMethods);
}
