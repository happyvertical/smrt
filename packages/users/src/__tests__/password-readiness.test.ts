import { afterEach, describe, expect, it, vi } from 'vitest';

const getDatabase = vi.hoisted(() => vi.fn());

vi.mock('@happyvertical/sql', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@happyvertical/sql')>()),
  getDatabase,
}));

import { checkReadiness } from '../password-readiness.js';

const CONTEXT = {
  component: 'authentication',
  profile: 'self-hosted',
  provider: 'password',
};

function readyRows() {
  return [
    'users.email_key',
    'users.username_key',
    'users.status',
    'memberships.user_id',
    'memberships.tenant_id',
    'memberships.role_id',
    'memberships.status',
    'sessions.id',
    'sessions.user_id',
    'sessions.tenant_id',
    'sessions.status',
    'sessions.expires_at',
    'sessions.auth_method',
    'sessions.parent_session_id',
    'users_password_credentials.user_id',
    'users_password_credentials.password_hash',
    'users_password_credentials.version',
    'users_password_credentials.must_change',
    'users_password_credentials.rotated_at',
    'users_password_credentials.rotated_by',
    'users_login_attempts.id',
    'users_login_audit_events.id',
  ].map((value) => {
    const [table_name, column_name] = value.split('.');
    return { table_name, column_name };
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('password provider readiness', () => {
  it('proves the configured PostgreSQL password/session schema and closes its adapter', async () => {
    vi.stubEnv('DATABASE_URL', 'postgresql://user:secret@db.example/app');
    const close = vi.fn(async () => undefined);
    const query = vi.fn(async () => ({ rows: readyRows() }));
    getDatabase.mockResolvedValue({ query, close });

    await expect(checkReadiness(CONTEXT)).resolves.toBe(true);
    expect(getDatabase).toHaveBeenCalledWith({
      type: 'postgres',
      url: 'postgresql://user:secret@db.example/app',
      cache: false,
    });
    expect(query).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails closed for an incomplete schema without leaking the database URL', async () => {
    const url = 'postgresql://user:do-not-leak@db.example/app';
    vi.stubEnv('DATABASE_URL', url);
    const close = vi.fn(async () => undefined);
    getDatabase.mockResolvedValue({
      query: vi.fn(async () => ({ rows: readyRows().slice(1) })),
      close,
    });

    await expect(checkReadiness(CONTEXT)).rejects.toThrow(
      'Password authentication schema is not ready.',
    );
    await expect(checkReadiness(CONTEXT)).rejects.not.toThrow(url);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...CONTEXT, provider: 'oidc' },
    { ...CONTEXT, profile: 'cloud' },
    { ...CONTEXT, component: 'assets' },
  ])('rejects a mismatched provider context before connecting', async (context) => {
    await expect(checkReadiness(context)).rejects.toThrow(
      'Password readiness is only valid for self-hosted authentication.',
    );
    expect(getDatabase).not.toHaveBeenCalled();
  });
});
