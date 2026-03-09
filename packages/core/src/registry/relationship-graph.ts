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

  // Initialize map with all registered classes
  for (const [_key, entry] of classes) {
    relationshipMap.set(entry.name || _key, []);
  }

  // Scan all fields for relationship types
  for (const [_key, registered] of classes) {
    const simpleName = registered.name || _key;
    const relationships: RelationshipMetadata[] = [];

    for (const [fieldName, field] of registered.fields) {
      // Check for foreignKey relationships
      if (field.type === 'foreignKey' && field.related) {
        relationships.push({
          sourceClass: simpleName,
          fieldName,
          targetClass: field.related,
          type: 'foreignKey',
          options: field._meta,
        });
      }

      // Check for oneToMany relationships
      if (field.type === 'oneToMany' && field.related) {
        relationships.push({
          sourceClass: simpleName,
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
          fieldName,
          targetClass: field.related,
          type: 'manyToMany',
          options: field._meta,
        });
      }
    }

    relationshipMap.set(simpleName, relationships);
  }

  return relationshipMap;
}
