/**
 * Approval gate for `confirmTools`-gated calls (#5087, slice 5 of #3716).
 *
 * With an {@link McpApprovalGate} configured, a gated call no longer runs on
 * `confirm: true`: the first call opens an approval request and answers
 * `approval_pending`; a person decides elsewhere (never through this server);
 * the retried identical call consumes the approval and runs once. This module
 * is structural and dependency-free: `@happyvertical/smrt-approvals` ships an
 * adapter (`createApprovalMcpGate`) that satisfies the interface without
 * either package depending on the other.
 *
 * @packageDocumentation
 */

/** Stable codes of the approval outcomes returned to the agent. */
export const MCP_APPROVAL_PENDING_CODE = 'approval_pending';
export const MCP_APPROVAL_REFUSED_CODE = 'approval_refused';
export const MCP_APPROVAL_UNAVAILABLE_CODE = 'approval_unavailable';
/** Audit-only code on the `denied` record of the call that opened a request. */
export const MCP_APPROVAL_REQUESTED_CODE = 'approval_requested';
/** Audit-only code on the `allowed` record of a call that consumed an approval. */
export const MCP_APPROVAL_CONSUMED_CODE = 'approval_consumed';

/** What the gate is asked about one gated call. */
export interface McpApprovalGateRequest {
  tool: string;
  /** Tenant of the calling principal (required; calls without one are refused). */
  tenantId: string;
  /** Authenticated principal id (credential id or user id). */
  principalId: string;
  /** The principal's `kind` (for example `agent`, `owner`). */
  principalKind: string | null;
  /**
   * SHA-256 hex over tool name, canonical arguments (without `confirm`),
   * tenant and principal. Equal bindings mean the identical call.
   */
  bindingHash: string;
  /** Deterministic idempotency key for this binding. */
  requestKey: string;
  /** Short human-readable description for the person deciding. */
  summary: string;
}

/** What the gate decided. Anything but `approved` leaves the call unrun. */
export type McpApprovalGateResult =
  /** An approval was consumed by this very call: run the tool once. */
  | { state: 'approved' }
  /** A request is awaiting a person's decision. `created` is true for the call that opened it. */
  | { state: 'pending'; approvalId?: string; created: boolean }
  /** Rejected, expired, already consumed, mismatched, or otherwise unusable. */
  | { state: 'refused'; reason: string };

/**
 * Host adapter that turns a gated call into an approval request and later
 * consumes the approval. It must fail closed: a thrown error is treated as
 * `approval_unavailable` and the call does not run. It must never expose a way
 * for the calling principal to decide.
 */
export interface McpApprovalGate {
  check(request: McpApprovalGateRequest): Promise<McpApprovalGateResult>;
}

const MAX_DEPTH = 32;

function canonicalize(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new TypeError('arguments too deeply nested');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalize(item, depth + 1)).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError('non-plain object');
      }
      const entries = Object.keys(value as Record<string, unknown>)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonicalize(
              (value as Record<string, unknown>)[key],
              depth + 1,
            )}`,
        );
      return `{${entries.join(',')}}`;
    }
    default:
      throw new TypeError(`unsupported argument type: ${typeof value}`);
  }
}

/**
 * Binding hash of one gated call: SHA-256 hex over a versioned canonical
 * encoding of tool, tenant, principal and arguments (`confirm` excluded by the
 * caller). Throws on a value that is not plain JSON, so an unbindable call is
 * refused rather than approved loosely.
 */
export async function mcpApprovalBindingHash(input: {
  tool: string;
  tenantId: string;
  principalId: string;
  args: Record<string, unknown>;
}): Promise<string> {
  const text = canonicalize(
    [
      'smrt-app-mcp.approval.v1',
      input.tool,
      input.tenantId,
      input.principalId,
      input.args,
    ],
    0,
  );
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** Keys whose values never reach a stored approval snapshot. */
const SECRET_KEY =
  /pass(word|wd|phrase)?|secret|token|api[-_]?key|private[-_]?key|credential|authorization|auth|cookie|session|signature|bearer|(^|[-_])key$/i;

/** Replacement shown instead of a secret-looking value. */
export const MCP_APPROVAL_REDACTED = '[redacted]';

/** Longest snapshot (characters) an approver is asked to review. */
export const MCP_APPROVAL_MAX_SNAPSHOT = 3000;

/**
 * Default redaction: values under secret-looking keys, at any depth, become
 * {@link MCP_APPROVAL_REDACTED}. The binding hash still covers the real
 * values; only the reviewable snapshot is redacted.
 */
export function redactMcpApprovalArguments(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return MCP_APPROVAL_REDACTED;
  if (Array.isArray(value)) {
    return value.map((item) => redactMcpApprovalArguments(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = SECRET_KEY.test(key)
        ? MCP_APPROVAL_REDACTED
        : redactMcpApprovalArguments(
            (value as Record<string, unknown>)[key],
            depth + 1,
          );
    }
    return out;
  }
  return value;
}

/**
 * Server-built approver text from trusted data only: tool name, principal
 * and the redacted argument snapshot as JSON (string values are escaped, so
 * an argument can never forge a line of the summary). Returns `null` when the
 * snapshot is too large to review, so the call is refused rather than
 * approved unseen.
 */
export function buildMcpApprovalSummary(input: {
  tool: string;
  principalId: string;
  principalKind: string | null;
  args: Record<string, unknown>;
  redact?: (tool: string, args: Record<string, unknown>) => unknown;
}): string | null {
  const redacted = redactMcpApprovalArguments(
    input.redact ? input.redact(input.tool, input.args) : input.args,
  );
  const snapshot = JSON.stringify(redacted);
  if (snapshot.length > MCP_APPROVAL_MAX_SNAPSHOT) return null;
  return `MCP tool ${input.tool} requested by ${input.principalKind ?? 'unknown'} principal ${input.principalId}. Arguments (secrets redacted): ${snapshot}`;
}
