/**
 * Checksum Module Tests
 *
 * Tests for SHA-256 checksum computation and SQL normalization.
 */

import { describe, expect, it } from 'vitest';
import {
  computeChecksum,
  normalizeSQL,
  shortChecksum,
  verifyChecksum,
} from '../checksum.js';

describe('checksum', () => {
  describe('normalizeSQL', () => {
    it('should remove SQL comments', () => {
      const sql = [
        '-- This is a comment',
        'CREATE TABLE users (id TEXT PRIMARY KEY);',
        '-- Another comment',
      ];

      const normalized = normalizeSQL(sql);

      expect(normalized).not.toContain('comment');
      expect(normalized).toContain('CREATE TABLE users');
    });

    it('should remove multi-line comments', () => {
      const sql = [
        `/* This is
           a multi-line
           comment */
        CREATE TABLE users (id TEXT);`,
      ];

      const normalized = normalizeSQL(sql);

      expect(normalized).not.toContain('multi-line');
      expect(normalized).toContain('CREATE TABLE users');
    });

    it('should collapse whitespace', () => {
      const sql = [
        `CREATE   TABLE    users (
          id     TEXT   PRIMARY   KEY
        );`,
      ];

      const normalized = normalizeSQL(sql);

      // Should not have multiple consecutive spaces
      expect(normalized).not.toMatch(/\s{2,}/);
    });

    it('should trim leading and trailing whitespace', () => {
      const sql = ['   CREATE TABLE users (id TEXT);   '];

      const normalized = normalizeSQL(sql);

      expect(normalized).toBe('CREATE TABLE users (id TEXT);');
    });

    it('should handle empty input', () => {
      expect(normalizeSQL([])).toBe('');
      expect(normalizeSQL(['   '])).toBe('');
    });

    it('should join multiple statements with semicolons', () => {
      const sql = [
        'CREATE TABLE users (id TEXT)',
        'CREATE TABLE posts (id TEXT)',
      ];
      const normalized = normalizeSQL(sql);
      expect(normalized).toBe(
        'CREATE TABLE users (id TEXT);CREATE TABLE posts (id TEXT)',
      );
    });
  });

  describe('computeChecksum', () => {
    it('should return consistent checksum for same SQL', () => {
      const sql = ['CREATE TABLE users (id TEXT PRIMARY KEY);'];

      const checksum1 = computeChecksum(sql);
      const checksum2 = computeChecksum(sql);

      expect(checksum1).toBe(checksum2);
    });

    it('should return same checksum for equivalent SQL with different formatting', () => {
      // Test that consecutive whitespace is collapsed
      const sql1 = ['CREATE TABLE users (id TEXT);'];
      const sql2 = ['CREATE   TABLE    users    (id    TEXT);'];

      // After normalization (whitespace collapse), these should be equivalent
      expect(computeChecksum(sql1)).toBe(computeChecksum(sql2));

      // Also verify the normalized forms are equal
      expect(normalizeSQL(sql1)).toBe(normalizeSQL(sql2));
    });

    it('should return same checksum for SQL with different comments', () => {
      const sql1 = ['-- Comment 1\nCREATE TABLE users (id TEXT);'];
      const sql2 = ['-- Comment 2\nCREATE TABLE users (id TEXT);'];

      expect(computeChecksum(sql1)).toBe(computeChecksum(sql2));
    });

    it('should return different checksums for different SQL', () => {
      const sql1 = ['CREATE TABLE users (id TEXT);'];
      const sql2 = ['CREATE TABLE profiles (id TEXT);'];

      expect(computeChecksum(sql1)).not.toBe(computeChecksum(sql2));
    });

    it('should return 64-character hex string (SHA-256)', () => {
      const sql = ['CREATE TABLE users (id TEXT);'];
      const checksum = computeChecksum(sql);

      expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should handle array of SQL statements', () => {
      const statements = [
        'CREATE TABLE users (id TEXT);',
        'CREATE INDEX idx_users ON users(id);',
      ];

      const checksum = computeChecksum(statements);

      expect(checksum).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should return consistent checksum for array of statements', () => {
      const statements = [
        'CREATE TABLE users (id TEXT);',
        'CREATE INDEX idx_users ON users(id);',
      ];

      expect(computeChecksum(statements)).toBe(computeChecksum(statements));
    });
  });

  describe('shortChecksum', () => {
    it('should return first 8 characters by default', () => {
      const sql = ['CREATE TABLE users (id TEXT);'];
      const full = computeChecksum(sql);
      const short = shortChecksum(full);

      expect(short).toBe(full.substring(0, 8));
      expect(short).toHaveLength(8);
    });

    it('should handle checksum shorter than requested length', () => {
      const short = shortChecksum('abc');

      expect(short).toBe('abc');
    });
  });

  describe('verifyChecksum', () => {
    it('should return valid when checksums match', () => {
      const result = verifyChecksum('abc123', 'abc123');
      expect(result.valid).toBe(true);
      expect(result.drift).toBeUndefined();
    });

    it('should detect file_modified drift', () => {
      const result = verifyChecksum('abc123', 'def456');
      expect(result.valid).toBe(false);
      expect(result.drift).toBe('file_modified');
    });

    it('should detect db_modified drift', () => {
      const result = verifyChecksum('abc123', 'abc123', 'xyz789');
      expect(result.valid).toBe(false);
      expect(result.drift).toBe('db_modified');
    });

    it('should return valid when applied checksum matches', () => {
      const result = verifyChecksum('abc123', 'abc123', 'abc123');
      expect(result.valid).toBe(true);
    });
  });
});
