/**
 * Adapter that lets `@happyvertical/smrt-messages` hold an agent's outgoing
 * mail until a person approves it (smrt#5141, Epic I).
 *
 * The object returned by {@link createApprovalMailSendGate} satisfies
 * smrt-messages' structural `MailSendApprovalGate` interface. Neither package
 * imports the other, so the dependency graph stays acyclic (the
 * `mcp-gate.ts` precedent). Wire it with smrt-messages'
 * `configureMailSendApprovals({ gate })`.
 *
 * Who may do what is decided here only in part: smrt-messages resolves the
 * acting principal, checks the mail account's `send` scope, and re-checks
 * every counted approver's `send` scope before it consumes. This adapter
 * maps the requester to a principal that holds no permission (an agent can
 * never decide its own send), and maps a decider to a `human` principal only
 * when smrt-messages labels it a person.
 *
 * @packageDocumentation
 */

import { defineApprovalKind, isPermissionSlug } from './kinds.js';
import type { ApprovalService } from './service.js';
import {
  ApprovalError,
  type ApprovalKind,
  type ApprovalPrincipal,
  type ApprovalPrincipalType,
  type ApprovalStatus,
  approvalPrincipalFromPermissions,
} from './types.js';

/** Tenant permission a person needs to decide a held mail send. */
export const APPROVE_MAIL_SEND_PERMISSION = 'messages.send';

/**
 * The default kind of a held mail send. Edit-then-approve is allowed: the
 * decider holds `send` on the account, so they may send their own words.
 */
export const mailSendKind: ApprovalKind = defineApprovalKind({
  key: 'messages.mail.send',
  subject: '@happyvertical/smrt-messages:Message',
  permission: APPROVE_MAIL_SEND_PERMISSION,
  allowRevisedApproval: true,
  defaults: { requiredApprovals: 1, ttlMs: 7 * 24 * 60 * 60 * 1000 },
});

/** Most consumed or expired requests one draft revision may accumulate. */
const MAX_EPOCHS = 100;

/** Structural copy of smrt-messages' gate actor. */
export interface ApprovalMailSendActor {
  /** Canonical actor id (the smrt-users `User` id). */
  id: string;
  /** Host label; only `person` or `human` can decide. */
  kind: string | null;
  /** Tenant permission slugs smrt-messages verified for this actor. */
  permissions?: readonly string[];
}

/** Structural copy of smrt-messages' check request. */
export interface ApprovalMailSendCheck {
  tenantId: string;
  messageId: string;
  bindingHash: string;
  requester: ApprovalMailSendActor;
  summary: string;
}

/**
 * Structural copy of smrt-messages' check result. `approved` means a person
 * approved this revision and it waits for them to release it; `check` never
 * consumes, so the requester can never send it itself.
 */
export type ApprovalMailSendCheckResult =
  | { state: 'approved'; approvalId: string; approverIds: string[] }
  | { state: 'pending'; approvalId: string; created: boolean }
  | { state: 'refused'; reason: string; approvalId?: string };

/** Structural copy of smrt-messages' decision input. */
export interface ApprovalMailSendDecision {
  tenantId: string;
  approvalId: string;
  decider: ApprovalMailSendActor;
  decision: 'approve' | 'reject';
  reason?: string;
  /** The draft revision the decider reviewed. */
  expectedBindingHash: string;
  /** Edit-then-approve: the revision after the decider's edits. */
  revisedBindingHash?: string;
}

/** Structural copy of smrt-messages' view of one held send. */
export interface ApprovalMailSendView {
  approvalId: string;
  messageId: string;
  status: ApprovalStatus;
  bindingHash: string;
  requesterId: string;
  requesterType: ApprovalPrincipalType;
  consumed: boolean;
  live: boolean;
  /** Distinct human approvers of the bound revision. */
  approverIds: string[];
}

/** Structural copy of smrt-messages' decision / consume result. */
export type ApprovalMailSendOutcome =
  | { ok: true; view: ApprovalMailSendView }
  | { ok: false; reason: string; view?: ApprovalMailSendView };

/** Options for {@link createApprovalMailSendGate}. */
export interface ApprovalMailSendGateOptions {
  service: ApprovalService;
  /** Override the approval kind (it must stay subject `Message`). */
  kind?: ApprovalKind;
  /** Clock override for deterministic tests; match the service's clock. */
  now?: () => Date;
}

/** Only an explicit person label decides; everything else is an agent. */
function actorType(kind: string | null | undefined): ApprovalPrincipalType {
  return kind === 'person' || kind === 'human' ? 'human' : 'agent';
}

function principalOf(
  tenantId: string,
  actor: ApprovalMailSendActor,
  permissions: readonly string[],
): ApprovalPrincipal {
  return approvalPrincipalFromPermissions(permissions, {
    id: actor.id,
    tenantId,
    type: actorType(actor.kind),
  });
}

/**
 * Build the mail-send approval gate. `check` opens an idempotent request per
 * draft revision and reports its state (`pending`, `approved`, refused); it
 * never consumes, so an approved send leaves only when an approving person
 * releases it through `consume`, which re-verifies the approvers through the
 * caller first (single use). `decide` and `get` serve the deciding person.
 */
export function createApprovalMailSendGate(
  options: ApprovalMailSendGateOptions,
): {
  check(request: ApprovalMailSendCheck): Promise<ApprovalMailSendCheckResult>;
  get(
    tenantId: string,
    approvalId: string,
    reader: ApprovalMailSendActor,
  ): Promise<ApprovalMailSendView | null>;
  decide(input: ApprovalMailSendDecision): Promise<ApprovalMailSendOutcome>;
  consume(input: {
    tenantId: string;
    approvalId: string;
    consumer: ApprovalMailSendActor;
    bindingHash: string;
    verifyApprovers(approverIds: string[]): Promise<boolean>;
  }): Promise<ApprovalMailSendOutcome>;
} {
  const { service } = options;
  const kind = options.kind ?? mailSendKind;
  const now = options.now ?? (() => new Date());

  async function view(
    principal: ApprovalPrincipal,
    approvalId: string,
  ): Promise<ApprovalMailSendView | null> {
    const row = await service.getRequest(principal, approvalId);
    if (!row || row.kind !== kind.key || row.subjectType !== kind.subject) {
      return null;
    }
    const events = await service.listEvents(principal, approvalId);
    const approverIds = [
      ...new Set(
        events
          .filter(
            (event) =>
              event.type === 'approved' &&
              event.actorType === 'human' &&
              event.subjectRevisionHash === row.subjectRevisionHash &&
              // As the service counts: a requester's own vote only with the
              // ledgered self-approval allowance.
              (event.actorId !== row.requestedBy ||
                (event.selfApproved === true &&
                  isPermissionSlug(event.selfApprovalPermission))),
          )
          .map((event) => event.actorId),
      ),
    ];
    return {
      approvalId: String(row.id),
      messageId: row.subjectId,
      status: row.status,
      bindingHash: row.subjectRevisionHash,
      requesterId: row.requestedBy,
      requesterType: row.requestedByType,
      consumed: row.isConsumed(),
      live: row.expiresAtMs() > now().getTime(),
      approverIds,
    };
  }

  async function consumeVerified(
    principal: ApprovalPrincipal,
    approvalId: string,
    bindingHash: string,
    verifyApprovers: (ids: string[]) => Promise<boolean>,
  ): Promise<ApprovalMailSendOutcome> {
    const current = await view(principal, approvalId);
    if (!current) return { ok: false, reason: 'not_found' };
    // Verify the final approver set only: before quorum the list is partial.
    if (current.status !== 'approved') {
      return { ok: false, reason: 'not_approved', view: current };
    }
    if (current.bindingHash !== bindingHash) {
      return { ok: false, reason: 'revision_mismatch', view: current };
    }
    if (
      current.approverIds.length === 0 ||
      !(await verifyApprovers(current.approverIds))
    ) {
      return { ok: false, reason: 'approver_not_authorized', view: current };
    }
    const used = await service.consume(principal, approvalId, bindingHash);
    const after = (await view(principal, approvalId)) ?? current;
    if (used.outcome === 'transitioned') return { ok: true, view: after };
    return {
      ok: false,
      reason: used.refusal?.reason ?? 'not_approved',
      view: after,
    };
  }

  return {
    async check(request) {
      // The requester holds no permission: it can request and consume, never
      // decide, whatever kind label the host gave it.
      const requester = principalOf(request.tenantId, request.requester, []);
      const baseKey = `mail-send:${request.messageId}:${request.bindingHash}`;
      // Epoch 0 uses the plain key. A consumed or expired revision moves on
      // to `<key>:<n>`, so resending identical content opens a fresh request
      // while concurrent retries converge on one live row per epoch.
      for (let epoch = 0; epoch <= MAX_EPOCHS; epoch += 1) {
        const opened = await service.requestApproval(requester, {
          kind,
          subjectId: request.messageId,
          subjectRevisionHash: request.bindingHash,
          requestKey: epoch === 0 ? baseKey : `${baseKey}:${epoch}`,
          summary: request.summary,
        });
        // The key's request was rebound by edit-then-approve (the stored
        // revision no longer matches the key): move on to the next epoch.
        if (opened.refusal?.reason === 'request_key_conflict') continue;
        if (opened.outcome === 'refused' || !opened.request) {
          return {
            state: 'refused',
            reason: opened.refusal?.reason ?? 'not_found',
          };
        }
        const row = opened.request;
        const approvalId = String(row.id);
        // Verify the stored row independently so a key collision can never
        // lend an approval to another draft, requester or tenant.
        if (
          row.tenantId !== request.tenantId ||
          row.requestedBy !== request.requester.id ||
          row.subjectId !== request.messageId
        ) {
          return { state: 'refused', reason: 'binding_mismatch', approvalId };
        }
        // Edit-then-approve rebound this request to another revision; the
        // key's revision needs a request of its own in the next epoch.
        if (row.subjectRevisionHash !== request.bindingHash) continue;
        const live = row.expiresAtMs() > now().getTime();
        switch (row.status) {
          case 'approved': {
            if (row.isConsumed() || !live) continue;
            // Released only by an approving person (`consume`), never here.
            const current = await view(requester, approvalId);
            return {
              state: 'approved',
              approvalId,
              approverIds: current?.approverIds ?? [],
            };
          }
          case 'pending':
            if (!live) continue;
            return {
              state: 'pending',
              approvalId,
              created: opened.outcome === 'transitioned',
            };
          case 'expired':
            continue;
          default:
            // rejected, cancelled, changes_requested: a person said no; only
            // a changed draft (a new revision) opens a new request.
            return { state: 'refused', reason: row.status, approvalId };
        }
      }
      return { state: 'refused', reason: 'too_many_requests' };
    },

    async get(tenantId, approvalId, reader) {
      return await view(principalOf(tenantId, reader, []), approvalId);
    },

    async decide(input) {
      if (
        typeof input.expectedBindingHash !== 'string' ||
        !input.expectedBindingHash.trim()
      ) {
        throw new ApprovalError(
          'APPROVAL_INVALID',
          'A mail-send decision must name the reviewed expectedBindingHash.',
        );
      }
      const decider = principalOf(
        input.tenantId,
        input.decider,
        input.decider.permissions ?? [],
      );
      const before = await view(decider, input.approvalId);
      if (!before) return { ok: false, reason: 'not_found' };
      const result = await service.decide(decider, input.approvalId, {
        decision: input.decision,
        reason: input.reason,
        expectedSubjectRevisionHash: input.expectedBindingHash,
        ...(input.revisedBindingHash !== undefined
          ? { revisedSubjectRevisionHash: input.revisedBindingHash }
          : {}),
      });
      const after = (await view(decider, input.approvalId)) ?? before;
      if (result.outcome === 'refused') {
        return {
          ok: false,
          reason: result.refusal?.reason ?? 'refused',
          view: after,
        };
      }
      return { ok: true, view: after };
    },

    async consume(input) {
      // The consumer holds no permission; consuming needs none.
      const consumer = principalOf(input.tenantId, input.consumer, []);
      return await consumeVerified(
        consumer,
        input.approvalId,
        input.bindingHash,
        input.verifyApprovers,
      );
    },
  };
}
