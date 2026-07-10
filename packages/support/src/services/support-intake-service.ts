/**
 * SupportIntakeService — channel intake: every inbound interaction on a bound
 * transport container deterministically creates or joins one canonical
 * Support Case (FR-28, issue #1926).
 *
 * Channels are transports, not systems of record: the ChatMessage / Email row
 * stays canonical in its package; intake links it as a
 * {@link SupportInteraction} (idempotent on `sourceKey`) and drives the
 * create-or-join decision by conversation key:
 *
 * - chat: `chat:<roomId>[:<threadId>]` — a bound room is one client
 *   conversation; threads open distinct cases.
 * - email: the RFC thread — a reply (`inReplyTo`) joins the case holding the
 *   referenced message; otherwise the message id starts a new thread key.
 *
 * Join semantics: open case → join; resolved case → reopen + join (the client
 * replied to a "resolved" conversation); closed case → a fresh case.
 *
 * Intake never throws into the source package's save path — the opt-in
 * interceptor (`registerSupportIntake`) swallows and logs intake errors.
 */

import { createLogger } from '@happyvertical/logger';
import type { SmrtObject, SmrtObjectOptions } from '@happyvertical/smrt-core';
import { GlobalInterceptors } from '@happyvertical/smrt-core';
import type { SupportCase } from '../models/support-case.js';
import {
  type SupportChannelBinding,
  SupportChannelBindingCollection,
} from '../models/support-channel-binding.js';
import type { SupportInteraction } from '../models/support-interaction.js';
import { SupportCaseService } from './support-case-service.js';

/** Qualified source types intake understands. */
export const CHAT_MESSAGE_SOURCE_TYPE = '@happyvertical/smrt-chat:ChatMessage';
export const CHAT_ROOM_TARGET_TYPE = '@happyvertical/smrt-chat:ChatRoom';
export const EMAIL_SOURCE_TYPE = '@happyvertical/smrt-messages:Email';
export const EMAIL_ACCOUNT_TARGET_TYPE =
  '@happyvertical/smrt-messages:EmailAccount';

export interface InboundChatMessage {
  messageId: string;
  roomId: string;
  threadId?: string | null;
  senderProfileId: string;
  /** Chat role; only `user` messages are client inbound. */
  role?: string;
  content: string;
  tenantId?: string | null;
  occurredAt?: Date;
}

export interface InboundEmail {
  emailId: string;
  accountId: string;
  fromAddress: string;
  fromName?: string;
  subject?: string;
  body: string;
  /** RFC 822 Message-ID of this email. */
  rfcMessageId?: string | null;
  /** RFC 822 Message-ID this email replies to. */
  inReplyTo?: string | null;
  tenantId?: string | null;
  occurredAt?: Date;
}

export interface IntakeResult {
  outcome: 'created' | 'joined' | 'reopened' | 'skipped';
  reason?: string;
  supportCase?: SupportCase;
  interaction?: SupportInteraction;
  binding?: SupportChannelBinding;
}

export interface SupportIntakeOptions extends SmrtObjectOptions {
  /**
   * Resolve the Client profile for an inbound email sender. When omitted and
   * the binding has no default client, the case is parked with
   * `metadata.unresolvedClient = true` for operator triage.
   */
  resolveClientProfileId?: (input: {
    email: string;
    name?: string;
    tenantId?: string | null;
  }) => Promise<string | null>;
  /**
   * Called after intake creates or updates a case — the AI workflow and the
   * target engine attach here without a hard dependency cycle.
   */
  onCaseIntake?: (result: IntakeResult) => Promise<void>;
}

export class SupportIntakeService {
  readonly caseService: SupportCaseService;
  readonly bindings: SupportChannelBindingCollection;
  private readonly options: SupportIntakeOptions;

  protected constructor(
    caseService: SupportCaseService,
    bindings: SupportChannelBindingCollection,
    options: SupportIntakeOptions,
  ) {
    this.caseService = caseService;
    this.bindings = bindings;
    this.options = options;
  }

  static async create(
    options: SupportIntakeOptions,
  ): Promise<SupportIntakeService> {
    const [caseService, bindings] = await Promise.all([
      SupportCaseService.create(options),
      SupportChannelBindingCollection.create(options),
    ]);
    return new SupportIntakeService(caseService, bindings, options);
  }

  /** Conversation key for a chat room/thread. */
  static chatThreadKey(roomId: string, threadId?: string | null): string {
    return threadId ? `chat:${roomId}:${threadId}` : `chat:${roomId}`;
  }

  /** Idempotency key for a chat message. */
  static chatSourceKey(messageId: string): string {
    return `chat:${messageId}`;
  }

  /** Idempotency key for an email. */
  static emailSourceKey(emailId: string): string {
    return `email:${emailId}`;
  }

  /**
   * Ingest one inbound chat message from a bound room: create-or-join the
   * conversation's case and record the interaction.
   */
  async ingestChatMessage(input: InboundChatMessage): Promise<IntakeResult> {
    if (input.role && input.role !== 'user') {
      return { outcome: 'skipped', reason: `role:${input.role}` };
    }
    const binding = await this.bindings.findForTarget(
      CHAT_ROOM_TARGET_TYPE,
      input.roomId,
    );
    if (!binding) {
      return { outcome: 'skipped', reason: 'no-binding' };
    }

    const threadKey = SupportIntakeService.chatThreadKey(
      input.roomId,
      input.threadId,
    );
    const sourceKey = SupportIntakeService.chatSourceKey(input.messageId);
    const clientProfileId = binding.clientProfileId ?? input.senderProfileId;

    return this.createOrJoin({
      binding,
      threadKey,
      sourceKey,
      tenantId: input.tenantId ?? binding.tenantId ?? null,
      subject: truncateSubject(input.content),
      body: input.content,
      clientProfileId,
      openedByProfileId: input.senderProfileId,
      authorProfileId: input.senderProfileId,
      occurredAt: input.occurredAt,
      sourceType: CHAT_MESSAGE_SOURCE_TYPE,
      sourceId: input.messageId,
      interactionMetadata: {
        roomId: input.roomId,
        threadId: input.threadId ?? null,
      },
    });
  }

  /**
   * Ingest one inbound email from a bound account: joins the RFC thread's
   * case when `inReplyTo` references a known interaction, else creates a new
   * case keyed by the message id. Mail sent FROM the binding's own addresses
   * is skipped (our outbound side of the conversation).
   */
  async ingestEmail(input: InboundEmail): Promise<IntakeResult> {
    const binding = await this.bindings.findForTarget(
      EMAIL_ACCOUNT_TARGET_TYPE,
      input.accountId,
    );
    if (!binding) {
      return { outcome: 'skipped', reason: 'no-binding' };
    }
    const from = input.fromAddress.trim().toLowerCase();
    if (binding.getSelfAddresses().includes(from)) {
      return { outcome: 'skipped', reason: 'self-address' };
    }

    const sourceKey = SupportIntakeService.emailSourceKey(input.emailId);

    // A reply joins the case that holds the referenced message.
    let threadKey: string | null = null;
    if (input.inReplyTo) {
      const parent = await this.findInteractionByRfcMessageId(input.inReplyTo);
      if (parent) {
        const parentCase = await this.caseService.cases.get({
          id: parent.caseId,
        });
        if (parentCase) {
          threadKey = parentCase.threadKey;
        }
      }
    }
    if (!threadKey) {
      threadKey = `email:${input.rfcMessageId || input.emailId}`;
    }

    let clientProfileId = binding.clientProfileId ?? null;
    let unresolvedClient = false;
    if (!clientProfileId && this.options.resolveClientProfileId) {
      clientProfileId = await this.options.resolveClientProfileId({
        email: input.fromAddress,
        name: input.fromName,
        tenantId: input.tenantId ?? binding.tenantId ?? null,
      });
    }
    if (!clientProfileId) {
      unresolvedClient = true;
    }

    return this.createOrJoin({
      binding,
      threadKey,
      sourceKey,
      tenantId: input.tenantId ?? binding.tenantId ?? null,
      subject: input.subject?.trim() || truncateSubject(input.body),
      body: input.body,
      clientProfileId,
      openedByProfileId: clientProfileId,
      authorProfileId: clientProfileId,
      occurredAt: input.occurredAt,
      sourceType: EMAIL_SOURCE_TYPE,
      sourceId: input.emailId,
      caseMetadata: unresolvedClient
        ? { unresolvedClient: true, fromAddress: input.fromAddress }
        : undefined,
      interactionMetadata: {
        fromAddress: input.fromAddress,
        fromName: input.fromName ?? null,
        rfcMessageId: input.rfcMessageId ?? null,
        inReplyTo: input.inReplyTo ?? null,
      },
    });
  }

  /** The shared create-or-join core (deterministic per conversation key). */
  private async createOrJoin(input: {
    binding: SupportChannelBinding;
    threadKey: string;
    sourceKey: string;
    tenantId: string | null;
    subject: string;
    body: string;
    clientProfileId: string | null;
    openedByProfileId: string | null;
    authorProfileId: string | null;
    occurredAt?: Date;
    sourceType: string;
    sourceId: string;
    caseMetadata?: Record<string, unknown>;
    interactionMetadata?: Record<string, unknown>;
  }): Promise<IntakeResult> {
    const { binding } = input;

    // Idempotency: the same transport record never produces two interactions.
    const existing = await this.caseService.interactions.bySourceKey(
      input.sourceKey,
    );
    if (existing) {
      const supportCase = await this.caseService.cases.get({
        id: existing.caseId,
      });
      return {
        outcome: 'joined',
        reason: 'duplicate-source',
        supportCase: supportCase ?? undefined,
        interaction: existing,
        binding,
      };
    }

    let outcome: IntakeResult['outcome'];
    let supportCase = await this.caseService.cases.findOpenByThreadKey(
      input.threadKey,
      { bindingId: binding.id },
    );

    if (supportCase) {
      outcome = 'joined';
    } else {
      const resolved = await this.findResolvedByThreadKey(
        input.threadKey,
        binding.id ?? null,
      );
      if (resolved) {
        supportCase = await this.caseService.reopen(resolved, {
          actorKind: 'client',
          actorProfileId: input.authorProfileId,
          reason: 'new inbound interaction on resolved case',
        });
        outcome = 'reopened';
      } else {
        supportCase = await this.caseService.openCase({
          tenantId: input.tenantId,
          subject: input.subject,
          description: input.body,
          channelKind: binding.channelKind,
          clientProfileId: input.clientProfileId,
          openedByProfileId: input.openedByProfileId,
          projectId: binding.projectId ?? null,
          bindingId: binding.id ?? null,
          threadKey: input.threadKey,
          planId: binding.planId ?? null,
          metadata: input.caseMetadata,
        });
        outcome = 'created';
      }
    }

    const interaction = await this.caseService.recordInteraction(supportCase, {
      direction: 'inbound',
      channelKind: binding.channelKind,
      actorKind: 'client',
      authorProfileId: input.authorProfileId,
      body: input.body,
      occurredAt: input.occurredAt,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceKey: input.sourceKey,
      metadata: input.interactionMetadata,
    });

    const result: IntakeResult = {
      outcome,
      supportCase,
      interaction,
      binding,
    };
    if (this.options.onCaseIntake) {
      await this.options.onCaseIntake(result);
    }
    return result;
  }

  private async findResolvedByThreadKey(
    threadKey: string,
    bindingId: string | null,
  ): Promise<SupportCase | null> {
    const where: Record<string, unknown> = { threadKey, status: 'resolved' };
    if (bindingId) {
      where.bindingId = bindingId;
    }
    const matches = await this.caseService.cases.list({
      where,
      orderBy: 'updated_at DESC',
      limit: 1,
    });
    return matches[0] ?? null;
  }

  private async findInteractionByRfcMessageId(
    rfcMessageId: string,
  ): Promise<SupportInteraction | null> {
    // rfcMessageId lives in interaction metadata; scan recent email
    // interactions (metadata is a JSON text column, so filter in memory).
    const candidates = await this.caseService.interactions.list({
      where: { sourceType: EMAIL_SOURCE_TYPE },
      orderBy: 'occurred_at DESC',
      limit: 500,
    });
    return (
      candidates.find(
        (interaction) =>
          (interaction.getMetadata().rfcMessageId ?? null) === rfcMessageId,
      ) ?? null
    );
  }
}

function truncateSubject(body: string, max = 120): string {
  const firstLine = (body ?? '').split('\n', 1)[0]?.trim() ?? '';
  if (firstLine.length <= max) {
    return firstLine || '(no subject)';
  }
  return `${firstLine.slice(0, max - 1)}…`;
}

/** Interceptor name used for registration/unregistration. */
export const SUPPORT_INTAKE_INTERCEPTOR = 'smrt-support:intake';

/**
 * Opt-in ambient intake: observe saves of `ChatMessage` and `Email` rows via
 * core `GlobalInterceptors` and feed them through the intake service. Only
 * containers with an enabled {@link SupportChannelBinding} produce cases;
 * everything else passes through untouched. Errors are logged, never thrown —
 * intake must not break the source package's save path.
 *
 * @returns An unregister function.
 */
export function registerSupportIntake(
  intake: SupportIntakeService,
  options: { onError?: (error: unknown, instance: SmrtObject) => void } = {},
): () => void {
  const handleError = (error: unknown, instance: SmrtObject) => {
    if (options.onError) {
      options.onError(error, instance);
      return;
    }
    // Lazy logger: created on first failure, never at module scope (a
    // module-scope createLogger reads process.env and breaks browser builds).
    createLogger(true).error('[smrt-support] intake failed', { error });
  };

  GlobalInterceptors.register({
    name: SUPPORT_INTAKE_INTERCEPTOR,
    async afterSave(instance) {
      const record = instance as unknown as Record<string, unknown>;
      try {
        const className = instance.constructor?.name;
        if (className === 'ChatMessage') {
          // Only freshly created user messages are inbound client activity.
          if (record.isDeleted === true) return;
          await intake.ingestChatMessage({
            messageId: String(record.id ?? ''),
            roomId: String(record.roomId ?? ''),
            threadId: (record.threadId as string | null) ?? null,
            senderProfileId: String(record.senderProfileId ?? ''),
            role: (record.role as string | undefined) ?? 'user',
            content: String(record.content ?? ''),
            tenantId: (record.tenantId as string | null) ?? null,
            occurredAt:
              record.created_at instanceof Date ? record.created_at : undefined,
          });
        } else if (className === 'Email') {
          await intake.ingestEmail({
            emailId: String(record.id ?? ''),
            accountId: String(record.accountId ?? ''),
            fromAddress: String(record.fromAddress ?? ''),
            fromName: (record.fromName as string | undefined) ?? undefined,
            subject: (record.subject as string | undefined) ?? undefined,
            body: String(record.textBody ?? record.body ?? ''),
            rfcMessageId: (record.messageId as string | null) ?? null,
            inReplyTo: (record.inReplyTo as string | null) ?? null,
            tenantId: (record.tenantId as string | null) ?? null,
            occurredAt: record.date instanceof Date ? record.date : undefined,
          });
        }
      } catch (error) {
        handleError(error, instance);
      }
    },
  });

  return () => {
    GlobalInterceptors.unregister(SUPPORT_INTAKE_INTERCEPTOR);
  };
}

export default SupportIntakeService;
