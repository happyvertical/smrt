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

  describe('Database Requirement Validation', () => {
    it('should allow initialization without database when not required', async () => {
      // Base SmrtClass doesn't require database by default
      const base = new SmrtClass({});

      // Should initialize successfully without database
      await expect((base as any).initialize()).resolves.toBeDefined();
    });

    it('should throw error when database required but not provided', async () => {
      // Create subclass that requires database
      class DatabaseRequiredClass extends SmrtClass {
        protected requiresDatabase(): boolean {
          return true;
        }
      }

      const instance = new DatabaseRequiredClass({});

      // Should throw clear error about missing database
      await expect((instance as any).initialize()).rejects.toThrow(
        /requires a database configuration/,
      );
      await expect((instance as any).initialize()).rejects.toThrow(
        /DatabaseRequiredClass/,
      );
    });

    it('should initialize successfully when database is provided and required', async () => {
      class DatabaseRequiredClass extends SmrtClass {
        protected requiresDatabase(): boolean {
          return true;
        }
      }

      const instance = new DatabaseRequiredClass({
        db: ':memory:', // Provide in-memory database
      });

      // Should initialize successfully with database provided
      await expect((instance as any).initialize()).resolves.toBeDefined();
    });

    it('should have requiresDatabase() return false by default', () => {
      const base = new SmrtClass({});
      expect((base as any).requiresDatabase()).toBe(false);
    });

    it('should allow subclasses to override requiresDatabase()', () => {
      class CustomClass extends SmrtClass {
        protected requiresDatabase(): boolean {
          return true;
        }
      }

      const instance = new CustomClass({});
      expect((instance as any).requiresDatabase()).toBe(true);
    });
  });
});
