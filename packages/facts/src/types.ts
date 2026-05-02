/**
 * Type definitions for @happyvertical/smrt-facts
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import type { PromptConfigOverrideInput } from '@happyvertical/smrt-prompts';

/**
 * Fact type classification
 */
export type FactType =
  | 'assertion'
  | 'observation'
  | 'measurement'
  | 'definition'
  | 'relationship'
  | 'event'
  | 'opinion'
  | 'prediction';

/**
 * Fact lifecycle status
 */
export type FactStatus =
  | 'pending'
  | 'active'
  | 'disputed'
  | 'superseded'
  | 'archived'
  | 'retracted';

/**
 * How a fact evolved from its parent
 */
export type EvolutionType =
  | 'original'
  | 'correction'
  | 'refinement'
  | 'contradiction'
  | 'extension'
  | 'merge';

/**
 * Role of a subject entity in relation to a fact
 */
export type SubjectRole =
  | 'subject'
  | 'object'
  | 'source'
  | 'location'
  | 'participant'
  | 'related';

/**
 * Reconcile action taken
 */
export type ReconcileAction = 'created' | 'merged' | 'branched';

/**
 * Relationship between a fact and content
 */
export type FactContentRelationship =
  | 'extracted_from'
  | 'referenced_in'
  | 'supports'
  | 'contradicts'
  | 'related';

/**
 * Options for creating a Fact instance
 */
export interface FactOptions extends SmrtObjectOptions {
  id?: string;
  slug?: string;
  type?: FactType;
  status?: FactStatus;
  domain?: string;
  textRaw?: string;
  textRefined?: string;
  parentId?: string;
  evolutionType?: EvolutionType;
  sourceCount?: number;
  confidence?: number;
  metadata?: string | Record<string, any>;
  tenantId?: string | null;
}

/**
 * Options for creating a FactSource instance
 */
export interface FactSourceOptions extends SmrtObjectOptions {
  id?: string;
  factId?: string;
  sourceType?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  credibility?: number;
  extractedAt?: Date;
  metadata?: string | Record<string, any>;
  tenantId?: string | null;
}

/**
 * Options for creating concrete evidence for a fact.
 */
export interface FactEvidenceOptions extends SmrtObjectOptions {
  id?: string;
  factId?: string;
  evidenceKey?: string;
  sourceKind?: string;
  sourceId?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  quote?: string;
  locator?: string;
  extractionMethod?: string;
  confidence?: number;
  metadata?: string | Record<string, any>;
  tenantId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Options for creating a FactSubject instance
 */
export interface FactSubjectOptions extends SmrtObjectOptions {
  id?: string;
  factId?: string;
  entityType?: string;
  entityId?: string;
  role?: SubjectRole;
  metadata?: string | Record<string, any>;
  tenantId?: string | null;
}

/**
 * Options for creating a FactContent join
 */
export interface FactContentOptions extends SmrtObjectOptions {
  id?: string;
  factId?: string;
  contentId?: string;
  relationship?: FactContentRelationship;
  metadata?: string | Record<string, any>;
  tenantId?: string | null;
}

/**
 * Options for creating a FactTag join
 */
export interface FactTagOptions extends SmrtObjectOptions {
  id?: string;
  factId?: string;
  tagSlug?: string;
  metadata?: string | Record<string, any>;
  tenantId?: string | null;
}

/**
 * Options for the reconcile() operation
 */
export interface ReconcileOptions {
  /** Raw text input to reconcile */
  rawInput: string;
  /** Similarity threshold for automatic merge (default: 0.85) */
  similarityThreshold?: number;
  /** Minimum similarity to consider a conflict (default: 0.60) */
  conflictThreshold?: number;
  /** Fact type classification */
  type?: FactType;
  /** Domain for the fact */
  domain?: string;
  /** Source metadata */
  source?: {
    sourceType?: string;
    sourceUrl?: string;
    sourceTitle?: string;
    credibility?: number;
    metadata?: Record<string, any>;
  };
  tenantId?: string | null;
  /** Runtime prompt override for AI-assisted ambiguous reconciliation */
  promptOverride?: PromptConfigOverrideInput;
}

/**
 * A candidate factual statement extracted from unstructured source text.
 */
export interface FactExtractionCandidate {
  /** Concise, atomic factual statement suitable for audit */
  statement: string;
  /** Fact type classification */
  type?: FactType;
  /** Short source excerpt that supports the statement */
  sourceExcerpt?: string;
  /** Optional extraction confidence from 0 to 1 */
  confidence?: number;
  /** Optional extraction metadata */
  metadata?: Record<string, any>;
}

/**
 * Options for AI-assisted fact extraction from source text.
 */
export interface FactExtractionOptions {
  /** Domain to guide extraction and later reconciliation */
  domain?: string;
  /** Source type, e.g. agenda, minutes, article, transcript */
  sourceType?: string;
  /** Human-readable context for the source text */
  context?: string;
  /** Maximum number of facts to extract */
  maxFacts?: number;
  /** Fact types the extractor may return */
  allowedTypes?: FactType[];
  /** Tenant id used when resolving stored prompt overrides */
  tenantId?: string | null;
  /** Runtime prompt override for a single extraction call */
  promptOverride?: PromptConfigOverrideInput;
}

export type FactClaimSupportStatus =
  | 'supported'
  | 'unsupported'
  | 'contradicted'
  | 'needs_review';

export interface FactClaimSupportCandidate {
  id?: string | null;
  statement: string;
  evidence?: Array<{
    id?: string | null;
    quote?: string | null;
    sourceTitle?: string | null;
    sourceUrl?: string | null;
    locator?: string | null;
  }>;
}

export interface FactClaimSupportAssessment {
  status: FactClaimSupportStatus;
  matchedFactIds: string[];
  rationale: string;
  confidence?: number;
}

export interface FactClaimSupportOptions {
  tenantId?: string | null;
  promptOverride?: PromptConfigOverrideInput;
}

/**
 * Result of the reconcile() operation
 */
export interface ReconcileResult {
  /** Action taken: created, merged, or branched */
  action: ReconcileAction;
  /** The resulting fact (created, updated, or branched) */
  fact: import('./fact').Fact;
  /** Source record if source metadata was provided */
  source?: import('./fact-source').FactSource;
  /** Cosine similarity score of the best match */
  similarity?: number;
  /** The existing fact that was matched (for merge/branch) */
  matchedFact?: import('./fact').Fact;
}

/**
 * Entity briefing - summary of all facts about an entity
 */
export interface EntityBriefing {
  entityType: string;
  entityId: string;
  facts: import('./fact').Fact[];
  totalCount: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
}

/**
 * Fact metadata structure (flexible, application-specific)
 */
export interface FactMetadata {
  /** Original extraction context */
  extractionContext?: string;
  /** AI model used for refinement */
  refinedBy?: string;
  /** Tags for categorization */
  tags?: string[];
  /** Related fact IDs */
  relatedFactIds?: string[];
  /** Corroboration score from cross-referencing */
  corroborationScore?: number;
  /** Allow any other properties */
  [key: string]: any;
}
