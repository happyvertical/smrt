import type { PrincipalTool } from '@happyvertical/smrt-agents';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  messagingPrincipalFromPermissions,
  PersonaMessagingService,
  SEND_MESSAGES_PERMISSION,
  type SendPersonaMessageOptions,
} from '@happyvertical/smrt-messages';

export const SEND_PERSONA_MESSAGE_TOOL_SLUG = SEND_MESSAGES_PERMISSION;
export const SEND_PERSONA_MESSAGE_FUNCTION_NAME = 'messages-send';

interface PersonaMessageSender {
  send(input: SendPersonaMessageOptions): Promise<unknown>;
}

export interface CreatePersonaMessagingToolOptions {
  /** Fixed persona scope. It is intentionally never accepted from tool args. */
  personaId: string;
  /** Optional tenant assertion in addition to the live principal tenant. */
  tenantId?: string;
  db?: SmrtClassOptions['db'];
  description?: string;
  /** Test/host seam for alternate delivery orchestration. */
  createService?: (options: {
    db: SmrtClassOptions['db'];
    tenantId: string;
    permissions: string[];
  }) => PersonaMessageSender;
}

/**
 * Agent tool for sending through the current persona's configured routes.
 * Account ids, destination addresses, credentials, and persona ids never enter
 * the model-controlled argument surface.
 */
export function createPersonaMessagingTool(
  options: CreatePersonaMessagingToolOptions,
): PrincipalTool {
  if (!options.personaId) throw new Error('personaId is required.');

  return {
    slug: SEND_PERSONA_MESSAGE_TOOL_SLUG,
    aiTool: {
      type: 'function',
      function: {
        name: SEND_PERSONA_MESSAGE_FUNCTION_NAME,
        description:
          options.description ??
          'Send a message to the user through one of this persona’s configured messaging routes.',
        parameters: {
          type: 'object',
          required: ['body'],
          properties: {
            body: { type: 'string', description: 'Message body to send.' },
            subject: {
              type: 'string',
              description: 'Optional subject or topic.',
            },
            channel: {
              type: 'string',
              description:
                'Optional requested channel, such as email, zulip, or telegram.',
            },
            purpose: {
              type: 'string',
              description:
                'Optional route purpose. Defaults to the persona’s default route.',
            },
          },
        },
      },
    },
    async execute({ run, args, db }) {
      run.assertToolAllowed(SEND_PERSONA_MESSAGE_TOOL_SLUG);
      if (!run.permissions.includes(SEND_MESSAGES_PERMISSION)) {
        throw new Error(
          `Missing required permission '${SEND_MESSAGES_PERMISSION}'.`,
        );
      }

      const tenantId = run.context.tenantId;
      if (!tenantId)
        throw new Error(
          'A tenant-bound principal is required to send messages.',
        );
      if (options.tenantId && options.tenantId !== tenantId) {
        throw new Error(
          'The persona messaging tool is bound to another tenant.',
        );
      }

      const body = typeof args.body === 'string' ? args.body.trim() : '';
      if (!body) throw new Error("messages-send requires a non-empty 'body'.");
      const input: SendPersonaMessageOptions = {
        personaId: options.personaId,
        body,
      };
      if (typeof args.subject === 'string' && args.subject.trim()) {
        input.subject = args.subject.trim();
      }
      if (typeof args.channel === 'string' && args.channel.trim()) {
        input.channel = args.channel.trim();
      }
      if (typeof args.purpose === 'string' && args.purpose.trim()) {
        input.purpose = args.purpose.trim();
      }

      const serviceOptions = {
        db: db ?? options.db,
        tenantId,
        permissions: run.permissions,
      };
      if (!options.createService && !serviceOptions.db) {
        throw new Error(
          'A database connection is required to send persona messages.',
        );
      }
      const service = options.createService
        ? options.createService(serviceOptions)
        : new PersonaMessagingService({
            db: serviceOptions.db,
            tenantId,
            principal: messagingPrincipalFromPermissions(run.permissions, {
              id: run.context.userId ?? undefined,
              tenantId,
            }),
          });
      return service.send(input);
    },
  };
}
