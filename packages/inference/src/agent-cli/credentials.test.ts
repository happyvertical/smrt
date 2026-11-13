import { describe, expect, it, vi } from 'vitest';
import { AGENT_TOKEN_TTL_SECONDS, tokenCredentials } from './credentials.js';

describe('host token-store adapter', () => {
  it('passes host scope and holder with a bounded lifetime and revokes that holder', async () => {
    const issue = vi.fn(async () => ({ token: 'fake-secret' }));
    const revokeHolder = vi.fn(async () => 'revoked' as const);
    const credentials = tokenCredentials(
      async () => ({ issue, revokeHolder }),
      {
        holder: 'conversation-1',
        label: 'App assistant',
        scopes: ['assistant.use'],
      },
    );
    expect(await credentials.mint()).toBe('fake-secret');
    expect(issue).toHaveBeenCalledWith({
      holder: 'conversation-1',
      label: 'App assistant',
      scopes: ['assistant.use'],
      expiresInSeconds: AGENT_TOKEN_TTL_SECONDS,
    });
    await credentials.revoke();
    await credentials.revoke();
    expect(revokeHolder.mock.calls).toEqual([
      ['conversation-1'],
      ['conversation-1'],
    ]);
  });

  it('refuses a missing store and tolerates failed best-effort revocation', async () => {
    const missing = tokenCredentials(async () => undefined, {
      holder: 'x',
      label: 'x',
      scopes: [],
    });
    await expect(missing.mint()).rejects.toThrow('no local token store');
    await expect(missing.revoke()).resolves.toBeUndefined();
    const credentials = tokenCredentials(
      async () => {
        throw new Error('unavailable');
      },
      { holder: 'x', label: 'x', scopes: [] },
    );
    await expect(credentials.revoke()).resolves.toBeUndefined();
  });
});

it('ties owner-token lifetime to a long design pass with cleanup margin', async () => {
  const issue = vi.fn(async () => ({ token: 'fake' }));
  const credentials = tokenCredentials(
    async () => ({ issue, revokeHolder: async () => 'revoked' }),
    { holder: 'pass', label: 'Design pass', scopes: ['assistant.use'] },
  );
  await credentials.mint({ timeoutMs: 1_800_000 });
  expect(issue).toHaveBeenCalledWith(
    expect.objectContaining({
      expiresInSeconds: 1860,
      holder: 'pass',
      scopes: ['assistant.use'],
    }),
  );
});
