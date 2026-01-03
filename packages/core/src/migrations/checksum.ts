/**
 * Migration Checksum Utilities
 *
 * Provides SHA-256 checksum computation for migration idempotency
 * and drift detection.
 */

import { createHash } from 'node:crypto';

/**
 * Compute SHA-256 checksum of migration SQL statements
 *
 * Normalizes SQL before hashing to ensure consistent checksums:
 * - Removes single-line and multi-line comments
 * - Collapses whitespace
 * - Trims each statement
 */
export function computeChecksum(statements: string[]): string {
  const normalized = normalizeSQL(statements);
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Normalize SQL statements for consistent checksums
 *
 * Steps:
 * 1. Remove single-line comments (-- ...)
 * 2. Remove multi-line comments (/* ... *\/)
 * 3. Collapse multiple whitespace to single space
 * 4. Trim each statement
 * 5. Filter empty statements
 * 6. Join with semicolons
 */
export function normalizeSQL(statements: string[]): string {
  return statements
    .map((sql) => {
      // Remove single-line comments
      let normalized = sql.replace(/--.*$/gm, '');
      // Remove multi-line comments
      normalized = normalized.replace(/\/\*[\s\S]*?\*\//g, '');
      // Collapse whitespace
      normalized = normalized.replace(/\s+/g, ' ').trim();
      return normalized;
    })
    .filter((sql) => sql.length > 0)
    .join(';');
}

/**
 * Verify that a migration file hasn't been modified since application
 *
 * @param definitionChecksum - Checksum from current migration definition
 * @param recordChecksum - Checksum stored when migration was applied
 * @param appliedChecksum - Checksum of what was actually applied (for drift)
 */
export function verifyChecksum(
  definitionChecksum: string,
  recordChecksum: string,
  appliedChecksum?: string | null,
): { valid: boolean; drift?: 'file_modified' | 'db_modified' } {
  // Check if definition file was modified after application
  if (definitionChecksum !== recordChecksum) {
    return { valid: false, drift: 'file_modified' };
  }

  // Check if what was applied differs from what we expected
  if (appliedChecksum && appliedChecksum !== recordChecksum) {
    return { valid: false, drift: 'db_modified' };
  }

  return { valid: true };
}

/**
 * Generate a short checksum for display (first 8 characters)
 */
export function shortChecksum(checksum: string): string {
  return checksum.substring(0, 8);
}
