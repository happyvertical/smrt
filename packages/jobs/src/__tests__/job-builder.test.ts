import { describe, expect, it } from 'vitest';
import { type Priority, parseDelay, priorityToNumber } from '../job-builder.js';

describe('JobBuilder utilities', () => {
  describe('priorityToNumber', () => {
    it('converts string priorities to correct numbers', () => {
      expect(priorityToNumber('critical')).toBe(100);
      expect(priorityToNumber('high')).toBe(75);
      expect(priorityToNumber('normal')).toBe(50);
      expect(priorityToNumber('low')).toBe(25);
    });

    it('passes through numeric priorities', () => {
      expect(priorityToNumber(10)).toBe(10);
      expect(priorityToNumber(99)).toBe(99);
    });
  });

  describe('parseDelay', () => {
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

    it('throws error for invalid format', () => {
      expect(() => parseDelay('invalid')).toThrow('Invalid delay format');
      expect(() => parseDelay('abc123')).toThrow('Invalid delay format');
    });

    it('defaults to milliseconds when no unit provided', () => {
      expect(parseDelay('500')).toBe(500);
    });
  });
});
