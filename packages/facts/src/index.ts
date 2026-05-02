/**
 * @happyvertical/smrt-facts
 *
 * Distributed memory and knowledge management with provenance tracking
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';
import './prompts.js';

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
export {
  smrtFactsExtractCandidatesPrompt,
  smrtFactsReconcilePrompt,
} from './prompts';

// Export types
export type {
  EntityBriefing,
  EvolutionType,
  FactContentOptions,
  FactContentRelationship,
  FactExtractionCandidate,
  FactExtractionOptions,
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
