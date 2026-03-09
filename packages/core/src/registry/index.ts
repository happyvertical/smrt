/**
 * Registry module barrel export.
 *
 * Re-exports all sub-modules for convenient importing.
 * @see https://github.com/happyvertical/smrt/issues/1006
 */

// Embedding management
export {
  getEmbeddingClasses,
  getEmbeddingConfig,
  getProjectEmbeddingConfig,
  hasEmbeddings,
  resolveEmbeddingConfig,
} from './embedding-manager';
// Name resolution
export {
  addToClassNameMap,
  findClass,
  findClassesByName,
  findClassStrict,
  getAllClasses,
  getCanonicalClassName,
  getClass,
  getClassByConstructor,
  getClassByQualifiedName,
  getClassesByPackage,
  getClassesByVisibility,
  getClassInPackage,
  getClassNames,
  getPublicClasses,
  hasClass,
  hasClassCaseInsensitive,
  qualifyExtendsName,
  removeFromClassNameMap,
  resolveType,
} from './name-resolver';
// Relationship graph
export { getDependencyGraph, getRelationshipMap } from './relationship-graph';
// Shared state accessors
export {
  getClasses,
  getClassNameMap,
  getCollectionCache,
  getCollections,
  getCollectionTableNames,
  getConstructorIndex,
  getDbInstanceIds,
  getDiscoveryAttemptCache,
  getFieldDecorators,
  getInheritanceCache,
  getInheritanceConfig,
  getNextDbId,
  getSchemasInitialized,
  getSourceFileFromStack,
  getStiSiblingsLoaded,
  setNextDbId,
  VERBOSE_ENABLED,
  verboseLog,
} from './shared-state';
// Types
export type {
  RegisteredClass,
  RelationshipMetadata,
  RelationshipType,
  SmartObjectConfig,
  SmrtObjectConstructor,
  ValidatorFunction,
} from './types';
// Validation
export { compileValidators } from './validator';
