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
 * Principal kinds that count as a person at the MCP boundary. Everything else,
 * including unknown kinds, is treated as an agent: fail closed.
 */
function requesterType(kind: string | null): ApprovalPrincipalType {
  return kind === 'owner' || kind === 'user' ? 'human' : 'agent';
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
      const opened = await service.requestApproval(requester, {
        kind,
        subjectId: request.tool,
        subjectRevisionHash: request.bindingHash,
        requestKey: request.requestKey,
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
      // The binding already names the principal and tenant; verify the stored
      // row independently so a key collision can never lend an approval.
      if (
        row.tenantId !== request.tenantId ||
        row.requestedBy !== request.principalId ||
        row.subjectId !== request.tool ||
        row.subjectRevisionHash !== request.bindingHash
      ) {
        return { state: 'refused', reason: 'binding_mismatch' };
      }
      switch (row.status) {
        case 'approved': {
          const used = await service.consume(
            requester,
            approvalId,
            request.bindingHash,
          );
          if (used.outcome === 'transitioned') return { state: 'approved' };
          return {
            state: 'refused',
            reason: used.refusal?.reason ?? 'not_approved',
          };
        }
        case 'pending':
        case 'changes_requested':
          if (!(row.expiresAtMs() > now().getTime())) {
            return { state: 'refused', reason: 'expired' };
          }
          return { state: 'pending', approvalId, created };
        default:
          // rejected, cancelled, expired
          return { state: 'refused', reason: row.status };
      }
    },
  };
}
