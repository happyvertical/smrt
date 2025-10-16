/**
 * Tests for SmrtClass functionality
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SmrtClass } from './class';

describe('SmrtClass', () => {
  describe('Construction', () => {
    it('should create a SmrtClass instance with default options', () => {
      const base = new SmrtClass({});

      expect(base).toBeInstanceOf(SmrtClass);
    });

    it('should create a SmrtClass instance with custom options', () => {
      const options = {
        db: { url: 'sqlite://custom.db' },
      };

      const base = new SmrtClass(options);

      expect(base).toBeInstanceOf(SmrtClass);
    });
  });

  describe('Service Access', () => {
    let baseClass: SmrtClass;

    beforeEach(() => {
      baseClass = new SmrtClass({});
    });

    it('should have service getter properties', () => {
      expect(baseClass).toHaveProperty('db');
      expect(baseClass).toHaveProperty('fs');
      expect(baseClass).toHaveProperty('ai');
    });
  });

  describe('Service Initialization', () => {
    it('should initialize services lazily', () => {
      const base = new SmrtClass({});

      // Services should be getter properties, not yet initialized
      expect(base).toHaveProperty('db');
      expect(base).toHaveProperty('fs');
      expect(base).toHaveProperty('ai');
    });
  });

  describe('Configuration Options', () => {
    it('should handle empty options object', () => {
      const base = new SmrtClass({});
      expect(base).toBeInstanceOf(SmrtClass);
    });

    it('should handle partial configuration', () => {
      const base = new SmrtClass({
        db: { url: 'sqlite://test.db' },
        // Other options omitted
      });

      expect(base).toBeInstanceOf(SmrtClass);
    });
  });
});
