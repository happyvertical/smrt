/**
 * Tests for CosineSimilarity
 */
import { describe, expect, it } from 'vitest';
import { CosineSimilarity } from '../similarity';

describe('CosineSimilarity', () => {
  describe('calculate', () => {
    it('should return 1 for identical vectors', () => {
      const vector = [1, 2, 3, 4, 5];
      const similarity = CosineSimilarity.calculate(vector, vector);

      expect(similarity).toBeCloseTo(1.0, 10);
    });

    it('should return 0 for orthogonal vectors', () => {
      const a = [1, 0];
      const b = [0, 1];
      const similarity = CosineSimilarity.calculate(a, b);

      expect(similarity).toBeCloseTo(0.0, 10);
    });

    it('should return -1 for opposite vectors', () => {
      const a = [1, 0];
      const b = [-1, 0];
      const similarity = CosineSimilarity.calculate(a, b);

      expect(similarity).toBeCloseTo(-1.0, 10);
    });

    it('should handle normalized vectors', () => {
      // Pre-normalized vectors (unit length)
      const a = [0.6, 0.8]; // length = 1
      const b = [0.8, 0.6]; // length = 1
      const similarity = CosineSimilarity.calculate(a, b);

      // cos(θ) = 0.6*0.8 + 0.8*0.6 = 0.96
      expect(similarity).toBeCloseTo(0.96, 10);
    });

    it('should handle high-dimensional vectors', () => {
      const dimensions = 768;
      const a = Array(dimensions)
        .fill(0)
        .map((_, i) => Math.sin(i));
      const b = Array(dimensions)
        .fill(0)
        .map((_, i) => Math.sin(i + 0.1));

      const similarity = CosineSimilarity.calculate(a, b);

      // Similar but not identical vectors should have high similarity
      expect(similarity).toBeGreaterThan(0.9);
      expect(similarity).toBeLessThan(1.0);
    });

    it('should throw error for mismatched dimensions', () => {
      const a = [1, 2, 3];
      const b = [1, 2];

      expect(() => CosineSimilarity.calculate(a, b)).toThrow(
        'Vector dimension mismatch',
      );
    });

    it('should handle zero vector', () => {
      const a = [0, 0, 0];
      const b = [1, 2, 3];
      const similarity = CosineSimilarity.calculate(a, b);

      // Zero vector has no direction, result should be 0
      expect(similarity).toBe(0);
    });

    it('should be symmetric', () => {
      const a = [1, 2, 3, 4];
      const b = [5, 6, 7, 8];

      const similarity1 = CosineSimilarity.calculate(a, b);
      const similarity2 = CosineSimilarity.calculate(b, a);

      expect(similarity1).toBeCloseTo(similarity2, 10);
    });

    it('should handle negative values', () => {
      const a = [-1, -2, -3];
      const b = [1, 2, 3];
      const similarity = CosineSimilarity.calculate(a, b);

      // Opposite direction
      expect(similarity).toBeCloseTo(-1.0, 10);
    });

    it('should handle floating point vectors', () => {
      const a = [0.1, 0.2, 0.3];
      const b = [0.1, 0.2, 0.3];
      const similarity = CosineSimilarity.calculate(a, b);

      expect(similarity).toBeCloseTo(1.0, 10);
    });

    it('should return 0 for empty vectors', () => {
      const similarity = CosineSimilarity.calculate([], []);
      expect(similarity).toBe(0);
    });
  });

  describe('rankBySimilarity', () => {
    it('should rank candidates by similarity', () => {
      const query = [1, 0, 0];
      const candidates = [
        { id: 'a', embedding: [0, 1, 0] },
        { id: 'b', embedding: [1, 0, 0] },
        { id: 'c', embedding: [0.5, 0.5, 0] },
      ];

      const results = CosineSimilarity.rankBySimilarity(query, candidates);

      expect(results[0].id).toBe('b'); // Most similar (same direction)
      expect(results[0].similarity).toBeCloseTo(1.0, 10);
      expect(results[1].id).toBe('c'); // Second most similar
      expect(results[2].id).toBe('a'); // Least similar (orthogonal)
      expect(results[2].similarity).toBeCloseTo(0.0, 10);
    });

    it('should handle empty candidates', () => {
      const query = [1, 0, 0];
      const results = CosineSimilarity.rankBySimilarity(query, []);

      expect(results).toEqual([]);
    });
  });

  describe('filterBySimilarity', () => {
    it('should filter by minimum similarity', () => {
      const query = [1, 0, 0];
      const candidates = [
        { id: 'a', embedding: [0, 1, 0] }, // similarity = 0
        { id: 'b', embedding: [1, 0, 0] }, // similarity = 1
        { id: 'c', embedding: [0.8, 0.6, 0] }, // similarity ≈ 0.8
      ];

      const results = CosineSimilarity.filterBySimilarity(
        query,
        candidates,
        0.5,
      );

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.id)).toContain('b');
      expect(results.map((r) => r.id)).toContain('c');
      expect(results.map((r) => r.id)).not.toContain('a');
    });

    it('should return sorted results', () => {
      const query = [1, 0, 0];
      const candidates = [
        { id: 'a', embedding: [0.8, 0.6, 0] },
        { id: 'b', embedding: [1, 0, 0] },
      ];

      const results = CosineSimilarity.filterBySimilarity(
        query,
        candidates,
        0.5,
      );

      expect(results[0].id).toBe('b'); // Higher similarity first
    });
  });
});
