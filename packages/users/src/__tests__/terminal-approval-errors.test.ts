import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TerminalAuthError,
  TerminalAuthRateLimitError,
  TerminalAuthService,
} from '../services/TerminalAuthService.js';
import { mountTerminalLoginPage } from '../sveltekit/index.js';

const PRIVATE_FAILURE =
  'postgres://fixture:NOT_A_CREDENTIAL@db.invalid/fixture';

function mount(authenticated = true) {
  return mountTerminalLoginPage({
    db: { type: 'sqlite', url: `file:fixture-${randomUUID()}` },
    resolveUser: () =>
      authenticated
        ? { id: 'fixture-user', email: 'fixture@example.invalid' }
        : null,
    resolveTenantId: () => 'fixture-tenant',
  });
}

function event(code = 'WORK-AAAAAAAA') {
  return {
    request: new Request('https://example.invalid/terminal-login?/approve', {
      method: 'POST',
      body: new URLSearchParams({ userCode: code }),
    }),
    url: new URL('https://example.invalid/terminal-login?/approve'),
    locals: {},
    params: {},
    getClientAddress: () => '127.0.0.1',
    cookies: { get: () => undefined, set() {}, delete() {} },
  } as Parameters<ReturnType<typeof mountTerminalLoginPage>['approve']>[0];
}

function service(approveRequest = vi.fn()) {
  vi.spyOn(TerminalAuthService, 'create').mockResolvedValue({
    approveRequest,
  } as unknown as TerminalAuthService);
  return approveRequest;
}

describe('terminal approval public error boundary (#4319)', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    'initialize',
    'approve',
    'non-error',
  ])('redacts an unexpected %s failure from the mounted action', async (phase) => {
    const error =
      phase === 'non-error' ? PRIVATE_FAILURE : new Error(PRIVATE_FAILURE);
    if (phase === 'initialize')
      vi.spyOn(TerminalAuthService, 'create').mockRejectedValue(error);
    else service(vi.fn().mockRejectedValue(error));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await mount().approve(event());
    expect(result).toEqual({
      type: 'failure',
      status: 500,
      data: {
        status: 500,
        error: 'Unable to approve terminal login.',
        userCode: 'WORK-AAAAAAAA',
      },
    });
    expect(JSON.stringify(result)).not.toContain('NOT_A_CREDENTIAL');
    expect(JSON.stringify(result)).not.toContain('db.invalid');
    expect(logged).not.toHaveBeenCalled();
  });

  it.each([
    [new TerminalAuthError('Invalid or expired terminal code.'), 400],
    [new TerminalAuthRateLimitError('Too many approval attempts.', 60), 429],
  ])('preserves the known public refusal %s', async (error, status) => {
    service(vi.fn().mockRejectedValue(error));
    const result = await mount().approve(event());
    expect(result).toEqual({
      type: 'failure',
      status,
      data: { status, error: error.message, userCode: 'WORK-AAAAAAAA' },
    });
  });

  it('keeps authentication and missing-code refusals ahead of service access', async () => {
    const create = vi.spyOn(TerminalAuthService, 'create');
    expect(await mount(false).approve(event())).toMatchObject({
      type: 'failure',
      status: 401,
    });
    expect(await mount().approve(event(''))).toMatchObject({
      type: 'failure',
      status: 400,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('preserves a successful approval and its exact authenticated context', async () => {
    const approve = service(vi.fn().mockResolvedValue({ status: 'approved' }));
    const result = await mount().approve(event(' work-aaaaaaaa '));
    expect(result).toEqual({
      approved: true,
      requestStatus: 'approved',
      userCode: 'WORK-AAAAAAAA',
    });
    expect(approve).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        tenantId: 'fixture-tenant',
        user: { id: 'fixture-user', email: 'fixture@example.invalid' },
        userCode: 'WORK-AAAAAAAA',
      }),
    );
  });
});
