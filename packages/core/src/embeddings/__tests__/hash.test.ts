/**
 * Tests for ContentHasher
 */
import { describe, expect, it } from 'vitest';
import { ContentHasher } from '../hash';

describe('ContentHasher', () => {
  describe('hash', () => {
    it('should generate consistent hash for the same content', async () => {
      const content = 'Hello, world!';
      const hash1 = await ContentHasher.hash(content);
      const hash2 = await ContentHasher.hash(content);

      expect(hash1).toBe(hash2);
    });

    it('should generate different hashes for different content', async () => {
      const hash1 = await ContentHasher.hash('Hello, world!');
      const hash2 = await ContentHasher.hash('Goodbye, world!');

      expect(hash1).not.toBe(hash2);
    });

    it('should generate 64-character hex string (SHA-256)', async () => {
      const hash = await ContentHasher.hash('test');

      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });

    it('should handle empty string', async () => {
      const hash = await ContentHasher.hash('');

      expect(hash).toHaveLength(64);
      // SHA-256 of empty string
      expect(hash).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
    });

    it('should handle unicode content', async () => {
      const hash = await ContentHasher.hash('日本語テスト');

      expect(hash).toHaveLength(64);
    });

    it('should handle multiline content', async () => {
      const content = `Line 1
Line 2
Line 3`;
      const hash = await ContentHasher.hash(content);

      expect(hash).toHaveLength(64);
    });

    it('should be case-sensitive', async () => {
      const hash1 = await ContentHasher.hash('ABC');
      const hash2 = await ContentHasher.hash('abc');

      expect(hash1).not.toBe(hash2);
    });

    it('should distinguish whitespace differences', async () => {
      const hash1 = await ContentHasher.hash('hello world');
      const hash2 = await ContentHasher.hash('hello  world');

      expect(hash1).not.toBe(hash2);
    });
  });
});
