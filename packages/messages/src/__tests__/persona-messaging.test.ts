import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageCollection } from '../collections/MessageCollection.js';
import { MessagingEndpoint } from '../models/MessagingEndpoint.js';
import { PersonaMessageRoute } from '../models/PersonaMessageRoute.js';
import { TelegramAccount } from '../models/TelegramAccount.js';
import {
  MANAGE_MESSAGE_ROUTES_PERMISSION,
  messagingPrincipalFromPermissions,
  SEND_MESSAGES_PERMISSION,
} from '../permissions.js';
import {
  getMessagingProvider,
  listMessagingProviders,
  registerMessagingProvider,
} from '../providers.js';
import { MessagingSettingsService } from '../services/MessagingSettingsService.js';
import { PersonaMessagingService } from '../services/PersonaMessagingService.js';

describe('messaging provider contract', () => {
  it('publishes setup fields without credential values and reserves SMS', () => {
    const telegram = getMessagingProvider('telegram');
    expect(telegram?.credentialFields).toEqual([
      expect.objectContaining({ id: 'botToken', type: 'password' }),
    ]);
    expect(telegram).not.toHaveProperty('credentials');
    expect(
      listMessagingProviders().map((provider) => provider.id),
    ).not.toContain('sms');
    expect(getMessagingProvider('sms')).toMatchObject({
      channel: 'sms',
      available: false,
    });
  });

  it('accepts a concrete SMS provider without changing route models', () => {
    const unregister = registerMessagingProvider({
      id: 'test-sms',
      label: 'Test SMS',
      channel: 'sms',
      available: true,
      configurationFields: [],
      credentialFields: [
        { id: 'token', label: 'Token', type: 'password', required: true },
      ],
      endpointFields: [
        {
          id: 'phoneNumber',
          label: 'Phone number',
          type: 'string',
          required: true,
        },
      ],
      createSender: async () => ({
        providerType: 'test-sms',
        isReady: () => true,
        send: async () => ({ success: true, sentAt: new Date() }),
      }),
    });
    try {
      expect(getMessagingProvider('test-sms')).toMatchObject({
        channel: 'sms',
        available: true,
      });
    } finally {
      unregister();
    }
  });
});

describe('PersonaMessagingService', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await db.close?.();
  });

  it('persists and sends through the persona default Telegram route', async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', request);

    const tenantId = crypto.randomUUID();
    const personaId = crypto.randomUUID();
    await withTenant({ tenantId }, async () => {
      const account = new TelegramAccount({
        db,
        tenantId,
        name: 'My bot',
        // Deprecated plaintext fallback is used only to keep this transport
        // integration test independent from the smrt-secrets key fixture.
        settings: JSON.stringify({ botToken: '12345:test_token' }),
      });
      await account.initialize();
      await account.save();

      const endpoint = new MessagingEndpoint({
        db,
        tenantId,
        label: 'Me',
        channel: 'telegram',
        address: JSON.stringify({ chatId: '987', threadId: '12' }),
      });
      await endpoint.initialize();
      await endpoint.save();
      if (!account.id || !endpoint.id) throw new Error('Test setup failed');

      const route = new PersonaMessageRoute({
        db,
        tenantId,
        personaId,
        accountId: account.id,
        endpointId: endpoint.id,
        purpose: 'default',
        priority: 10,
      });
      await route.initialize();
      await route.save();

      const service = new PersonaMessagingService({
        db,
        tenantId,
        principal: messagingPrincipalFromPermissions(
          [SEND_MESSAGES_PERMISSION],
          { tenantId },
        ),
      });
      const result = await service.send({
        personaId,
        body: 'Build finished.',
      });

      expect(result.delivery).toMatchObject({
        success: true,
        providerMessageId: '42',
      });
      expect(request).toHaveBeenCalledOnce();
      const [url, init] = request.mock.calls[0];
      expect(String(url)).toContain('/sendMessage');
      expect(JSON.parse(String(init?.body))).toEqual({
        chat_id: '987',
        text: 'Build finished.',
        message_thread_id: 12,
      });

      const messages = await MessageCollection.create({ db });
      const persisted = await messages.get({ id: result.messageId });
      expect(persisted).toMatchObject({
        personaId,
        endpointId: endpoint.id,
        sendStatus: 'sent',
      });
    });
  });

  it('rejects a principal without messages.send', async () => {
    const tenantId = crypto.randomUUID();
    const service = new PersonaMessagingService({
      db,
      tenantId,
      principal: messagingPrincipalFromPermissions([], { tenantId }),
    });
    await expect(
      service.send({ personaId: crypto.randomUUID(), body: 'Nope' }),
    ).rejects.toThrow("Missing required permission 'messages.send'");
  });

  it('requires proof that a routed persona belongs to the tenant', async () => {
    const tenantId = crypto.randomUUID();
    const personaId = crypto.randomUUID();
    await withTenant({ tenantId }, async () => {
      const account = new TelegramAccount({
        db,
        tenantId,
        name: 'Bot',
      });
      await account.initialize();
      await account.save();
      const endpoint = new MessagingEndpoint({
        db,
        tenantId,
        label: 'Owner',
        channel: 'telegram',
        address: JSON.stringify({ chatId: '123' }),
      });
      await endpoint.initialize();
      await endpoint.save();
      if (!account.id || !endpoint.id) throw new Error('Test setup failed');

      const denied = new MessagingSettingsService({
        db,
        tenantId,
        principal: messagingPrincipalFromPermissions(
          [MANAGE_MESSAGE_ROUTES_PERMISSION],
          { tenantId },
        ),
        resolvePersonaTenantId: async () => 'another-tenant',
      });
      await expect(
        denied.saveRoute({
          personaId,
          accountId: account.id,
          endpointId: endpoint.id,
        }),
      ).rejects.toThrow('Messaging persona was not found in this tenant');

      const allowed = new MessagingSettingsService({
        db,
        tenantId,
        principal: messagingPrincipalFromPermissions(
          [MANAGE_MESSAGE_ROUTES_PERMISSION],
          { tenantId },
        ),
        resolvePersonaTenantId: async () => tenantId,
      });
      const route = await allowed.saveRoute({
        personaId,
        accountId: account.id,
        endpointId: endpoint.id,
      });
      expect(route).toMatchObject({ personaId, tenantId, purpose: 'default' });

      const settings = await allowed.list(personaId);
      expect(settings.endpoints[0]).toMatchObject({
        maskedAddress: '••••',
      });
      expect(settings.endpoints[0]).not.toHaveProperty('address');
    });
  });
});
