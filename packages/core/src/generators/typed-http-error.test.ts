import { describe, expect, it } from 'vitest';
import { normalizeTypedHttpError } from './typed-http-error.js';

describe('normalizeTypedHttpError', () => {
  it('keeps an expected typed 4xx denial safe and actionable', () => {
    const error = Object.assign(new Error('Policy is locked'), {
      code: 'policy_locked',
      status: 403,
    });

    expect(normalizeTypedHttpError(error)).toEqual({
      code: 'policy_locked',
      message: 'Policy is locked',
      ok: false,
      status: 403,
    });
  });

  it('uses deterministic safe fallbacks for client denials', () => {
    expect(
      normalizeTypedHttpError(
        Object.assign(new Error('Invalid input'), { status: 422 }),
      ),
    ).toEqual({
      code: 'request_rejected',
      message: 'Invalid input',
      ok: false,
      status: 422,
    });
  });

  it('prefers an explicit safe public message over internal error detail', () => {
    expect(
      normalizeTypedHttpError(
        Object.assign(new Error('Tenant 17 is outside membership 9'), {
          code: 'tenant_isolation',
          publicMessage: 'This request is not permitted for the active tenant',
          status: 403,
        }),
      ),
    ).toEqual({
      code: 'tenant_isolation',
      message: 'This request is not permitted for the active tenant',
      ok: false,
      status: 403,
    });
  });

  it('does not serialize untyped or server-side errors', () => {
    expect(
      normalizeTypedHttpError(
        Object.assign(new Error('database password: secret'), {
          code: 'database_failed',
          status: 500,
        }),
      ),
    ).toBeUndefined();
    expect(normalizeTypedHttpError(new Error('unexpected'))).toBeUndefined();
  });
});
