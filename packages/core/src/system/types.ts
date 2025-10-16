/**
 * Type definitions for SMRT system tables
 */

/**
 * Options for storing a note
 */
export interface NoteOptions {
  /** Hierarchical scope (e.g., 'discovery/parser/domain.com') */
  scope: string;
  /** Normalized identifier (e.g., URL, entity ID) */
  key: string;
  /** Strategy data (regex patterns, selectors, etc.) */
  value: any;
  /** Additional metadata */
  metadata?: NoteMetadata;
  /** Confidence score (0.0 to 1.0) */
  confidence?: number;
  /** Strategy version number */
  version?: number;
  /** Expiration date */
  expiresAt?: Date;
}

/**
 * Note metadata structure
 * Optimized for storing AI-learned strategies
 */
export interface NoteMetadata {
  /** AI provider used for learning */
  aiProvider?: string;
  /** AI model used */
  aiModel?: string;
  /** Original AI confidence */
  aiConfidence?: number;
  /** Regex patterns */
  patterns?: string[];
  /** CSS selectors */
  selectors?: string[];
  /** Expected result count */
  expectedCount?: number;
  /** Hash of page HTML for change detection */
  pageHash?: string;
  /** Tags for categorization */
  tags?: string[];
  /** Importance score */
  importance?: number;
  /** Source of the strategy */
  source?: string;
  /** Version this replaces */
  replacesVersion?: number;
  /** Whether human reviewed */
  humanReviewed?: boolean;
  /** Reviewer identifier */
  reviewedBy?: string;
  /** Review notes */
  reviewNotes?: string;
  /** Allow any other properties */
  [key: string]: any;
}

/**
 * Options for recalling notes
 */
export interface RecallOptions {
  /** Scope to search in */
  scope: string;
  /** Key to search for */
  key: string;
  /** Search parent scopes if not found */
  includeAncestors?: boolean;
  /** Search child scopes */
  includeDescendants?: boolean;
  /** Minimum confidence threshold */
  minConfidence?: number;
  /** Only return highest version */
  latestVersionOnly?: boolean;
}

/**
 * Options for recalling multiple notes
 */
export interface RecallAllOptions {
  /** Scope to search in (optional) */
  scope?: string;
  /** Search child scopes */
  includeDescendants?: boolean;
  /** Minimum confidence threshold */
  minConfidence?: number;
  /** Only return highest versions */
  latestVersionOnly?: boolean;
}

/**
 * Options for forgetting notes
 */
export interface ForgetOptions {
  /** Scope to delete from */
  scope: string;
  /** Key to delete */
  key: string;
}

/**
 * Options for forgetting a scope
 */
export interface ForgetScopeOptions {
  /** Scope to delete */
  scope: string;
  /** Delete child scopes too */
  includeDescendants?: boolean;
}

/**
 * Discovery strategy structure (common use case)
 */
export interface DiscoveryStrategy {
  /** Regex patterns */
  patterns: string[];
  /** CSS selectors */
  selectors?: string[];
  /** Expected result count */
  expectedCount: number;
  /** Strategy version */
  version: number;
  /** Confidence score */
  confidence: number;
}

/**
 * System table configuration
 */
export interface SystemTableConfig {
  /** Enable signal history persistence */
  persistSignalHistory?: boolean;
  /** Note retention in days */
  noteRetentionDays?: number;
  /** Cleanup interval */
  cleanupInterval?: 'hourly' | 'daily' | 'weekly' | 'never';
  /** Archive confidence threshold */
  archiveThreshold?: number;
}
