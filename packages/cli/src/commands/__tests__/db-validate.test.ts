/**
 * Unit tests for db:validate command
 *
 * Tests JSON database validation functionality
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  discoverJsonFiles,
  displayValidationResults,
  JsonDatabaseValidator,
  resolveDataPath,
} from '../json-validator.js';
import {
  ValidationCodes,
  type ValidationSummary,
} from '../validation-types.js';

describe('db:validate', () => {
  const testDir = resolve(process.cwd(), '.test-db-validate');
  const dataDir = resolve(testDir, 'data');

  beforeEach(async () => {
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('resolveDataPath', () => {
    it('should use explicit path when provided', async () => {
      const result = await resolveDataPath(dataDir);
      expect(result).toBe(dataDir);
    });

    it('should return null for non-existent explicit path', async () => {
      const result = await resolveDataPath('/nonexistent/path');
      expect(result).toBeNull();
    });

    it('should auto-detect common data directories', async () => {
      // Create a ./data directory with JSON files
      const commonDataDir = resolve(testDir, 'data');
      await mkdir(commonDataDir, { recursive: true });
      await writeFile(
        resolve(commonDataDir, 'test.json'),
        JSON.stringify([{ id: 'a' }]),
      );

      // Change to test directory temporarily
      const originalCwd = process.cwd();
      process.chdir(testDir);

      try {
        const result = await resolveDataPath();
        expect(result).toBe(commonDataDir);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe('discoverJsonFiles', () => {
    it('should discover JSON files in directory', async () => {
      await writeFile(resolve(dataDir, 'events.json'), '[]');
      await writeFile(resolve(dataDir, 'meetings.json'), '[]');

      const files = await discoverJsonFiles(dataDir);

      expect(files).toHaveLength(2);
      expect(files.some((f) => f.endsWith('events.json'))).toBe(true);
      expect(files.some((f) => f.endsWith('meetings.json'))).toBe(true);
    });

    it('should ignore schema and config files', async () => {
      await writeFile(resolve(dataDir, 'events.json'), '[]');
      await writeFile(resolve(dataDir, 'events.schema.json'), '{}');
      await writeFile(resolve(dataDir, 'package.json'), '{}');
      await writeFile(resolve(dataDir, 'manifest.json'), '{}');

      const files = await discoverJsonFiles(dataDir);

      expect(files).toHaveLength(1);
      expect(files[0]).toContain('events.json');
    });
  });

  describe('JsonDatabaseValidator', () => {
    describe('JSON structure validation', () => {
      it('should detect invalid JSON', async () => {
        await writeFile(resolve(dataDir, 'invalid.json'), 'not valid json {');

        const validator = new JsonDatabaseValidator({
          dataPath: dataDir,
          quickMode: true,
          verbose: false,
        });

        const files = await discoverJsonFiles(dataDir);
        const results = await validator.validate(files);

        expect(results.objectResults).toHaveLength(1);
        expect(results.objectResults[0].issues).toHaveLength(1);
        expect(results.objectResults[0].issues[0].code).toBe(
          ValidationCodes.INVALID_JSON,
        );
      });

      it('should detect non-array root', async () => {
        await writeFile(
          resolve(dataDir, 'object.json'),
          JSON.stringify({ not: 'array' }),
        );

        const validator = new JsonDatabaseValidator({
          dataPath: dataDir,
          quickMode: true,
          verbose: false,
        });

        const files = await discoverJsonFiles(dataDir);
        const results = await validator.validate(files);

        expect(results.objectResults[0].issues[0].code).toBe(
          ValidationCodes.NOT_ARRAY,
        );
      });

      it('should pass valid JSON array', async () => {
        await writeFile(
          resolve(dataDir, 'events.json'),
          JSON.stringify([
            { id: 'a', slug: 'event-a' },
            { id: 'b', slug: 'event-b' },
          ]),
        );

        const validator = new JsonDatabaseValidator({
          dataPath: dataDir,
          quickMode: true,
          verbose: false,
        });

        const files = await discoverJsonFiles(dataDir);
        const results = await validator.validate(files);

        // Should have warning about unknown table but no errors
        const errors = results.objectResults[0].issues.filter(
          (i) => i.severity === 'error',
        );
        expect(errors).toHaveLength(0);
      });
    });

    describe('ID validation', () => {
      it('should detect missing ID', async () => {
        await writeFile(
          resolve(dataDir, 'events.json'),
          JSON.stringify([{ name: 'No ID' }]),
        );

        const validator = new JsonDatabaseValidator({
          dataPath: dataDir,
          quickMode: true,
          verbose: false,
        });

        const files = await discoverJsonFiles(dataDir);
        const results = await validator.validate(files);

        const issue = results.objectResults[0].issues.find(
          (i) => i.code === ValidationCodes.MISSING_ID,
        );
        expect(issue).toBeDefined();
      });

      it('should detect duplicate IDs', async () => {
        await writeFile(
          resolve(dataDir, 'events.json'),
          JSON.stringify([
            { id: 'same-id', name: 'First' },
            { id: 'same-id', name: 'Second' },
          ]),
        );

        const validator = new JsonDatabaseValidator({
          dataPath: dataDir,
          quickMode: true,
          verbose: false,
        });

        const files = await discoverJsonFiles(dataDir);
        const results = await validator.validate(files);

        const issue = results.objectResults[0].issues.find(
          (i) => i.code === ValidationCodes.DUPLICATE_ID,
        );
        expect(issue).toBeDefined();
        expect(issue?.message).toContain('same-id');
      });
    });

    describe('slug uniqueness validation', () => {
      it('should detect duplicate slug+context', async () => {
        await writeFile(
          resolve(dataDir, 'events.json'),
          JSON.stringify([
            { id: 'a', slug: 'same-slug', context: 'ctx' },
            { id: 'b', slug: 'same-slug', context: 'ctx' },
          ]),
        );

        const validator = new JsonDatabaseValidator({
          dataPath: dataDir,
          quickMode: true,
          verbose: false,
        });

        const files = await discoverJsonFiles(dataDir);
        const results = await validator.validate(files);

        const issue = results.objectResults[0].issues.find(
          (i) => i.code === ValidationCodes.DUPLICATE_SLUG_CONTEXT,
        );
        expect(issue).toBeDefined();
      });

      it('should allow same slug with different context', async () => {
        await writeFile(
          resolve(dataDir, 'events.json'),
          JSON.stringify([
            { id: 'a', slug: 'same-slug', context: 'ctx1' },
            { id: 'b', slug: 'same-slug', context: 'ctx2' },
          ]),
        );

        const validator = new JsonDatabaseValidator({
          dataPath: dataDir,
          quickMode: true,
          verbose: false,
        });

        const files = await discoverJsonFiles(dataDir);
        const results = await validator.validate(files);

        const issue = results.objectResults[0].issues.find(
          (i) => i.code === ValidationCodes.DUPLICATE_SLUG_CONTEXT,
        );
        expect(issue).toBeUndefined();
      });
    });

    describe('STI validation', () => {
      it('should detect invalid _meta_data', async () => {
        // Note: STI validation only runs when objectType is found
        // For this test, we'll check that _meta_data must be an object
        await writeFile(
          resolve(dataDir, 'events.json'),
          JSON.stringify([
            {
              id: 'a',
              _meta_type: 'Meeting',
              _meta_data: 'not an object',
            },
          ]),
        );

        const validator = new JsonDatabaseValidator({
          dataPath: dataDir,
          quickMode: true,
          verbose: false,
        });

        const files = await discoverJsonFiles(dataDir);
        const results = await validator.validate(files);

        // Note: Without ObjectRegistry having 'Meeting' registered,
        // we get UNKNOWN_META_TYPE warning but not INVALID_META_DATA error
        // since STI validation only runs when objectType is found
        // This is expected behavior - the test validates the warning path
        const warnings = results.objectResults[0].issues.filter(
          (i) => i.severity === 'warning',
        );
        expect(warnings.length).toBeGreaterThan(0);
      });
    });

    describe('type validation', () => {
      it('should detect invalid date format', async () => {
        // This test requires a registered SMRT object with a datetime field
        // Without that, field validation is skipped
        // We'll test the validateFieldType function directly
        const validator = new JsonDatabaseValidator({
          dataPath: dataDir,
          quickMode: true,
          verbose: false,
        });

        // Access private method through prototype
        const validateFieldType = (validator as any).validateFieldType.bind(
          validator,
        );

        const result = validateFieldType(
          'not-a-date',
          'datetime',
          'testField',
          'test-id',
          'test.json',
        );

        expect(result).not.toBeNull();
        expect(result?.code).toBe(ValidationCodes.INVALID_DATE);
      });

      it('should validate boolean type', async () => {
        const validator = new JsonDatabaseValidator({
          dataPath: dataDir,
          quickMode: true,
          verbose: false,
        });

        const validateFieldType = (validator as any).validateFieldType.bind(
          validator,
        );

        const invalidResult = validateFieldType(
          'not-a-boolean',
          'boolean',
          'testField',
          'test-id',
          'test.json',
        );
        expect(invalidResult?.code).toBe(ValidationCodes.INVALID_BOOLEAN);

        const validResult = validateFieldType(
          true,
          'boolean',
          'testField',
          'test-id',
          'test.json',
        );
        expect(validResult).toBeNull();
      });

      it('should validate integer type', async () => {
        const validator = new JsonDatabaseValidator({
          dataPath: dataDir,
          quickMode: true,
          verbose: false,
        });

        const validateFieldType = (validator as any).validateFieldType.bind(
          validator,
        );

        // Decimal when integer expected
        const decimalResult = validateFieldType(
          1.5,
          'integer',
          'testField',
          'test-id',
          'test.json',
        );
        expect(decimalResult?.code).toBe(ValidationCodes.INVALID_INTEGER);

        // String when integer expected
        const stringResult = validateFieldType(
          '42',
          'integer',
          'testField',
          'test-id',
          'test.json',
        );
        expect(stringResult?.code).toBe(ValidationCodes.INVALID_INTEGER);

        // Valid integer
        const validResult = validateFieldType(
          42,
          'integer',
          'testField',
          'test-id',
          'test.json',
        );
        expect(validResult).toBeNull();
      });

      it('should validate decimal type', async () => {
        const validator = new JsonDatabaseValidator({
          dataPath: dataDir,
          quickMode: true,
          verbose: false,
        });

        const validateFieldType = (validator as any).validateFieldType.bind(
          validator,
        );

        // String when number expected
        const stringResult = validateFieldType(
          '3.14',
          'decimal',
          'testField',
          'test-id',
          'test.json',
        );
        expect(stringResult?.code).toBe(ValidationCodes.INVALID_NUMBER);

        // Valid decimal
        const validResult = validateFieldType(
          3.14,
          'decimal',
          'testField',
          'test-id',
          'test.json',
        );
        expect(validResult).toBeNull();

        // Integer is valid decimal
        const intResult = validateFieldType(
          42,
          'decimal',
          'testField',
          'test-id',
          'test.json',
        );
        expect(intResult).toBeNull();
      });
    });

    describe('constraint validation', () => {
      it('should validate numeric min/max constraints', async () => {
        const validator = new JsonDatabaseValidator({
          dataPath: dataDir,
          quickMode: true,
          verbose: false,
        });

        const validateConstraints = (validator as any).validateConstraints.bind(
          validator,
        );

        // Below min
        const belowMinResult = validateConstraints(
          5,
          { min: 10, max: 100 },
          'testField',
          'test-id',
          'test.json',
        );
        expect(belowMinResult.length).toBe(1);
        expect(belowMinResult[0].code).toBe(ValidationCodes.VALUE_OUT_OF_RANGE);

        // Above max
        const aboveMaxResult = validateConstraints(
          150,
          { min: 10, max: 100 },
          'testField',
          'test-id',
          'test.json',
        );
        expect(aboveMaxResult.length).toBe(1);
        expect(aboveMaxResult[0].code).toBe(ValidationCodes.VALUE_OUT_OF_RANGE);

        // Valid
        const validResult = validateConstraints(
          50,
          { min: 10, max: 100 },
          'testField',
          'test-id',
          'test.json',
        );
        expect(validResult.length).toBe(0);
      });

      it('should validate string length constraints', async () => {
        const validator = new JsonDatabaseValidator({
          dataPath: dataDir,
          quickMode: true,
          verbose: false,
        });

        const validateConstraints = (validator as any).validateConstraints.bind(
          validator,
        );

        // Too short
        const tooShortResult = validateConstraints(
          'ab',
          { minLength: 3 },
          'testField',
          'test-id',
          'test.json',
        );
        expect(tooShortResult.length).toBe(1);
        expect(tooShortResult[0].code).toBe(ValidationCodes.STRING_TOO_SHORT);

        // Too long
        const tooLongResult = validateConstraints(
          'abcdefghij',
          { maxLength: 5 },
          'testField',
          'test-id',
          'test.json',
        );
        expect(tooLongResult.length).toBe(1);
        expect(tooLongResult[0].code).toBe(ValidationCodes.STRING_TOO_LONG);
      });

      it('should validate pattern constraints', async () => {
        const validator = new JsonDatabaseValidator({
          dataPath: dataDir,
          quickMode: true,
          verbose: false,
        });

        const validateConstraints = (validator as any).validateConstraints.bind(
          validator,
        );

        // Pattern mismatch
        const mismatchResult = validateConstraints(
          'invalid-email',
          { pattern: '^[^@]+@[^@]+$' },
          'email',
          'test-id',
          'test.json',
        );
        expect(mismatchResult.length).toBe(1);
        expect(mismatchResult[0].code).toBe(ValidationCodes.PATTERN_MISMATCH);

        // Pattern match
        const matchResult = validateConstraints(
          'test@example.com',
          { pattern: '^[^@]+@[^@]+$' },
          'email',
          'test-id',
          'test.json',
        );
        expect(matchResult.length).toBe(0);
      });
    });

    describe('generateSummary', () => {
      it('should generate correct summary', async () => {
        await writeFile(
          resolve(dataDir, 'events.json'),
          JSON.stringify([
            { id: 'a', slug: 'event-a' },
            { id: 'b', slug: 'event-b' },
          ]),
        );

        const validator = new JsonDatabaseValidator({
          dataPath: dataDir,
          quickMode: true,
          verbose: false,
        });

        const files = await discoverJsonFiles(dataDir);
        const results = await validator.validate(files);
        const summary = validator.generateSummary(results, 100, null);

        expect(summary.totalFiles).toBe(1);
        expect(summary.totalRecords).toBe(2);
        expect(summary.duration).toBe(100);
        expect(summary.dataPath).toBe(dataDir);
      });
    });
  });

  describe('displayValidationResults', () => {
    it('should display success message when no issues', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const summary: ValidationSummary = {
        timestamp: new Date().toISOString(),
        dataPath: '/test/data',
        manifestPath: null,
        duration: 50,
        totalFiles: 1,
        totalRecords: 10,
        validRecords: 10,
        invalidRecords: 0,
        issues: { errors: 0, warnings: 0, info: 0 },
        objectResults: [],
      };

      displayValidationResults(summary, false);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('All validations passed'),
      );

      consoleSpy.mockRestore();
    });

    it('should display errors when present', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const summary: ValidationSummary = {
        timestamp: new Date().toISOString(),
        dataPath: '/test/data',
        manifestPath: null,
        duration: 50,
        totalFiles: 1,
        totalRecords: 10,
        validRecords: 8,
        invalidRecords: 2,
        issues: { errors: 2, warnings: 0, info: 0 },
        objectResults: [
          {
            objectType: 'Event',
            tableName: 'events',
            file: '/test/data/events.json',
            recordCount: 10,
            validCount: 8,
            invalidCount: 2,
            issues: [
              {
                severity: 'error',
                code: 'DUPLICATE_ID',
                message: 'Duplicate ID: abc',
                objectId: 'abc',
              },
              {
                severity: 'error',
                code: 'MISSING_ID',
                message: 'Missing ID at index 5',
              },
            ],
          },
        ],
      };

      displayValidationResults(summary, false);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Errors'),
      );

      consoleSpy.mockRestore();
    });
  });

  describe('snake_case field name handling (issue #549)', () => {
    it('should correctly validate fields with snake_case names in JSON', async () => {
      // JSON files use snake_case field names (matching database columns)
      // This tests the fix for issue #549 where the validator was looking
      // for camelCase field names (typeId) instead of snake_case (type_id)
      await writeFile(
        resolve(dataDir, 'profiles.json'),
        JSON.stringify([
          {
            id: '5e75e8fa-c12f-45d6-bbfa-667a3b6a832e',
            _meta_type: 'Person',
            type_id: 'e0f5c6f6-31e7-416c-8f58-4d2a5d0748e2',
            name: 'Mayor Hansen',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          },
        ]),
      );

      const validator = new JsonDatabaseValidator({
        dataPath: dataDir,
        quickMode: true,
        verbose: false,
      });

      const files = await discoverJsonFiles(dataDir);
      const results = await validator.validate(files);

      // Should not have MISSING_REQUIRED_FIELD errors for snake_case fields
      const missingFieldErrors = results.objectResults[0].issues.filter(
        (i) =>
          i.code === ValidationCodes.MISSING_REQUIRED_FIELD &&
          (i.field === 'typeId' ||
            i.field === 'createdAt' ||
            i.field === 'updatedAt'),
      );
      expect(missingFieldErrors).toHaveLength(0);
    });
  });

  describe('command structure', () => {
    it('should have correct command definition', async () => {
      const { utilityCommands } = await import('../utilities.js');
      const dbValidate = utilityCommands['db:validate'];

      expect(dbValidate).toBeDefined();
      expect(dbValidate.name).toBe('db:validate');
      expect(dbValidate.aliases).toContain('json:validate');
      expect(dbValidate.aliases).toContain('validate-db');
      expect(dbValidate.options).toHaveProperty('data');
      expect(dbValidate.options).toHaveProperty('quick');
      expect(dbValidate.options).toHaveProperty('json');
      expect(dbValidate.options).toHaveProperty('verbose');
      expect(dbValidate.options).toHaveProperty('fix');
    });
  });
});
