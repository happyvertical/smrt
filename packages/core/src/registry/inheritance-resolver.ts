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
import { prependSmrtSystemFields } from '../system-fields';
import { findClass, findClassStrict } from './name-resolver';
import {
  getInheritanceCache,
  getInheritanceConfig,
  verboseLog,
} from './shared-state';
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
    const parent = findClassStrict(current.extends, current.packageName);

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
  const allFields = new Map<string, InheritedFieldDefinition>();
  const chain = getInheritanceChain(className);

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

    const ancestor = findClass(ancestorName);
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

    // Merge fields from this ancestor
    for (const [fieldName, field] of ancestor.fields) {
      const normalizedField = normalizeFrameworkInheritedField(
        ancestorName,
        fieldName,
        field,
        className,
      );
      const existingField = allFields.get(fieldName);
      if (!existingField) {
        // New field from parent
        allFields.set(fieldName, normalizedField);
      } else {
        // Field exists - merge configs
        allFields.set(
          fieldName,
          mergeFieldConfigs(existingField, normalizedField, fieldName),
        );
      }
    }
  }

  registered.inheritedFields = new Map(allFields);

  return prependSmrtSystemFields(new Map<string, RegisteredField>(allFields));
}

function normalizeFrameworkInheritedField(
  ancestorName: string,
  fieldName: string,
  field: InheritedFieldDefinition,
  childClassName: string,
): InheritedFieldDefinition {
  const simpleAncestorName = ancestorName.includes(':')
    ? ancestorName.split(':').pop()
    : ancestorName;

  if (simpleAncestorName === 'SmrtHierarchical' && fieldName === 'parentId') {
    return {
      ...field,
      type: 'foreignKey',
      related: childClassName,
      required: false,
      _meta: {
        ...(field._meta || {}),
        nullable: true,
      },
    };
  }

  return field;
}

export function mergeFieldConfigs(
  parentField: InheritedFieldDefinition,
  childField: InheritedFieldDefinition,
  fieldName: string,
): InheritedFieldDefinition {
  // Start with parent field as base
  const merged: InheritedFieldDefinition = { ...parentField };

  // Type: Child wins (warn if different)
  if (childField.type && childField.type !== parentField.type) {
    // Don't warn for tenantId field - expected type conflict between decorator and AST
    // The @tenantId decorator registers as 'foreignKey' but AST sees 'text' from type annotation
    // __tenancy can be at root level (from @tenantId decorator) or under _meta (from @smrt({ tenantScoped: true }))
    const isTenantField =
      parentField.__tenancy?.isTenantIdField ||
      parentField._meta?.__tenancy?.isTenantIdField;
    if (!(isTenantField && fieldName === 'tenantId')) {
      logger.warn(
        `Field type mismatch: "${fieldName}" is ${parentField.type} in parent but ${childField.type} in child. Using child type.`,
      );
    }
    merged.type = childField.type;
  }

  // _meta: Merge with child precedence
  if (childField._meta || parentField._meta) {
    merged._meta = {
      ...(parentField._meta || {}),
      ...(childField._meta || {}),
    };

    // Special handling for numeric constraints (take strictest)
    if (
      parentField._meta?.min !== undefined &&
      childField._meta?.min !== undefined
    ) {
      // Take the larger min (strictest lower bound)
      merged._meta.min = Math.max(parentField._meta.min, childField._meta.min);
    }
    if (
      parentField._meta?.max !== undefined &&
      childField._meta?.max !== undefined
    ) {
      // Take the smaller max (strictest upper bound)
      merged._meta.max = Math.min(parentField._meta.max, childField._meta.max);
    }

    // Validators: Combine (both must pass)
    if (parentField._meta?.validate && childField._meta?.validate) {
      // `_meta.validate` is carried through the open `FieldMeta` index
      // signature as `unknown`; both sides are field-validator callbacks.
      type FieldValidator = (value: unknown) => boolean | Promise<boolean>;
      const parentValidator = parentField._meta.validate as FieldValidator;
      const childValidator = childField._meta.validate as FieldValidator;
      merged._meta.validate = async (value: unknown) => {
        const parentResult = await parentValidator(value);
        const childResult = await childValidator(value);
        return parentResult && childResult;
      };
    }

    // Unique: Take OR (unique if either says unique)
    if (parentField._meta?.unique || childField._meta?.unique) {
      merged._meta.unique = true;
    }
  }

  // __tenancy: Preserve from parent (decorator takes precedence)
  // This ensures @tenantId decorator metadata survives type conflicts (Issue #841)
  // The decorator registers __tenancy metadata, but AST scanner may override the type.
  // We need to preserve __tenancy so the interceptor can identify tenant fields.
  if (parentField.__tenancy || childField.__tenancy) {
    merged.__tenancy = {
      ...(childField.__tenancy || {}),
      ...(parentField.__tenancy || {}), // Parent (decorator) wins
    };
  }

  // Value: Child wins
  if (childField.value !== undefined) {
    merged.value = childField.value;
  }

  return merged;
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

    const ancestor = findClass(ancestorName);
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
