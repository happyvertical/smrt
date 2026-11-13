import { beforeEach, describe, expect, it, vi } from 'vitest';

const { log } = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock('@happyvertical/logger', () => ({
  createLogger: () => ({ error: log }),
}));

import { reportUnexpectedHttpError } from './route-error';

beforeEach(() => {
  log.mockReset();
});
describe('unexpected HTTP failure diagnostics', () => {
  it('correlates the opaque response with a redacted cause chain, without request content', () => {
    const cause = Object.assign(new Error('Driver password=driver-secret'), {
      code: 'SQL_FAILED',
    });
    const error = Object.assign(
      new Error('Failed at postgres://owner:db-secret@host/db', { cause }),
      {
        details: { body: 'private-body', token: 'private-token' },
      },
    );
    const request = new Request(
      'http://local/api/customers?token=query-secret',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer header-secret',
          'x-request-id': 'forged-id',
        },
        body: JSON.stringify({ name: 'private-name', email: 'private-email' }),
      },
    );
    const body = reportUnexpectedHttpError(error, request);
    expect(body).toEqual({
      error: 'Internal server error',
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(log).toHaveBeenCalledWith(
      'SMRT HTTP request failed',
      expect.objectContaining({
        requestId: body.requestId,
        method: 'POST',
        route: '/api/customers',
        cause: expect.objectContaining({
          cause: expect.objectContaining({ code: 'SQL_FAILED' }),
        }),
      }),
    );
    const serialized = JSON.stringify(log.mock.calls);
    for (const secret of [
      'driver-secret',
      'db-secret',
      'query-secret',
      'header-secret',
      'forged-id',
      'private-body',
      'private-token',
      'private-name',
      'private-email',
    ])
      expect(serialized).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain('SQL_FAILED');
  });
  it('does not log arbitrary thrown values or structured bodies, and bounds causal cycles', () => {
    reportUnexpectedHttpError(
      { password: 'never-log-me' },
      new Request('http://local/api/items'),
    );
    const cyclic = new Error('Failure {"password":"also-private"}');
    cyclic.cause = cyclic;
    reportUnexpectedHttpError(cyclic, new Request('http://local/api/items'));
    const serialized = JSON.stringify(log.mock.calls);
    expect(serialized).not.toContain('never-log-me');
    expect(serialized).not.toContain('also-private');
    expect(serialized).toContain('NonErrorThrow');
  });
  it('still returns a reference if the logger fails', () => {
    log.mockImplementation(() => {
      throw new Error('logging failed');
    });
    expect(
      reportUnexpectedHttpError(
        new Error('original'),
        new Request('http://local/api/items'),
      ),
    ).toMatchObject({ requestId: expect.any(String) });
  });
});
