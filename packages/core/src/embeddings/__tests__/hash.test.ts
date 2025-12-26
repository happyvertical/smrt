/**
 * Tests for ContentHasher
 */
import { describe, expect, it } from 'vitest';
import { ContentHasher } from '../hash';

describe('ContentHasher', () => {
  describe('hash', () => {
    it('should generate consistent hash for the same content', () => {
      const content = 'Hello, world!';
      const hash1 = ContentHasher.hash(content);
      const hash2 = ContentHasher.hash(content);

      expect(hash1).toBe(hash2);
    });

    it('should generate different hashes for different content', () => {
      const hash1 = ContentHasher.hash('Hello, world!');
      const hash2 = ContentHasher.hash('Goodbye, world!');

      expect(hash1).not.toBe(hash2);
    });

    it('should generate 64-character hex string (SHA-256)', () => {
      const hash = ContentHasher.hash('test');

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });

    it('should handle empty string', () => {
      const hash = ContentHasher.hash('');

      expect(hash).toHaveLength(64);
      // SHA-256 of empty string
      expect(hash).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
    });

    it('should handle unicode content', () => {
      const hash = ContentHasher.hash('日本語テスト');

      expect(hash).toHaveLength(64);
    });

    it('should handle multiline content', () => {
      const content = `Line 1
Line 2
Line 3`;
      const hash = ContentHasher.hash(content);

      expect(hash).toHaveLength(64);
    });

    it('should be case-sensitive', () => {
      const hash1 = ContentHasher.hash('ABC');
      const hash2 = ContentHasher.hash('abc');

      expect(hash1).not.toBe(hash2);
    });

    it('should distinguish whitespace differences', () => {
      const hash1 = ContentHasher.hash('hello world');
      const hash2 = ContentHasher.hash('hello  world');

      expect(hash1).not.toBe(hash2);
    });
  });
});
