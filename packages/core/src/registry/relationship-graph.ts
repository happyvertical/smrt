/**
 * Relationship graph and dependency resolution module for the SMRT ObjectRegistry.
 *
 * Builds relationship maps and dependency graphs from registered class fields.
 *
 * Extracted from registry.ts as part of issue #1006.
 * @see https://github.com/happyvertical/smrt/issues/1006
 */

import { findClass } from './name-resolver';
import { getClasses } from './shared-state';
import type { RelationshipMetadata } from './types';

/**
 * Build dependency graph from foreignKey relationships.
 *
 * Returns a map where keys are class names and values are arrays
 * of class names that the key depends on (via foreignKey fields).
 */
export function getDependencyGraph(): Map<string, string[]> {
  const classes = getClasses();
  const graph = new Map<string, string[]>();

  // Initialize graph with all registered classes
  for (const [_key, entry] of classes) {
    graph.set(entry.name || _key, []);
  }

  // Scan all fields for foreignKey relationships
  for (const [_key, registered] of classes) {
    const simpleName = registered.name || _key;
    const dependencies: string[] = [];

    for (const [_fieldName, field] of registered.fields) {
      if (field.type === 'foreignKey' && field.related) {
        const relatedClass = field.related;
        // Skip self-references (table can reference itself after creation)
        // Only add if the related class is registered and not self
        if (
          relatedClass !== simpleName &&
          findClass(relatedClass) !== undefined
        ) {
          dependencies.push(relatedClass);
        }
      }
    }

    graph.set(simpleName, dependencies);
  }

  return graph;
}

/**
 * Build comprehensive relationship map from all field types.
 *
 * Returns a map containing all relationships (foreignKey, oneToMany, manyToMany)
 * discovered in registered classes.
 */
export function getRelationshipMap(): Map<string, RelationshipMetadata[]> {
  const classes = getClasses();
  const relationshipMap = new Map<string, RelationshipMetadata[]>();
  const simpleNameCounts = new Map<string, number>();

  // Initialize map with all registered classes
  for (const [key, entry] of classes) {
    // The registry is qualified-name keyed. Keep relationship buckets on that
    // canonical identity as well: classes in separate packages may share a
    // simple name, and a later empty declaration must not overwrite an earlier
    // class's relationships.
    relationshipMap.set(entry.qualifiedName || key, []);
    const simpleName = entry.name || key;
    simpleNameCounts.set(
      simpleName,
      (simpleNameCounts.get(simpleName) ?? 0) + 1,
    );
  }

  // Scan all fields for relationship types
  for (const [key, registered] of classes) {
    const simpleName = registered.name || key;
    const sourceQualifiedClass = registered.qualifiedName || key;
    const relationships: RelationshipMetadata[] = [];

    for (const [fieldName, field] of registered.fields) {
      // Check for foreignKey relationships
      if (field.type === 'foreignKey' && field.related) {
        relationships.push({
          sourceClass: simpleName,
          sourceQualifiedClass,
          fieldName,
          targetClass: field.related,
          type: 'foreignKey',
          options: field._meta,
        });
      }

      // Check for crossPackageRef relationships (cross-package, no DDL FK)
      if (field.type === 'crossPackageRef' && field.related) {
        relationships.push({
          sourceClass: simpleName,
          sourceQualifiedClass,
          fieldName,
          targetClass: field.related,
          type: 'crossPackageRef',
          options: field._meta,
        });
      }

      // Check for oneToMany relationships
      if (field.type === 'oneToMany' && field.related) {
        relationships.push({
          sourceClass: simpleName,
          sourceQualifiedClass,
          fieldName,
          targetClass: field.related,
          type: 'oneToMany',
          options: field._meta,
        });
      }

      // Check for manyToMany relationships
      if (field.type === 'manyToMany' && field.related) {
        relationships.push({
          sourceClass: simpleName,
          sourceQualifiedClass,
          fieldName,
          targetClass: field.related,
          type: 'manyToMany',
          options: field._meta,
        });
      }
    }

    relationshipMap.set(registered.qualifiedName || key, relationships);
  }

  // Preserve the public simple-name map contract where that name identifies
  // exactly one registered class. Colliding names intentionally have no alias:
  // callers with a constructor must use the qualified bucket above.
  for (const [key, registered] of classes) {
    const simpleName = registered.name || key;
    if (simpleNameCounts.get(simpleName) !== 1) continue;
    const qualifiedName = registered.qualifiedName || key;
    const relationships = relationshipMap.get(qualifiedName);
    if (relationships) relationshipMap.set(simpleName, relationships);
  }

  return relationshipMap;
}
