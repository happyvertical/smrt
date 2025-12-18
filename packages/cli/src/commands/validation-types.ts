/**
 * Type definitions for JSON database validation
 */

export type ValidationSeverity = 'error' | 'warning' | 'info';

/**
 * A single validation issue found during database validation
 */
export interface ValidationIssue {
  /** Severity level of the issue */
  severity: ValidationSeverity;
  /** Error code for programmatic handling */
  code: string;
  /** Human-readable description of the issue */
  message: string;
  /** File path where the issue was found */
  file?: string;
  /** SMRT object type (class name) */
  objectType?: string;
  /** ID of the record with the issue */
  objectId?: string;
  /** Field name involved in the issue */
  field?: string;
  /** Expected value or type */
  expected?: unknown;
  /** Actual value found */
  actual?: unknown;
  /** Whether this issue can be automatically fixed */
  fixable?: boolean;
}

/**
 * Validation results for a single object type/file
 */
export interface ObjectValidationResult {
  /** SMRT object type (class name) */
  objectType: string | null;
  /** Database table name */
  tableName: string;
  /** Path to the JSON file */
  file: string;
  /** Total number of records in the file */
  recordCount: number;
  /** Number of valid records */
  validCount: number;
  /** Number of invalid records */
  invalidCount: number;
  /** List of issues found */
  issues: ValidationIssue[];
}

/**
 * Complete validation summary
 */
export interface ValidationSummary {
  /** ISO timestamp of validation run */
  timestamp: string;
  /** Path to the data directory */
  dataPath: string;
  /** Path to manifest used for validation */
  manifestPath: string | null;
  /** Duration of validation in milliseconds */
  duration: number;
  /** Number of JSON files validated */
  totalFiles: number;
  /** Total number of records across all files */
  totalRecords: number;
  /** Number of valid records */
  validRecords: number;
  /** Number of invalid records */
  invalidRecords: number;
  /** Issue counts by severity */
  issues: {
    errors: number;
    warnings: number;
    info: number;
  };
  /** Per-object validation results */
  objectResults: ObjectValidationResult[];
}

/**
 * Internal validation results before summary generation
 */
export interface ValidationResults {
  objectResults: ObjectValidationResult[];
  fixableIssues: ValidationIssue[];
}

/**
 * Validation error codes organized by category
 */
export const ValidationCodes = {
  // Structure issues
  INVALID_JSON: 'INVALID_JSON',
  NOT_ARRAY: 'NOT_ARRAY',
  EMPTY_OBJECT: 'EMPTY_OBJECT',

  // ID/Slug issues
  MISSING_ID: 'MISSING_ID',
  DUPLICATE_ID: 'DUPLICATE_ID',
  INVALID_ID_FORMAT: 'INVALID_ID_FORMAT',
  MISSING_SLUG: 'MISSING_SLUG',
  DUPLICATE_SLUG_CONTEXT: 'DUPLICATE_SLUG_CONTEXT',

  // Type issues
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_DATE: 'INVALID_DATE',
  INVALID_JSON_FIELD: 'INVALID_JSON_FIELD',
  INVALID_BOOLEAN: 'INVALID_BOOLEAN',
  INVALID_NUMBER: 'INVALID_NUMBER',
  INVALID_INTEGER: 'INVALID_INTEGER',

  // STI issues
  MISSING_META_TYPE: 'MISSING_META_TYPE',
  UNKNOWN_META_TYPE: 'UNKNOWN_META_TYPE',
  INVALID_META_DATA: 'INVALID_META_DATA',

  // Required field issues
  MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',

  // Constraint issues
  VALUE_OUT_OF_RANGE: 'VALUE_OUT_OF_RANGE',
  STRING_TOO_LONG: 'STRING_TOO_LONG',
  STRING_TOO_SHORT: 'STRING_TOO_SHORT',
  PATTERN_MISMATCH: 'PATTERN_MISMATCH',

  // Relationship issues (full validation only)
  INVALID_FOREIGN_KEY: 'INVALID_FOREIGN_KEY',
  MISSING_FK_TABLE: 'MISSING_FK_TABLE',
  ORPHANED_RECORD: 'ORPHANED_RECORD',

  // Schema mismatch
  UNKNOWN_FIELD: 'UNKNOWN_FIELD',
  MISSING_TABLE_FILE: 'MISSING_TABLE_FILE',
  UNKNOWN_TABLE: 'UNKNOWN_TABLE',
} as const;

export type ValidationCode =
  (typeof ValidationCodes)[keyof typeof ValidationCodes];
