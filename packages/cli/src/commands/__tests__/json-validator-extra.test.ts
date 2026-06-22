/**
 * Additional unit tests for the JSON database validator.
 *
 * Extends db-validate.test.ts to cover the registry-dependent integration
 * paths: table→class resolution (exact + singular), STI discriminator checks,
 * field-type validation through the manifest field loop, cross-file foreign-key
 * validation, applyFixes, and the detailed displayValidationResults output.
 *
 * SMRT classes are registered into the real ObjectRegistry via
 * registerFromManifest (no mocking of the registry for the resolution/type/FK
 * paths). For the required-field/default paths the validator reads
 * top-level `required`/`default` on the field def, which the manifest loader
 * nests under `_meta`; those few tests feed a crafted field map by spying on
 * ObjectRegistry.getFields so the auto-fix default can be exercised. The
 * filesystem is real (temp dir); nothing about validation is mocked.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  displayValidationResults,
  JsonDatabaseValidator,
} from '../json-validator.js';
import {
  ValidationCodes,
  type ValidationSummary,
} from '../validation-types.js';

describe('JsonDatabaseValidator integration paths', () => {
  const testDir = resolve(
    process.cwd(),
    `.test-json-validator-${randomUUID()}`,
  );
  const dataDir = resolve(testDir, 'data');

  // Unique suffix so registry entries from one run never collide with another.
  const suffix = randomUUID()
    .slice(0, 6)
    .replace(/[^a-z]/gi, 'x');
  const eventClass = `Evt${suffix}`;
  const eventTable = `${eventClass.toLowerCase()}s`;
  const personClass = `Prsn${suffix}`;
  const personTable = `${personClass.toLowerCase()}s`;

  beforeEach(async () => {
    await mkdir(dataDir, { recursive: true });

    ObjectRegistry.registerFromManifest(
      personClass,
      {
        className: personClass,
        decoratorConfig: { tableName: personTable },
        fields: { name: { type: 'text' } },
      },
      '@test/json-validator',
    );

    ObjectRegistry.registerFromManifest(
      eventClass,
      {
        className: eventClass,
        decoratorConfig: { tableName: eventTable, tableStrategy: 'sti' },
        fields: {
          title: { type: 'text' },
          attendees: { type: 'integer' },
          organizerId: { type: 'foreignKey', related: personClass },
        },
      },
      '@test/json-validator',
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  function newValidator(quickMode = false, verbose = false) {
    return new JsonDatabaseValidator({ dataPath: dataDir, quickMode, verbose });
  }

  it('resolves a table to its registered class and validates field types', async () => {
    await writeFile(
      resolve(dataDir, `${eventTable}.json`),
      JSON.stringify([
        {
          id: 'e1',
          _meta_type: eventClass,
          title: 'Launch',
          attendees: 'not-a-number',
        },
      ]),
    );

    const validator = newValidator(true);
    const results = await validator.validate([
      resolve(dataDir, `${eventTable}.json`),
    ]);

    const result = results.objectResults[0];
    expect(result.objectType).toBe(eventClass);
    const typeErr = result.issues.find(
      (i) => i.code === ValidationCodes.INVALID_INTEGER,
    );
    expect(typeErr).toBeDefined();
  });

  it('warns on an unknown STI _meta_type and missing discriminator', async () => {
    await writeFile(
      resolve(dataDir, `${eventTable}.json`),
      JSON.stringify([
        { id: 'e1', title: 'No discriminator' },
        { id: 'e2', _meta_type: 'TotallyUnknownType', title: 'Bad type' },
        { id: 'e3', _meta_type: 42, title: 'Numeric type' },
      ]),
    );

    const validator = newValidator(true);
    const results = await validator.validate([
      resolve(dataDir, `${eventTable}.json`),
    ]);

    const issues = results.objectResults[0].issues;
    expect(
      issues.some((i) => i.code === ValidationCodes.MISSING_META_TYPE),
    ).toBe(true);
    expect(
      issues.some((i) => i.code === ValidationCodes.UNKNOWN_META_TYPE),
    ).toBe(true);
    expect(issues.some((i) => i.code === ValidationCodes.INVALID_TYPE)).toBe(
      true,
    );
  });

  it('flags invalid _meta_data that is not an object', async () => {
    await writeFile(
      resolve(dataDir, `${eventTable}.json`),
      JSON.stringify([
        { id: 'e1', _meta_type: eventClass, _meta_data: ['array', 'bad'] },
      ]),
    );

    const validator = newValidator(true);
    const results = await validator.validate([
      resolve(dataDir, `${eventTable}.json`),
    ]);

    expect(
      results.objectResults[0].issues.some(
        (i) => i.code === ValidationCodes.INVALID_META_DATA,
      ),
    ).toBe(true);
  });

  it('resolves a plural table name to a singular class name', async () => {
    // personTable already ends in 's'; the table is registered with that exact
    // name so the exact-match branch wins. Here we additionally confirm the
    // singular fallback by querying a table whose registered name is singular.
    ObjectRegistry.registerFromManifest(
      `Foo${suffix}`,
      {
        className: `Foo${suffix}`,
        // Registered table name is the singular class name lowercased.
        decoratorConfig: { tableName: `foo${suffix}`.toLowerCase() },
        fields: { name: { type: 'text' } },
      },
      '@test/json-validator',
    );

    await writeFile(
      resolve(dataDir, `foo${suffix}s.json`.toLowerCase()),
      JSON.stringify([{ id: 'a' }]),
    );

    const validator = newValidator(true);
    const results = await validator.validate([
      resolve(dataDir, `foo${suffix}s.json`.toLowerCase()),
    ]);

    expect(results.objectResults[0].objectType).toBe(`Foo${suffix}`);
  });

  it('validates foreign keys across files (full mode)', async () => {
    await writeFile(
      resolve(dataDir, `${personTable}.json`),
      JSON.stringify([{ id: 'p1', name: 'Alice' }]),
    );
    await writeFile(
      resolve(dataDir, `${eventTable}.json`),
      JSON.stringify([
        { id: 'e1', _meta_type: eventClass, organizer_id: 'p1' },
        { id: 'e2', _meta_type: eventClass, organizer_id: 'missing-person' },
      ]),
    );

    const validator = newValidator(false); // full mode → FK validation
    const results = await validator.validate([
      resolve(dataDir, `${personTable}.json`),
      resolve(dataDir, `${eventTable}.json`),
    ]);

    const eventResult = results.objectResults.find(
      (r) => r.tableName === eventTable,
    );
    const fkError = eventResult?.issues.find(
      (i) => i.code === ValidationCodes.INVALID_FOREIGN_KEY,
    );
    expect(fkError).toBeDefined();
    expect(fkError?.message).toContain('missing-person');
    // The bad-FK record was downgraded from valid → invalid.
    expect(eventResult?.invalidCount).toBeGreaterThan(0);
  });

  it('reports a missing FK table file in full mode', async () => {
    // Only the event file exists; the related person table file is absent.
    await writeFile(
      resolve(dataDir, `${eventTable}.json`),
      JSON.stringify([
        { id: 'e1', _meta_type: eventClass, organizer_id: 'p1' },
      ]),
    );

    const validator = newValidator(false);
    const results = await validator.validate([
      resolve(dataDir, `${eventTable}.json`),
    ]);

    expect(
      results.objectResults[0].issues.some(
        (i) => i.code === ValidationCodes.MISSING_FK_TABLE,
      ),
    ).toBe(true);
  });

  it('logs pre-load failures in verbose mode without throwing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await writeFile(
      resolve(dataDir, `${eventTable}.json`),
      'this is not valid json',
    );

    const validator = newValidator(false, true); // verbose
    const results = await validator.validate([
      resolve(dataDir, `${eventTable}.json`),
    ]);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[verbose] Failed to pre-load'),
    );
    expect(
      results.objectResults[0].issues.some(
        (i) => i.code === ValidationCodes.INVALID_JSON,
      ),
    ).toBe(true);
  });

  it('detects records that are not objects', async () => {
    await writeFile(
      resolve(dataDir, `${eventTable}.json`),
      JSON.stringify(['a string', 42, null]),
    );

    const validator = newValidator(true);
    const results = await validator.validate([
      resolve(dataDir, `${eventTable}.json`),
    ]);

    const emptyObjectIssues = results.objectResults[0].issues.filter(
      (i) => i.code === ValidationCodes.EMPTY_OBJECT,
    );
    expect(emptyObjectIssues.length).toBe(3);
  });

  it('detects non-string and missing IDs', async () => {
    await writeFile(
      resolve(dataDir, `${eventTable}.json`),
      JSON.stringify([{ id: 123 }, { name: 'no id' }]),
    );

    const validator = newValidator(true);
    const results = await validator.validate([
      resolve(dataDir, `${eventTable}.json`),
    ]);

    const issues = results.objectResults[0].issues;
    expect(
      issues.some((i) => i.code === ValidationCodes.INVALID_ID_FORMAT),
    ).toBe(true);
    expect(issues.some((i) => i.code === ValidationCodes.MISSING_ID)).toBe(
      true,
    );
  });
});

describe('JsonDatabaseValidator required-field auto-fix', () => {
  const testDir = resolve(process.cwd(), `.test-jv-fix-${randomUUID()}`);
  const dataDir = resolve(testDir, 'data');

  beforeEach(async () => {
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  // The validator reads `required`/`default` at the top level of the field
  // definition, while the manifest loader nests them under `_meta`. Feed a
  // crafted field map directly so the required-field + auto-fix branches run.
  function stubFields(fields: Map<string, unknown>) {
    vi.spyOn(ObjectRegistry, 'getFields').mockReturnValue(
      fields as Map<string, any>,
    );
    // Resolve any table to a stable class name so getFields is consulted.
    vi.spyOn(ObjectRegistry, 'getAllClasses').mockReturnValue(
      new Map([['Fixable', { name: 'Fixable' } as any]]) as any,
    );
    vi.spyOn(ObjectRegistry, 'getTableName').mockReturnValue('fixables');
    vi.spyOn(ObjectRegistry, 'getTableStrategy').mockReturnValue('cti');
  }

  it('flags a missing required field as fixable during validation', async () => {
    stubFields(
      new Map<string, unknown>([
        ['status', { type: 'text', required: true, default: 'draft' }],
      ]),
    );

    const filePath = resolve(dataDir, 'fixables.json');
    await writeFile(filePath, JSON.stringify([{ id: 'a' }]));

    const validator = new JsonDatabaseValidator({
      dataPath: dataDir,
      quickMode: true,
      verbose: false,
    });

    const results = await validator.validate([filePath]);
    const fixable = results.fixableIssues.find(
      (i) => i.code === ValidationCodes.MISSING_REQUIRED_FIELD,
    );
    expect(fixable).toBeDefined();
    expect(fixable?.fixable).toBe(true);
  });

  it('applyFixes applies a default value to an id-matched record', async () => {
    // applyFixes re-reads the field definition by issue.objectType, so the
    // crafted issue carries objectType + field; getFields is stubbed to expose
    // the default. (validateField does not set objectType on the issue, so we
    // construct the fixable issue directly to drive the apply path.)
    stubFields(
      new Map<string, unknown>([
        ['status', { type: 'text', required: true, default: 'draft' }],
      ]),
    );

    const filePath = resolve(dataDir, 'fixables.json');
    await writeFile(filePath, JSON.stringify([{ id: 'a' }]));

    const validator = new JsonDatabaseValidator({
      dataPath: dataDir,
      quickMode: true,
      verbose: false,
    });

    const fixed = await validator.applyFixes([
      {
        severity: 'error',
        code: ValidationCodes.MISSING_REQUIRED_FIELD,
        message: 'Missing required field: status',
        file: filePath,
        objectId: 'a',
        objectType: 'Fixable',
        field: 'status',
        fixable: true,
      },
    ]);
    expect(fixed).toBe(1);

    const written = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(written[0].status).toBe('draft');
  });

  it('applyFixes resolves an index-only record via the [index:N] objectId', async () => {
    stubFields(
      new Map<string, unknown>([
        ['status', { type: 'text', required: true, default: 'open' }],
      ]),
    );

    const filePath = resolve(dataDir, 'fixables.json');
    await writeFile(filePath, JSON.stringify([{ name: 'no-id' }]));

    const validator = new JsonDatabaseValidator({
      dataPath: dataDir,
      quickMode: true,
      verbose: false,
    });

    const fixed = await validator.applyFixes([
      {
        severity: 'error',
        code: ValidationCodes.MISSING_REQUIRED_FIELD,
        message: 'Missing required field: status',
        file: filePath,
        objectId: '[index:0]',
        objectType: 'Fixable',
        field: 'status',
        fixable: true,
      },
    ]);
    expect(fixed).toBe(1);

    const written = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(written[0].status).toBe('open');
  });

  it('applyFixes logs and continues when a file cannot be read (verbose)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const validator = new JsonDatabaseValidator({
      dataPath: dataDir,
      quickMode: true,
      verbose: true,
    });

    const fixed = await validator.applyFixes([
      {
        severity: 'error',
        code: ValidationCodes.MISSING_REQUIRED_FIELD,
        message: 'Missing required field: status',
        file: resolve(dataDir, 'does-not-exist.json'),
        objectId: 'a',
        objectType: 'Fixable',
        field: 'status',
        fixable: true,
      },
    ]);

    expect(fixed).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[verbose] Failed to apply fixes'),
    );
  });
});

describe('displayValidationResults detail output', () => {
  it('renders per-object errors and warnings with truncation note', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const manyErrors = Array.from({ length: 7 }, (_, i) => ({
      severity: 'error' as const,
      code: 'DUP',
      message: `Error ${i}`,
      objectId: `id-${i}`,
    }));
    const manyWarnings = Array.from({ length: 5 }, (_, i) => ({
      severity: 'warning' as const,
      code: 'WARN',
      message: `Warning ${i}`,
    }));

    const summary: ValidationSummary = {
      timestamp: new Date().toISOString(),
      dataPath: '/d',
      manifestPath: '/manifest.json',
      duration: 10,
      totalFiles: 1,
      totalRecords: 12,
      validRecords: 5,
      invalidRecords: 7,
      issues: { errors: 7, warnings: 5, info: 0 },
      objectResults: [
        {
          objectType: 'Event',
          tableName: 'events',
          file: '/d/events.json',
          recordCount: 12,
          validCount: 5,
          invalidCount: 7,
          issues: [...manyErrors, ...manyWarnings],
        },
        {
          objectType: 'Empty',
          tableName: 'empty',
          file: '/d/empty.json',
          recordCount: 0,
          validCount: 0,
          invalidCount: 0,
          issues: [],
        },
      ],
    };

    displayValidationResults(summary, false);

    const out = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).toContain('Manifest:');
    expect(out).toContain('Issues by Object Type');
    expect(out).toContain('and 2 more errors'); // 7 errors, 5 shown
    expect(out).toContain('and 2 more warnings'); // 5 warnings, 3 shown

    logSpy.mockRestore();
  });

  it('shows all issues in verbose mode (no truncation)', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const summary: ValidationSummary = {
      timestamp: new Date().toISOString(),
      dataPath: '/d',
      manifestPath: null,
      duration: 10,
      totalFiles: 1,
      totalRecords: 6,
      validRecords: 0,
      invalidRecords: 6,
      issues: { errors: 6, warnings: 0, info: 0 },
      objectResults: [
        {
          objectType: 'Event',
          tableName: 'events',
          file: '/d/events.json',
          recordCount: 6,
          validCount: 0,
          invalidCount: 6,
          issues: Array.from({ length: 6 }, (_, i) => ({
            severity: 'error' as const,
            code: 'E',
            message: `Error ${i}`,
            objectId: `id-${i}`,
          })),
        },
      ],
    };

    displayValidationResults(summary, true);

    const out = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(out).not.toContain('more errors');
    logSpy.mockRestore();
  });
});
