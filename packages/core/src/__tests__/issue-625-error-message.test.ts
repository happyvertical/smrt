/**
 * Test for Issue #625: DatabaseError.queryFailed() should include root cause message
 *
 * Verifies that queryFailed() includes the cause message in the error for better debugging.
 */

import { describe, expect, it } from 'vitest';
import { DatabaseError } from '../errors';

describe('Issue #625: DatabaseError.queryFailed() root cause message', () => {
  it('should include root cause message in error when cause is provided', () => {
    const rootCause = new Error('no such table: assets');
    const error = DatabaseError.queryFailed(
      'UPSERT INTO assets (id, name) VALUES (?, ?)',
      rootCause,
    );

    // Error message should include the root cause
    expect(error.message).toContain('Database query failed');
    expect(error.message).toContain('no such table: assets');
    expect(error.message).toContain('Cause:');
  });

  it('should include causeMessage in details when cause is provided', () => {
    const rootCause = new Error('SQLITE_ERROR: table does not exist');
    const error = DatabaseError.queryFailed(
      'SELECT * FROM missing_table',
      rootCause,
    );

    // Details should include the cause message
    expect(error.details).toBeDefined();
    expect(error.details?.causeMessage).toBe(
      'SQLITE_ERROR: table does not exist',
    );
  });

  it('should work without cause (backwards compatible)', () => {
    const error = DatabaseError.queryFailed('SELECT * FROM test_table');

    // Should not throw and should not include "Cause:"
    expect(error.message).toContain('Database query failed');
    expect(error.message).toContain('SELECT * FROM test_table');
    expect(error.message).not.toContain('Cause:');
    expect(error.details?.causeMessage).toBeUndefined();
  });

  it('should truncate long queries in message but include in details', () => {
    const longQuery = 'SELECT '.padEnd(150, 'x');
    const error = DatabaseError.queryFailed(longQuery);

    // Message should be truncated
    expect(error.message.length).toBeLessThan(200);
    expect(error.message).toContain('...');

    // Full query should be in details
    expect(error.details?.query).toBe(longQuery);
  });

  it('should preserve the cause Error for stack trace access', () => {
    const rootCause = new Error('Connection refused');
    const error = DatabaseError.queryFailed('SELECT 1', rootCause);

    // The cause should be preserved for debugging
    expect(error.cause).toBe(rootCause);
  });
});
