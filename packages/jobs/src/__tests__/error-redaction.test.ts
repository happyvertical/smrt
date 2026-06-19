import { describe, expect, it } from 'vitest';
import {
  redactErrorForPersistence,
  redactErrorMessage,
} from '../error-redaction.js';

/**
 * Regression for S5 audit #1402 (MED): error messages persisted to the durable
 * `_smrt_jobs.last_error` / `_smrt_agent_schedules.last_error` columns (read by
 * workers, the CLI, and any operator surface) must not leak secret-shaped
 * substrings.
 */
describe('redactErrorMessage', () => {
  it('masks credentials embedded in a database URL but keeps the host', () => {
    const out = redactErrorMessage(
      'connect failed: postgres://admin:s3cr3t@db.internal:5432/app',
    );
    expect(out).not.toContain('s3cr3t');
    expect(out).not.toContain('admin:');
    expect(out).toContain('db.internal');
    expect(out).toContain('***REDACTED***');
  });

  it('masks secret-bearing key=value pairs while keeping the key', () => {
    expect(redactErrorMessage('401: apiKey=sk-live-abcdef0123456789')).toBe(
      '401: apiKey=***REDACTED***',
    );
    expect(redactErrorMessage('bad password=hunter2 supplied')).toContain(
      'password=***REDACTED***',
    );
    expect(redactErrorMessage('client_secret: "abcd-1234-secret"')).toContain(
      'client_secret:***REDACTED***',
    );
  });

  it('masks bearer tokens and authorization headers', () => {
    expect(
      redactErrorMessage('rejected with Bearer abcDEF123456ghi789'),
    ).not.toContain('abcDEF123456ghi789');
    expect(
      redactErrorMessage('Authorization: Basic dXNlcjpwYXNz failed'),
    ).not.toContain('dXNlcjpwYXNz');
  });

  it('masks standalone provider secrets', () => {
    expect(redactErrorMessage('token sk-ABCDEFGHIJKLMNOP rejected')).toContain(
      '***REDACTED***',
    );
    expect(
      redactErrorMessage('aws key AKIAIOSFODNN7EXAMPLE denied'),
    ).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(
      redactErrorMessage('github ghp_0123456789abcdefghijklmnopqrstuv'),
    ).toContain('***REDACTED***');
  });

  // Regression: hyphenated OpenAI project keys (`sk-proj-...`) have an internal
  // `-` that the original `sk-[A-Za-z0-9]+` pattern stopped at, leaking the
  // remainder of the token into last_error (S5 audit #1402, round 3).
  it('masks hyphenated OpenAI project keys (sk-proj-...) whole', () => {
    const key = 'sk-proj-ABC123def456GHI789jkl0';
    const out = redactErrorMessage(`openai 401: standalone ${key} rejected`);
    expect(out).not.toContain(key);
    // No fragment of the token body survives after the first hyphen.
    expect(out).not.toContain('proj-');
    expect(out).not.toContain('ABC123def456');
    expect(out).toBe('openai 401: standalone ***REDACTED*** rejected');
  });

  it('masks secrets written as JSON object members (quoted keys)', () => {
    const pwd = redactErrorMessage('payload {"password":"hunter2"} rejected');
    expect(pwd).not.toContain('hunter2');
    expect(pwd).toContain('"password":"***REDACTED***"');

    const apiKey = redactErrorMessage('config { "apiKey" : "abc123def456" }');
    expect(apiKey).not.toContain('abc123def456');
    expect(apiKey).toContain('***REDACTED***');

    const token = redactErrorMessage('{"access_token":"zzz-secret-zzz"}');
    expect(token).not.toContain('zzz-secret-zzz');
    expect(token).toContain('***REDACTED***');
  });

  it('masks Google API keys (AIza...)', () => {
    const out = redactErrorMessage(
      'maps error: key AIzaSyD-1234567890abcdefghijklmnop invalid',
    );
    expect(out).not.toContain('AIzaSyD-1234567890abcdefghijklmnop');
    expect(out).toContain('***REDACTED***');
  });

  it('masks Slack bot/user tokens (xoxb-/xoxp-)', () => {
    expect(
      redactErrorMessage('slack post failed: xoxb-123456789012-abcdefABCDEF'),
    ).not.toContain('xoxb-123456789012-abcdefABCDEF');
    expect(
      redactErrorMessage('slack auth: xoxp-9876543210-secrettoken'),
    ).toContain('***REDACTED***');
  });

  it('masks Stripe sk_live_ / sk_test_ keys', () => {
    expect(
      redactErrorMessage('charge failed sk_live_abcdEFGH1234567890 declined'),
    ).not.toContain('sk_live_abcdEFGH1234567890');
    expect(
      redactErrorMessage('test mode sk_test_abcdEFGH1234567890'),
    ).toContain('***REDACTED***');
  });

  it('leaves benign messages untouched', () => {
    const msg = 'TypeError: cannot read property "x" of undefined at line 42';
    expect(redactErrorMessage(msg)).toBe(msg);
  });

  it('handles non-string / empty input gracefully', () => {
    expect(redactErrorMessage('')).toBe('');
    // @ts-expect-error testing runtime tolerance
    expect(redactErrorMessage(undefined)).toBeUndefined();
  });

  it('redactErrorForPersistence tolerates non-Error throwables', () => {
    expect(redactErrorForPersistence(new Error('apiKey=sk-secret123456'))).toBe(
      'apiKey=***REDACTED***',
    );
    expect(redactErrorForPersistence('password=plaintext')).toBe(
      'password=***REDACTED***',
    );
  });

  // Regression for S5 audit #1402 (Copilot, round 3): the schedule/job runners
  // persist last_error via redactErrorForPersistence(error) — NOT
  // redactErrorMessage((error as Error).message), which yields `undefined` for
  // a thrown non-Error and stores an empty/undefined last_error. Coercion must
  // always produce a usable, string diagnostic.
  it('redactErrorForPersistence always returns a usable string for any throwable', () => {
    // A thrown plain object has no `.message`; String(obj) is still usable.
    expect(redactErrorForPersistence({ code: 'EFAIL' })).toBe(
      '[object Object]',
    );
    expect(redactErrorForPersistence(42)).toBe('42');
    expect(redactErrorForPersistence(null)).toBe('null');
    expect(redactErrorForPersistence(undefined)).toBe('undefined');
    // And it still redacts secrets surfaced by the coercion.
    expect(
      redactErrorForPersistence({ toString: () => 'token=plaintexttoken' }),
    ).toBe('token=***REDACTED***');
  });
});
