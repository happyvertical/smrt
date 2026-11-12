import { SmrtObject } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snapshotObjectRegistryState } from '../../../core/src/test-utils.js';
import { AccountCollection } from '../collections/AccountCollection.js';
import { EmailCollection } from '../collections/EmailCollection.js';
import { EmailFolderCollection } from '../collections/EmailFolderCollection.js';
import { MessagingEndpointCollection } from '../collections/MessagingEndpointCollection.js';
import { NotificationOptOutCollection } from '../collections/NotificationOptOutCollection.js';
import { PersonaMessageRouteCollection } from '../collections/PersonaMessageRouteCollection.js';
import { Account } from '../models/Account.js';
import { Email } from '../models/Email.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { EmailFolder } from '../models/EmailFolder.js';
import { Message } from '../models/Message.js';
import { MessagingEndpoint } from '../models/MessagingEndpoint.js';
import { NotificationOptOut } from '../models/NotificationOptOut.js';
import { PersonaMessageRoute } from '../models/PersonaMessageRoute.js';
import { TelegramAccount } from '../models/TelegramAccount.js';
import { ZulipAccount } from '../models/ZulipAccount.js';
import {
  MANAGE_MESSAGE_CREDENTIALS_PERMISSION,
  MANAGE_MESSAGE_ROUTES_PERMISSION,
  messagingPrincipalFromPermissions,
} from '../permissions.js';
import { registerMessagingProvider } from '../providers.js';
import { MessagingSettingsService } from '../services/MessagingSettingsService.js';
import { NotificationOptOutService } from '../services/NotificationOptOutService.js';
import { PersonaMessagingService } from '../services/PersonaMessagingService.js';

const models = {
  EmailFolder,
  Account,
  Email,
  EmailAccount,
  Message,
  MessagingEndpoint,
  NotificationOptOut,
  PersonaMessageRoute,
  TelegramAccount,
  ZulipAccount,
};
const tenantId = '11111111-1111-4111-8111-111111111111';
const personaId = '22222222-2222-4222-8222-222222222222';
const db = { url: 'sqlite://issue-4931-executor' } as never;

describe.each([false, true])('#4931 messages app replacement=%s', (replace) => {
  let restore: () => void;
  let expected: typeof models;
  const initialized: SmrtObject[] = [];
  const saved: SmrtObject[] = [];
  const unregister: Array<() => void> = [];

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    expected = replace
      ? (await import('./issue-4931-app.fixture.js')).registerAppModels()
      : models;
    initialized.length = 0;
    saved.length = 0;
    vi.spyOn(SmrtObject.prototype, 'initialize').mockImplementation(
      async function () {
        initialized.push(this);
        return this;
      },
    );
    const save = async function (this: SmrtObject) {
      this.id ||= crypto.randomUUID();
      saved.push(this);
      return this;
    };
    vi.spyOn(SmrtObject.prototype, 'save').mockImplementation(save);
    vi.spyOn(Message.prototype, 'save').mockImplementation(save as never);
    vi.spyOn(Account.prototype, 'setCredentials').mockResolvedValue(undefined);
    // Provider metadata is orthogonal to construction: use available, field-free definitions.
    for (const [id, channel] of [
      ['smtp', 'email'],
      ['telegram', 'telegram'],
      ['zulip', 'zulip'],
      ['issue-4931-sms', 'sms'],
    ] as const) {
      unregister.push(
        registerMessagingProvider({
          id,
          channel,
          label: id,
          available: true,
          configurationFields: [],
          credentialFields: [],
          endpointFields: [],
        }),
      );
    }
    vi.spyOn(AccountCollection, 'create').mockResolvedValue({
      get: async () => null,
    } as never);
    vi.spyOn(MessagingEndpointCollection, 'create').mockResolvedValue({
      get: async () => null,
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const undo of unregister.splice(0).reverse()) undo();
    restore();
  });

  function settings() {
    return new MessagingSettingsService({
      db,
      tenantId,
      principal: messagingPrincipalFromPermissions(
        [
          MANAGE_MESSAGE_CREDENTIALS_PERMISSION,
          MANAGE_MESSAGE_ROUTES_PERMISSION,
        ],
        { id: 'actor', tenantId },
      ),
      resolvePersonaTenantId: async () => tenantId,
    });
  }

  function assertCreated(model: keyof typeof models, saves = 1) {
    const object = initialized.find(
      (item) => item.constructor === expected[model],
    );
    expect(object?.constructor).toBe(expected[model]);
    expect(object?.options.db).toBe(db);
    expect(saved.filter((item) => item === object)).toHaveLength(saves);
    return object;
  }

  it.each([
    ['smtp', 'EmailAccount'],
    ['telegram', 'TelegramAccount'],
    ['zulip', 'ZulipAccount'],
    ['issue-4931-sms', 'Account'],
  ] as const)('settings creates the effective %s account', async (providerId, model) => {
    await settings().saveAccount({
      name: 'Sender',
      providerId,
      configuration: {},
    });
    assertCreated(model);
  });

  it('settings creates the effective MessagingEndpoint', async () => {
    await settings().saveEndpoint({
      label: 'Destination',
      providerId: 'telegram',
      address: {},
    });
    assertCreated('MessagingEndpoint');
  });

  it('settings creates the effective PersonaMessageRoute', async () => {
    vi.mocked(AccountCollection.create).mockResolvedValue({
      get: async () => ({
        tenantId,
        channelType: 'telegram',
        providerType: 'telegram',
      }),
    } as never);
    vi.mocked(MessagingEndpointCollection.create).mockResolvedValue({
      get: async () => ({ tenantId, channel: 'telegram' }),
    } as never);
    vi.spyOn(PersonaMessageRouteCollection, 'create').mockResolvedValue({
      get: async () => null,
    } as never);
    const route = await settings().saveRoute({
      personaId,
      accountId: 'account',
      endpointId: 'endpoint',
    });
    expect(route).toBe(assertCreated('PersonaMessageRoute'));
  });

  it.each([
    'email',
    'telegram',
  ] as const)('persona delivery creates the effective %s message', async (channel) => {
    const account =
      channel === 'email'
        ? new EmailAccount({ tenantId, isActive: true })
        : { tenantId, isActive: true, channelType: channel };
    vi.mocked(AccountCollection.create).mockResolvedValue({
      get: async () => account,
    } as never);
    vi.mocked(MessagingEndpointCollection.create).mockResolvedValue({
      get: async () => ({
        tenantId,
        isActive: true,
        channel,
        getAddress: () => ({ email: 'recipient@example.com' }),
      }),
    } as never);
    vi.spyOn(PersonaMessageRouteCollection, 'create').mockResolvedValue({
      get: async () => ({
        id: 'route',
        tenantId,
        personaId,
        enabled: true,
        accountId: 'account',
        endpointId: 'endpoint',
      }),
    } as never);
    vi.spyOn(Message.prototype, 'send').mockResolvedValue({ success: true });
    await new PersonaMessagingService({ db, tenantId }).send({
      personaId,
      routeId: 'route',
      body: 'body',
    });
    assertCreated(channel === 'email' ? 'Email' : 'Message');
  });

  it('EmailAccount.syncFrom creates the effective EmailFolder and Email', async () => {
    const account = new EmailAccount({ db, id: 'account' });
    const client = {
      connect: async () => {},
      disconnect: async () => {},
      fetch: async () => [
        { messageId: '<sync@example.com>', subject: 'Synced' },
      ],
    };
    vi.spyOn(account, 'createClient').mockResolvedValue(client as never);
    vi.spyOn(EmailCollection, 'create').mockResolvedValue({
      getByMessageId: async () => null,
      countByFolder: async () => 1,
      countUnreadByFolder: async () => 1,
    } as never);
    vi.spyOn(EmailFolderCollection, 'create').mockResolvedValue({
      getByPath: async () => null,
    } as never);
    const result = await account.syncFrom();
    expect(result.errors).toEqual([]);
    expect(result.messagesDownloaded).toBe(1);
    assertCreated('Email');
    assertCreated('EmailFolder', 2);
  });

  it('missing opt-out returns the effective unsaved, uninitialized NotificationOptOut', async () => {
    vi.spyOn(NotificationOptOutCollection, 'create').mockResolvedValue({
      list: async () => [],
    } as never);
    const result = await new NotificationOptOutService({ db }).optIn({
      tenantId,
      recipientUserId: 'recipient',
      channel: 'email',
      scope: '*',
    });
    expect(result.constructor).toBe(expected.NotificationOptOut);
    expect(result.optedOutAt).toBeNull();
    expect(initialized).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  it.each([
    'createReply',
    'createForward',
  ] as const)('Email.%s returns the effective synchronous draft', (method) => {
    const source = new Email({
      db,
      subject: 'Original',
      fromAddress: 'sender@example.com',
      messageId: '<original@example.com>',
    });
    const draft = source[method]();
    expect(draft.constructor).toBe(expected.Email);
    expect(draft.options.db).toBe(db);
    expect(draft.sendStatus).toBe('draft');
    expect(initialized).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });
});
