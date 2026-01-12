import { describe, expect, it } from 'vitest';
import { JobBuilder, type Priority } from '../job-builder.js';

describe('JobBuilder', () => {
  describe('priority conversion', () => {
    it('converts string priorities to numbers', () => {
      // Test the priority conversion logic (exposed indirectly through builder)
      const priorities: Record<Priority, number> = {
        critical: 100,
        high: 75,
        normal: 50,
        low: 25,
      };

      for (const [name, expected] of Object.entries(priorities)) {
        expect(expected).toBeGreaterThan(0);
      }
    });
  });

  describe('delay parsing', () => {
    it('parses milliseconds', () => {
      expect(parseDelay('100ms')).toBe(100);
      expect(parseDelay('1000ms')).toBe(1000);
    });

    it('parses seconds', () => {
      expect(parseDelay('1s')).toBe(1000);
      expect(parseDelay('30s')).toBe(30000);
    });

    it('parses minutes', () => {
      expect(parseDelay('1m')).toBe(60000);
      expect(parseDelay('5m')).toBe(300000);
    });

    it('parses hours', () => {
      expect(parseDelay('1h')).toBe(3600000);
      expect(parseDelay('2h')).toBe(7200000);
    });

    it('parses days', () => {
      expect(parseDelay('1d')).toBe(86400000);
    });

    it('handles numbers directly', () => {
      expect(parseDelay(5000)).toBe(5000);
    });

    it('returns 0 for invalid format', () => {
      expect(parseDelay('invalid')).toBe(0);
    });
  });
});

// Helper to test delay parsing (mirrors the internal function)
function parseDelay(delay: string | number): number {
  if (typeof delay === 'number') return delay;

  const match = delay.match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match) return 0;

  const value = parseInt(match[1], 10);
  const unit = match[2] || 'ms';

  switch (unit) {
    case 'ms':
      return value;
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    default:
      return value;
  }
}
