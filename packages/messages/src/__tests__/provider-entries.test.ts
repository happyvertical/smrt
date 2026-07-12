/**
 * Explicit provider entry points (#1979).
 *
 * Provider-neutral consumers must get actionable errors instead of provider
 * SDK weight; importing a provider entry must restore full functionality.
 * The SDK boundary ('@happyvertical/email') is mocked per testing policy —
 * everything else (registry, models, entry modules) is real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getEmailClientMock = vi.fn(async () => ({
  connect: vi.fn(async () => undefined),
  isConnected: () => true,
}));

vi.mock('@happyvertical/email', () => ({
  getEmailClient: (...args: unknown[]) => getEmailClientMock(...args),
}));

import { EmailAccount } from '../models/EmailAccount';
import {
  ensureBuiltinMessagingProvidersRegistered,
  getMessagingProvider,
  listMessagingProviders,
} from '../providers';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('builtin provider registry stays metadata-only', () => {
  it('registers smtp/gmail without any client implementation', () => {
    ensureBuiltinMessagingProvidersRegistered();
    for (const id of ['smtp', 'gmail']) {
      const definition = getMessagingProvider(id);
      expect(definition, `builtin '${id}' definition`).toBeDefined();
      expect(definition?.createEmailClient).toBeUndefined();
      expect(definition?.createSender).toBeUndefined();
    }
  });

  it('keeps fetch-based zulip/telegram senders functional from the root', () => {
    ensureBuiltinMessagingProvidersRegistered();
    expect(getMessagingProvider('zulip')?.createSender).toBeTypeOf('function');
    expect(getMessagingProvider('telegram')?.createSender).toBeTypeOf(
      'function',
    );
  });
});

describe('EmailAccount.createClient without the email provider entry', () => {
  it('rejects with guidance naming the explicit entry point', async () => {
    ensureBuiltinMessagingProvidersRegistered();
    // Fresh worker per test file: providers/email has not been imported here.
    expect(getMessagingProvider('smtp')?.createEmailClient).toBeUndefined();

    const account = new EmailAccount({ email: 'me@example.com' });
    account.providerType = 'smtp';

    await expect(account.createClient()).rejects.toThrow(
      /smrt-messages\/providers\/email/,
    );
    expect(getEmailClientMock).not.toHaveBeenCalled();
  });
});

describe('importing providers/email enables the email client boundary', () => {
  it('registers createEmailClient on every email provider and routes createClient through it', async () => {
    await import('../providers/email');

    for (const id of ['smtp', 'imap', 'pop3', 'gmail']) {
      expect(
        getMessagingProvider(id)?.createEmailClient,
        `createEmailClient on '${id}'`,
      ).toBeTypeOf('function');
    }

    const account = new EmailAccount({ email: 'me@example.com' });
    account.providerType = 'smtp';
    vi.spyOn(account, 'getConfiguration').mockReturnValue({
      email: 'me@example.com',
      host: 'mail.example.com',
      port: 587,
    });
    vi.spyOn(account, 'getCredentials').mockResolvedValue({
      username: 'user',
      password: 'secret',
    });

    const client = await account.createClient();

    expect(client.isConnected()).toBe(true);
    expect(getEmailClientMock).toHaveBeenCalledTimes(1);
    expect(getEmailClientMock).toHaveBeenCalledWith({
      type: 'smtp',
      host: 'mail.example.com',
      port: 587,
      username: 'user',
      password: 'secret',
    });
  });

  it('survives a second module instance re-running builtin registration (HMR/dual-identity)', async () => {
    await import('../providers/email');
    expect(getMessagingProvider('smtp')?.createEmailClient).toBeTypeOf(
      'function',
    );

    // The registry lives on globalThis while the builtin flag is
    // module-scoped: a fresh module instance (HMR reload, src/dist dual
    // identity) re-runs ensureBuiltin... against the shared registry. Builtins
    // must gap-fill, never clobber the entry-registered client hooks.
    vi.resetModules();
    const secondInstance = await import('../providers');
    secondInstance.ensureBuiltinMessagingProvidersRegistered();

    expect(
      secondInstance.getMessagingProvider('smtp')?.createEmailClient,
      'entry-registered hook survived the second builtin registration',
    ).toBeTypeOf('function');
  });

  it('keeps provider definitions serializable for setup UIs (functions stripped)', async () => {
    await import('../providers/email');
    const serialized = listMessagingProviders({ includeUnavailable: true }).map(
      ({
        createSender: _createSender,
        createEmailClient: _createEmailClient,
        createMessageClient: _createMessageClient,
        ...provider
      }) => provider,
    );
    for (const provider of serialized) {
      expect(JSON.parse(JSON.stringify(provider))).toEqual(provider);
    }
  });
});
