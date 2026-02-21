/**
 * @happyvertical/smrt-facts
 *
 * Distributed memory and knowledge management with provenance tracking
 *
 * @packageDocumentation
 */

// Export models
export { Fact } from './fact';
export { FactContent } from './fact-content';
export { FactContentCollection } from './fact-contents';
export { FactSource } from './fact-source';
export { FactSourceCollection } from './fact-sources';
export { FactSubject } from './fact-subject';
export { FactSubjectCollection } from './fact-subjects';
export { FactTag } from './fact-tag';
export { FactTagCollection } from './fact-tags';
// Export collections
export { FactCollection } from './facts';

// Export types
export type {
  EntityBriefing,
  EvolutionType,
  FactContentOptions,
  FactContentRelationship,
  FactMetadata,
  FactOptions,
  FactSourceOptions,
  FactStatus,
  FactSubjectOptions,
  FactTagOptions,
  FactType,
  ReconcileAction,
  ReconcileOptions,
  ReconcileResult,
  SubjectRole,
} from './types';

// Export utilities
export { calculateConfidence, normalizeText } from './utils';
