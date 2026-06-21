/**
 * Branch coverage for the SMRT error system.
 *
 * errors.spec.ts already covers the common DatabaseError/ValidationError/AIError
 * factories, retry skip logic, sanitize, and JSON serialization. This file
 * targets the remaining surface:
 * - getPrimaryCauseMessage / collectErrorMessages cause-chain traversal
 *   (queryFailed deep-cause message folding, context.originalError, depth cap)
 * - the rarely-used static factories on every error class
 * - ConfigurationError / RuntimeError / FilesystemError / NetworkError families
 * - ValidationReport collection behavior
 * - ValidationUtils field/range/length/pattern helpers (incl. async + custom)
 */

import { describe, expect, it } from 'vitest';
import {
  AIError,
  ConfigurationError,
  DatabaseError,
  ErrorUtils,
  FilesystemError,
  NetworkError,
  RuntimeError,
  SmrtError,
  TenantIsolationError,
  ValidationError,
  ValidationReport,
  ValidationUtils,
} from './errors';

describe('DatabaseError deep-cause message folding (queryFailed)', () => {
  it('appends the deepest actionable cause message and records the chain', () => {
    const root = new Error('UNIQUE constraint failed: users.email');
    const wrapper = new Error('insert failed') as Error & { cause?: Error };
    wrapper.cause = root;

    const error = DatabaseError.queryFailed(
      'INSERT INTO users (email) VALUES (?)',
      wrapper,
    );

    // Message shows the last (deepest) collected message.
    expect(error.message).toContain(
      'Cause: UNIQUE constraint failed: users.email',
    );
    expect(error.details?.causeMessage).toBe(
      'UNIQUE constraint failed: users.email',
    );
    expect(error.details?.causeMessages).toEqual([
      'insert failed',
      'UNIQUE constraint failed: users.email',
    ]);
  });

  it('truncates queries longer than 100 chars with an ellipsis', () => {
    const longQuery = `SELECT ${'col, '.repeat(40)}1`;
    const error = DatabaseError.queryFailed(longQuery);

    expect(error.message).toContain('...');
    // No cause -> no "Cause:" suffix.
    expect(error.message).not.toContain('Cause:');
    expect(error.details?.causeMessage).toBeUndefined();
  });

  it('follows context.originalError and dedupes repeated messages', () => {
    const original = new Error('connection reset');
    const outer = new Error('connection reset') as Error & {
      context?: { originalError?: unknown };
    };
    outer.context = { originalError: original };

    const error = DatabaseError.queryFailed('SELECT 1', outer);

    // Both the outer message and the originalError message are identical, so
    // the deduped list collapses to a single entry.
    expect(error.details?.causeMessages).toEqual(['connection reset']);
  });

  it('returns no cause info when the cause chain has only blank messages', () => {
    const blank = new Error('   ');
    const error = DatabaseError.queryFailed('SELECT 1', blank);

    expect(error.details?.causeMessage).toBeUndefined();
    expect(error.message).not.toContain('Cause:');
  });

  it('stops traversing the cause chain beyond the depth cap', () => {
    // Build a chain deeper than the depth>10 guard; the deepest messages
    // beyond the cap must not appear in the collected list.
    let current = new Error('depth-0') as Error & { cause?: Error };
    const head = current;
    for (let i = 1; i <= 15; i++) {
      const next = new Error(`depth-${i}`) as Error & { cause?: Error };
      current.cause = next;
      current = next;
    }

    const error = DatabaseError.queryFailed('SELECT 1', head);
    const messages = error.details?.causeMessages as string[];

    expect(messages).toContain('depth-0');
    // The traversal halts once depth exceeds 10, so very deep nodes are absent.
    expect(messages).not.toContain('depth-15');
  });
});

describe('DatabaseError schema/STI factories', () => {
  it('builds a schemaError with table and operation', () => {
    const error = DatabaseError.schemaError('users', 'ADD COLUMN');
    expect(error.code).toBe('DB_SCHEMA_ERROR');
    expect(error.message).toContain("table 'users'");
    expect(error.message).toContain('ADD COLUMN');
    expect(error.details).toEqual({
      tableName: 'users',
      operation: 'ADD COLUMN',
    });
  });

  it('builds a corruptedData error', () => {
    const error = DatabaseError.corruptedData('metadata', 'Product');
    expect(error.code).toBe('DB_CORRUPTED_DATA');
    expect(error.message).toContain("field 'metadata'");
    expect(error.message).toContain('Product');
  });

  it('builds a missingDiscriminator error, with and without a row id', () => {
    const withRow = DatabaseError.missingDiscriminator('Article', 'row-7');
    expect(withRow.code).toBe('DB_MISSING_DISCRIMINATOR');
    expect(withRow.message).toContain('row id: row-7');
    expect(withRow.details).toEqual({ className: 'Article', rowId: 'row-7' });

    const withoutRow = DatabaseError.missingDiscriminator('Article');
    expect(withoutRow.message).not.toContain('row id:');
  });

  it('builds an stiDiscriminatorConflict error with formatted identity', () => {
    const error = DatabaseError.stiDiscriminatorConflict({
      className: 'Article',
      tableName: 'content',
      id: 'id-1',
      slug: 'hello',
      context: 'blog',
      conflictIdentity: { slug: 'hello', context: 'blog' },
      legacyMetaType: 'Article',
      qualifiedMetaType: '@happyvertical/smrt-content:Article',
      duplicateId: 'id-2',
    });

    expect(error.code).toBe('DB_STI_DISCRIMINATOR_CONFLICT');
    expect(error.message).toContain("slug 'hello'");
    expect(error.message).toContain("context 'blog'");
    expect(error.message).toContain("Row 'id-1'");
    expect(error.message).toContain("row 'id-2'");
  });

  it('builds an stiDiscriminatorConflict with an empty conflict identity', () => {
    const error = DatabaseError.stiDiscriminatorConflict({
      className: 'Article',
      tableName: 'content',
      id: 'id-1',
      slug: 'hello',
      context: 'blog',
      conflictIdentity: {},
      legacyMetaType: 'Article',
      qualifiedMetaType: 'pkg:Article',
      duplicateId: 'id-2',
    });

    expect(error.message).toContain('the same conflict identity');
  });

  it('builds a schemaMissing error', () => {
    const error = DatabaseError.schemaMissing('widgets', 'Widget');
    expect(error.code).toBe('DB_SCHEMA_MISSING');
    expect(error.message).toContain("Table 'widgets'");
    expect(error.message).toContain('smrt db:migrate');
  });
});

describe('AIError factories', () => {
  it('builds an invalidResponse error capturing the response', () => {
    const error = AIError.invalidResponse('anthropic', { foo: 'bar' });
    expect(error.code).toBe('AI_INVALID_RESPONSE');
    expect(error.category).toBe('ai');
    expect(error.details?.response).toEqual({ foo: 'bar' });
  });

  it('builds an authenticationFailed error', () => {
    const error = AIError.authenticationFailed('openai');
    expect(error.code).toBe('AI_AUTH_FAILED');
    expect(error.details?.provider).toBe('openai');
  });

  it('marks AI errors as retryable', () => {
    expect(ErrorUtils.isRetryable(AIError.authenticationFailed('openai'))).toBe(
      true,
    );
  });
});

describe('FilesystemError factories', () => {
  it('builds fileNotFound, permissionDenied, and diskSpaceExceeded', () => {
    const notFound = FilesystemError.fileNotFound('/tmp/x');
    expect(notFound.code).toBe('FS_FILE_NOT_FOUND');
    expect(notFound.category).toBe('filesystem');

    const denied = FilesystemError.permissionDenied('/etc/secret', 'read');
    expect(denied.code).toBe('FS_PERMISSION_DENIED');
    expect(denied.message).toContain('read');

    const space = FilesystemError.diskSpaceExceeded('/data', 1024);
    expect(space.code).toBe('FS_DISK_SPACE_EXCEEDED');
    expect(space.details?.requiredBytes).toBe(1024);
  });
});

describe('ValidationError factories', () => {
  it('builds invalidValue reporting the runtime type', () => {
    const error = ValidationError.invalidValue('age', 'twelve', 'number');
    expect(error.code).toBe('VALIDATION_INVALID_VALUE');
    expect(error.message).toContain('expected number');
    expect(error.message).toContain('got string');
  });

  it('builds uniqueConstraint', () => {
    const error = ValidationError.uniqueConstraint('email', 'a@b.com');
    expect(error.code).toBe('VALIDATION_UNIQUE_CONSTRAINT');
    expect(error.details?.value).toBe('a@b.com');
  });

  it('renders rangeError for min-only and max-only bounds', () => {
    const minOnly = ValidationError.rangeError('n', -1, 0);
    expect(minOnly.message).toContain('>= 0');

    const maxOnly = ValidationError.rangeError('n', 11, undefined, 10);
    expect(maxOnly.message).toContain('<= 10');
  });
});

describe('NetworkError factories', () => {
  it('includes status and truncates response body strings', () => {
    const body = 'x'.repeat(500);
    const error = NetworkError.requestFailed('https://api/x', 502, body);
    expect(error.code).toBe('NETWORK_REQUEST_FAILED');
    expect(error.message).toContain('Status: 502');
    expect(error.details?.responseBody?.length).toBe(500);
    // Only the first 200 chars are inlined into the message.
    expect(error.message).toContain('x'.repeat(200));
    expect(error.cause).toBeUndefined();
  });

  it('captures an Error response body as the cause', () => {
    const cause = new Error('socket hang up');
    const error = NetworkError.requestFailed('https://api/x', undefined, cause);
    expect(error.cause).toBe(cause);
    expect(error.message).not.toContain('Status:');
    expect(error.details?.responseBody).toBeUndefined();
  });

  it('builds timeout and serviceUnavailable (with and without reason)', () => {
    const timeout = NetworkError.timeout('https://api/x', 5000);
    expect(timeout.code).toBe('NETWORK_TIMEOUT');
    expect(timeout.message).toContain('5000ms');

    const withReason = NetworkError.serviceUnavailable(
      'billing',
      'maintenance',
    );
    expect(withReason.message).toContain('billing - maintenance');

    const withoutReason = NetworkError.serviceUnavailable('billing');
    expect(withoutReason.message).toBe('External service unavailable: billing');
  });

  it('marks network errors as retryable', () => {
    expect(ErrorUtils.isRetryable(NetworkError.timeout('u', 1))).toBe(true);
  });
});

describe('ConfigurationError factories', () => {
  it('builds missingConfiguration with and without context', () => {
    const withCtx = ConfigurationError.missingConfiguration(
      'apiKey',
      'AIClient',
    );
    expect(withCtx.code).toBe('CONFIG_MISSING');
    expect(withCtx.message).toContain('in AIClient');

    const withoutCtx = ConfigurationError.missingConfiguration('apiKey');
    expect(withoutCtx.message).toBe('Missing required configuration: apiKey');
  });

  it('builds invalidConfiguration, initializationFailed', () => {
    const invalid = ConfigurationError.invalidConfiguration(
      'port',
      '80',
      'number',
    );
    expect(invalid.code).toBe('CONFIG_INVALID');
    expect(invalid.message).toContain('expected number');

    const cause = new Error('boom');
    const init = ConfigurationError.initializationFailed('Cache', cause);
    expect(init.code).toBe('CONFIG_INIT_FAILED');
    expect(init.cause).toBe(cause);
  });

  it('builds circularInheritance and incompatibleStrategy', () => {
    const circular = ConfigurationError.circularInheritance('A', ['A', 'B']);
    expect(circular.code).toBe('CONFIG_CIRCULAR_INHERITANCE');
    expect(circular.message).toContain('A → B → A');

    const incompatible = ConfigurationError.incompatibleStrategy(
      'Child',
      'cti',
      'Parent',
      'sti',
    );
    expect(incompatible.code).toBe('CONFIG_INCOMPATIBLE_STRATEGY');
    expect(incompatible.message).toContain('Parent');
  });

  it('builds unregisteredBaseClass', () => {
    const error = ConfigurationError.unregisteredBaseClass('Meeting', 'Event');
    expect(error.code).toBe('CONFIG_UNREGISTERED_BASE');
    expect(error.message).toContain('Event');
    expect(error.message).toContain('Meeting');
  });

  it('does not retry configuration errors', async () => {
    let attempts = 0;
    await expect(
      ErrorUtils.withRetry(
        async () => {
          attempts++;
          throw ConfigurationError.missingConfiguration('apiKey');
        },
        3,
        1,
      ),
    ).rejects.toThrow(ConfigurationError);
    expect(attempts).toBe(1);
  });
});

describe('RuntimeError factories', () => {
  it('builds operationFailed with and without context', () => {
    const withCtx = RuntimeError.operationFailed('save', 'Product');
    expect(withCtx.code).toBe('RUNTIME_OPERATION_FAILED');
    expect(withCtx.message).toContain('in Product');

    const withoutCtx = RuntimeError.operationFailed('save');
    expect(withoutCtx.message).toBe('Operation failed: save');
  });

  it('builds invalidState carrying structured context as details', () => {
    const error = RuntimeError.invalidState('bad state', { phase: 'init' });
    expect(error.code).toBe('RUNTIME_INVALID_STATE');
    expect(error.message).toBe('bad state');
    expect(error.details).toEqual({ phase: 'init' });
  });

  it('builds resourceExhausted', () => {
    const error = RuntimeError.resourceExhausted('connections', 10);
    expect(error.code).toBe('RUNTIME_RESOURCE_EXHAUSTED');
    expect(error.message).toContain('limit of 10');
  });

  it('is retryable only via message patterns, not category', () => {
    expect(ErrorUtils.isRetryable(RuntimeError.operationFailed('x'))).toBe(
      false,
    );
  });
});

describe('TenantIsolationError', () => {
  it('exposes tenantId/attemptedTenantId via crossTenantReference', () => {
    const error = TenantIsolationError.crossTenantReference({
      sourceClass: 'Order',
      fieldName: 'customerId',
      sourceTenantId: 'tenant-a',
      targetClass: 'Customer',
      targetTenantId: 'tenant-b',
    });

    expect(error.code).toBe('TENANT_ISOLATION_VIOLATION');
    expect(error.category).toBe('validation');
    expect(error.tenantId).toBe('tenant-a');
    expect(error.attemptedTenantId).toBe('tenant-b');
    expect(error.message).toContain('Customer');
  });

  it('omits the target class label when targetClass is absent', () => {
    const error = TenantIsolationError.crossTenantReference({
      sourceClass: 'Order',
      fieldName: 'customerId',
      sourceTenantId: 'tenant-a',
      targetTenantId: 'tenant-b',
    });

    expect(error.message).toContain("tenant 'tenant-b'");
    expect(error.message).not.toContain('Customer');
  });
});

describe('ErrorUtils.sanitizeError on a plain Error', () => {
  it('returns only name/message/stack for non-SmrtError', () => {
    const sanitized = ErrorUtils.sanitizeError(new Error('plain'));
    expect(sanitized.name).toBe('Error');
    expect(sanitized.code).toBeUndefined();
    expect(sanitized.category).toBeUndefined();
  });

  it('leaves details untouched when an SmrtError has no sensitive fields', () => {
    const error = AIError.providerError('openai', 'embed');
    const sanitized = ErrorUtils.sanitizeError(error);
    expect(sanitized.details).toEqual({
      provider: 'openai',
      operation: 'embed',
    });
  });
});

describe('ErrorUtils.withRetry', () => {
  it('coerces a thrown non-Error to an Error and rethrows after retries', async () => {
    await expect(
      ErrorUtils.withRetry(
        async () => {
          throw 'string failure';
        },
        1,
        1,
      ),
    ).rejects.toThrow('string failure');
  });

  it('retries then succeeds for a non-skipped error', async () => {
    let attempts = 0;
    const result = await ErrorUtils.withRetry(
      async () => {
        attempts++;
        if (attempts < 2) throw new Error('transient');
        return 'ok';
      },
      3,
      1,
    );
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });
});

describe('SmrtError subclassing contract', () => {
  it('sets name to the concrete subclass constructor name', () => {
    expect(AIError.providerError('p', 'o').name).toBe('AIError');
    expect(NetworkError.timeout('u', 1).name).toBe('NetworkError');
    expect(RuntimeError.operationFailed('o').name).toBe('RuntimeError');
    expect(ConfigurationError.missingConfiguration('k').name).toBe(
      'ConfigurationError',
    );
    expect(FilesystemError.fileNotFound('p')).toBeInstanceOf(SmrtError);
  });
});

describe('ValidationReport', () => {
  it('starts empty and reports the passing string', () => {
    const report = new ValidationReport('Product');
    expect(report.hasErrors()).toBe(false);
    expect(report.getErrorCount()).toBe(0);
    expect(report.getErrors()).toEqual([]);
    expect(report.toString()).toBe('Validation passed for Product');
    // throwIfErrors is a no-op when empty.
    expect(() => report.throwIfErrors()).not.toThrow();
  });

  it('collects errors and renders a numbered failure summary', () => {
    const report = new ValidationReport('Product');
    report.addError(ValidationError.requiredField('name', 'Product'));
    report.addError(ValidationError.rangeError('price', -1, 0));

    expect(report.hasErrors()).toBe(true);
    expect(report.getErrorCount()).toBe(2);

    const str = report.toString();
    expect(str).toContain('Validation failed for Product with 2 error(s)');
    expect(str).toContain('1. ');
    expect(str).toContain('2. ');
  });

  it('serializes to JSON with per-error toJSON()', () => {
    const report = new ValidationReport('Product');
    report.addError(ValidationError.requiredField('name', 'Product'));

    const json = report.toJSON() as {
      objectType: string;
      errorCount: number;
      errors: Array<{ code: string }>;
    };
    expect(json.objectType).toBe('Product');
    expect(json.errorCount).toBe(1);
    expect(json.errors[0].code).toBe('VALIDATION_REQUIRED_FIELD');
  });

  it('throwIfErrors throws the first collected error', () => {
    const report = new ValidationReport('Product');
    report.addError(ValidationError.requiredField('name', 'Product'));
    report.addError(ValidationError.uniqueConstraint('slug', 'x'));

    expect(() => report.throwIfErrors()).toThrow(ValidationError);
    try {
      report.throwIfErrors();
    } catch (err) {
      expect((err as ValidationError).code).toBe('VALIDATION_REQUIRED_FIELD');
    }
  });

  it('clear() empties the report and returns a defensive copy from getErrors()', () => {
    const report = new ValidationReport('Product');
    report.addError(ValidationError.requiredField('name', 'Product'));

    const snapshot = report.getErrors();
    snapshot.push(ValidationError.uniqueConstraint('slug', 'x'));
    // Mutating the returned array must not affect internal state.
    expect(report.getErrorCount()).toBe(1);

    report.clear();
    expect(report.hasErrors()).toBe(false);
  });
});

describe('ValidationUtils.validateField', () => {
  it('flags a missing required value', async () => {
    const error = await ValidationUtils.validateField('name', '', {
      required: true,
    });
    expect(error?.code).toBe('VALIDATION_REQUIRED_FIELD');
  });

  it('returns null for a null value that is not required', async () => {
    expect(await ValidationUtils.validateField('name', null, {})).toBeNull();
  });

  it('flags numbers below min and above max', async () => {
    expect(
      (await ValidationUtils.validateField('n', -1, { min: 0, max: 10 }))?.code,
    ).toBe('VALIDATION_RANGE_ERROR');
    expect(
      (await ValidationUtils.validateField('n', 11, { min: 0, max: 10 }))?.code,
    ).toBe('VALIDATION_RANGE_ERROR');
    expect(
      await ValidationUtils.validateField('n', 5, { min: 0, max: 10 }),
    ).toBeNull();
  });

  it('flags strings outside the configured length bounds', async () => {
    expect(
      (await ValidationUtils.validateField('s', 'a', { minLength: 2 }))
        ?.message,
    ).toContain('minimum length 2');
    expect(
      (await ValidationUtils.validateField('s', 'abcd', { maxLength: 3 }))
        ?.message,
    ).toContain('maximum length 3');
  });

  it('validates string patterns from both string and RegExp options', async () => {
    expect(
      await ValidationUtils.validateField('hex', 'abc', {
        pattern: '^[a-f]+$',
      }),
    ).toBeNull();
    expect(
      (
        await ValidationUtils.validateField('hex', 'xyz', {
          pattern: /^[a-f]+$/,
        })
      )?.code,
    ).toBe('VALIDATION_INVALID_VALUE');
  });

  it('runs a custom validator and reports its failure message', async () => {
    const ok = await ValidationUtils.validateField('v', 5, {
      customValidator: (value) => value === 5,
    });
    expect(ok).toBeNull();

    const failed = await ValidationUtils.validateField('v', 4, {
      customValidator: (value) => value === 5,
      customMessage: 'must equal 5',
    });
    expect(failed?.message).toContain('must equal 5');
  });

  it('catches a throwing custom validator and surfaces the error message', async () => {
    const error = await ValidationUtils.validateField('v', 4, {
      customValidator: async () => {
        throw new Error('validator exploded');
      },
    });
    expect(error?.code).toBe('VALIDATION_INVALID_VALUE');
    expect(error?.message).toContain('validator exploded');
  });

  it('catches a custom validator throwing a non-Error', async () => {
    const error = await ValidationUtils.validateField('v', 4, {
      customValidator: async () => {
        throw 'nope';
      },
    });
    expect(error?.message).toContain('nope');
  });
});

describe('ValidationUtils synchronous helpers', () => {
  it('validateRequired flags empty/null/undefined', () => {
    expect(ValidationUtils.validateRequired('f', '')?.code).toBe(
      'VALIDATION_REQUIRED_FIELD',
    );
    expect(ValidationUtils.validateRequired('f', null)?.code).toBe(
      'VALIDATION_REQUIRED_FIELD',
    );
    expect(ValidationUtils.validateRequired('f', 'value')).toBeNull();
  });

  it('validateRange enforces both bounds', () => {
    expect(ValidationUtils.validateRange('n', -1, 0, 10)?.code).toBe(
      'VALIDATION_RANGE_ERROR',
    );
    expect(ValidationUtils.validateRange('n', 11, 0, 10)?.code).toBe(
      'VALIDATION_RANGE_ERROR',
    );
    expect(ValidationUtils.validateRange('n', 5, 0, 10)).toBeNull();
  });

  it('validateLength enforces min and max', () => {
    expect(ValidationUtils.validateLength('s', 'a', 2)?.message).toContain(
      'minimum length 2',
    );
    expect(
      ValidationUtils.validateLength('s', 'abcd', undefined, 3)?.message,
    ).toContain('maximum length 3');
    expect(ValidationUtils.validateLength('s', 'ab', 1, 3)).toBeNull();
  });

  it('validatePattern accepts string and RegExp patterns', () => {
    expect(ValidationUtils.validatePattern('s', 'abc', '^[a-c]+$')).toBeNull();
    expect(ValidationUtils.validatePattern('s', 'zzz', /^[a-c]+$/)?.code).toBe(
      'VALIDATION_INVALID_VALUE',
    );
  });
});
