/**
 * Adapter that lets `@happyvertical/smrt-app-mcp` gate `confirmTools` calls on
 * a person's approval (#5087, slice 5 of #3716).
 *
 * The object returned by {@link createApprovalMcpGate} satisfies app-mcp's
 * structural `McpApprovalGate` interface; neither package imports the other,
 * so the dependency graph stays acyclic. Wire it as the MCP server's
 * `approvals` option.
 *
 * The calling principal is only ever a REQUESTER and CONSUMER here. It is
 * mapped to a principal that holds no permission, so even if it were handed to
 * `ApprovalService.decide` the service would refuse it (`not_human`,
 * `self_approval`, `forbidden`). Deciding happens in the host's own approval
 * UI or API, by a human principal other than the requester.
 *
 * @packageDocumentation
 */

import { defineApprovalKind } from './kinds.js';
import { APPROVE_MCP_TOOL_PERMISSION } from './permissions.js';
import type { ApprovalService } from './service.js';
import {
  type ApprovalKind,
  type ApprovalPrincipal,
  type ApprovalPrincipalType,
  approvalPrincipalFromPermissions,
} from './types.js';

/** Permission slug a person needs to decide an MCP tool-call approval. */
export const APPROVE_MCP_TOOL_CALL_PERMISSION = APPROVE_MCP_TOOL_PERMISSION;

/** The default kind of an MCP tool-call approval. */
export const mcpToolCallKind: ApprovalKind = defineApprovalKind({
  key: 'mcp.tool.call',
  subject: '@happyvertical/smrt-app-mcp:McpToolCall',
  permission: APPROVE_MCP_TOOL_CALL_PERMISSION,
  defaults: { requiredApprovals: 1, ttlMs: 24 * 60 * 60 * 1000 },
});

/** Most consumed or expired requests one binding may accumulate. */
const MAX_EPOCHS = 100;

/** Structural copy of app-mcp's gate request. */
export interface ApprovalMcpGateRequest {
  tool: string;
  tenantId: string;
  principalId: string;
  principalKind: string | null;
  bindingHash: string;
  requestKey: string;
  summary: string;
}

/** Structural copy of app-mcp's gate result. */
export type ApprovalMcpGateResult =
  | { state: 'approved' }
  | { state: 'pending'; approvalId?: string; created: boolean }
  | { state: 'refused'; reason: string };

/** Options for {@link createApprovalMcpGate}. */
export interface ApprovalMcpGateOptions {
  service: ApprovalService;
  /** Override the approval kind (a tenant may want more approvers). */
  kind?: ApprovalKind;
  /** Clock override for deterministic tests; match the service's clock. */
  now?: () => Date;
}

/**
 * Principal kinds that count as a person at the MCP boundary (`human` is what
 * the framework emits; `owner` and `user` are legacy names). Everything else,
 * including unknown kinds, is treated as an agent: fail closed.
 */
function requesterType(kind: string | null): ApprovalPrincipalType {
  return kind === 'human' || kind === 'owner' || kind === 'user'
    ? 'human'
    : 'agent';
}

/** The requester as an approval principal that can decide nothing. */
function requesterOf(request: ApprovalMcpGateRequest): ApprovalPrincipal {
  return approvalPrincipalFromPermissions([], {
    id: request.principalId,
    tenantId: request.tenantId,
    type: requesterType(request.principalKind),
  });
}

/**
 * Build the `approvals` adapter for `createMcpAppServer`. `check` opens an
 * idempotent request per binding, returns `pending` until a person approves,
 * then consumes the approval (single use) and answers `approved`.
 */
export function createApprovalMcpGate(options: ApprovalMcpGateOptions): {
  check(request: ApprovalMcpGateRequest): Promise<ApprovalMcpGateResult>;
} {
  const { service } = options;
  const kind = options.kind ?? mcpToolCallKind;
  const now = options.now ?? (() => new Date());
  return {
    async check(request) {
      const requester = requesterOf(request);
      // Epoch 0 uses the plain key. A consumed or expired binding moves on to
      // `<key>:<n>`, so an identical later call opens a fresh request while
      // concurrent retries still converge on one live row per epoch.
      for (let epoch = 0; epoch <= MAX_EPOCHS; epoch += 1) {
        const opened = await service.requestApproval(requester, {
          kind,
          subjectId: request.tool,
          subjectRevisionHash: request.bindingHash,
          requestKey:
            epoch === 0 ? request.requestKey : `${request.requestKey}:${epoch}`,
          summary: request.summary,
        });
        if (opened.outcome === 'refused' || !opened.request) {
          return {
            state: 'refused',
            reason: opened.refusal?.reason ?? 'not_found',
          };
        }
        const row = opened.request;
        const created = opened.outcome === 'transitioned';
        const approvalId = String(row.id);
        // The binding already names the principal and tenant; verify the
        // stored row independently so a key collision can never lend an
        // approval.
        if (
          row.tenantId !== request.tenantId ||
          row.requestedBy !== request.principalId ||
          row.subjectId !== request.tool ||
          row.subjectRevisionHash !== request.bindingHash
        ) {
          return { state: 'refused', reason: 'binding_mismatch' };
        }
        const live = row.expiresAtMs() > now().getTime();
        switch (row.status) {
          case 'approved': {
            if (row.isConsumed() || !live) continue;
            const used = await service.consume(
              requester,
              approvalId,
              request.bindingHash,
            );
            if (used.outcome === 'transitioned') return { state: 'approved' };
            const reason = used.refusal?.reason ?? 'not_approved';
            // A concurrent twin consumed it first, or it just expired.
            if (reason === 'already_consumed' || reason === 'expired') continue;
            return { state: 'refused', reason };
          }
          case 'pending':
            if (!live) continue;
            return { state: 'pending', approvalId, created };
          case 'expired':
            continue;
          default:
            // rejected, cancelled, changes_requested: a person said no or
            // asked for changes; only different arguments open a new request.
            return { state: 'refused', reason: row.status };
        }
      }
      return { state: 'refused', reason: 'too_many_requests' };
    },
  };
}
