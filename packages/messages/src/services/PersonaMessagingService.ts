import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { AccountCollection } from '../collections/AccountCollection.js';
import { MessagingEndpointCollection } from '../collections/MessagingEndpointCollection.js';
import { PersonaMessageRouteCollection } from '../collections/PersonaMessageRouteCollection.js';
import { Email } from '../models/Email.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { Message } from '../models/Message.js';
import type { PersonaMessageRoute } from '../models/PersonaMessageRoute.js';
import {
  assertMessagingPermission,
  type MessagingPrincipal,
  SEND_MESSAGES_PERMISSION,
} from '../permissions.js';
import type { MessageSendResult, SendPersonaMessageOptions } from '../types.js';

export interface PersonaMessageSendResult {
  routeId: string;
  messageId: string;
  delivery: MessageSendResult;
}

/** Resolves a persona-owned route and delivers a persisted outbound message. */
export class PersonaMessagingService {
  constructor(
    private readonly options: {
      db: SmrtClassOptions['db'];
      tenantId: string;
      /** Omit only for trusted system code that performs its own authorization. */
      principal?: MessagingPrincipal;
    },
  ) {}

  async send(
    input: SendPersonaMessageOptions,
  ): Promise<PersonaMessageSendResult> {
    if (this.options.principal) {
      assertMessagingPermission(
        this.options.principal,
        this.options.tenantId,
        SEND_MESSAGES_PERMISSION,
      );
    }
    if (!input.personaId)
      throw new Error('A persona is required to send a message.');
    if (!input.body.trim()) throw new Error('Message body cannot be empty.');

    return withTenant({ tenantId: this.options.tenantId }, async () => {
      const route = await this.resolveRoute(input);
      const accounts = await AccountCollection.create({ db: this.options.db });
      const endpoints = await MessagingEndpointCollection.create({
        db: this.options.db,
      });
      const [account, endpoint] = await Promise.all([
        accounts.get({ id: route.accountId }),
        endpoints.get({ id: route.endpointId }),
      ]);
      if (
        !account ||
        account.tenantId !== this.options.tenantId ||
        !account.isActive
      ) {
        throw new Error('The selected messaging account is unavailable.');
      }
      if (
        !endpoint ||
        endpoint.tenantId !== this.options.tenantId ||
        !endpoint.isActive
      ) {
        throw new Error('The selected messaging endpoint is unavailable.');
      }
      if (account.channelType !== endpoint.channel) {
        throw new Error(
          'The selected messaging route has mismatched channels.',
        );
      }

      let message: Message;
      const base = {
        db: this.options.db,
        tenantId: this.options.tenantId,
        accountId: route.accountId,
        endpointId: route.endpointId,
        personaId: input.personaId,
        correlationId: input.correlationId ?? '',
        subject: input.subject ?? '',
        body: input.body.trim(),
        sendStatus: 'pending' as const,
      };
      if (endpoint.channel === 'email') {
        if (!(account instanceof EmailAccount)) {
          throw new Error('Email routes require an EmailAccount.');
        }
        const address = endpoint.getAddress<{ email?: string }>();
        if (!address.email) throw new Error('Email endpoint has no address.');
        const email = new Email({ ...base, textBody: base.body });
        email.setToAddresses([{ address: address.email }]);
        message = email;
      } else {
        message = new Message(base);
      }
      await message.initialize();
      await message.save();
      const delivery = await message.send();
      return {
        routeId: route.id ?? '',
        messageId: message.id ?? '',
        delivery,
      };
    });
  }

  private async resolveRoute(
    input: SendPersonaMessageOptions,
  ): Promise<PersonaMessageRoute> {
    const routes = await PersonaMessageRouteCollection.create({
      db: this.options.db,
    });
    if (input.routeId) {
      const route = await routes.get({ id: input.routeId });
      if (
        !route ||
        route.tenantId !== this.options.tenantId ||
        route.personaId !== input.personaId ||
        !route.enabled
      ) {
        throw new Error(
          'The requested persona messaging route is unavailable.',
        );
      }
      return route;
    }

    let candidates = await routes.forPersona(input.personaId);
    if (input.purpose) {
      candidates = candidates.filter(
        (route) => route.purpose === input.purpose,
      );
    } else {
      const defaults = candidates.filter(
        (route) => route.purpose === 'default',
      );
      if (defaults.length > 0) candidates = defaults;
    }
    candidates.sort((left, right) => right.priority - left.priority);

    if (input.channel) {
      const endpoints = await MessagingEndpointCollection.create({
        db: this.options.db,
      });
      for (const route of candidates) {
        const endpoint = await endpoints.get({ id: route.endpointId });
        if (endpoint?.channel === input.channel) return route;
      }
      throw new Error(
        `No ${input.channel} route is configured for this persona.`,
      );
    }

    const route = candidates[0];
    if (!route)
      throw new Error('No messaging route is configured for this persona.');
    return route;
  }
}
