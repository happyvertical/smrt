/**
 * Persistable per-call audit records for the app-MCP server.
 *
 * The server builds one {@link McpAuditRecord} per tool call from the same
 * event `onToolCall` receives (#4520) and hands it to an {@link McpAuditSink}.
 * A record carries identity, tool, tenant, outcome and argument KEY names only:
 * never argument values, tokens or response bodies, so the log cannot hold
 * secrets or PII. The default persistent sink lives in `./audit` (a SMRT
 * model); this module has no model or database dependency.
 *
 * @packageDocumentation
 */

import type { McpToolCallAuditEvent } from './server.js';

/** Outcome vocabulary of a persisted audit record. */
export type McpAuditOutcome = 'allowed' | 'denied' | 'error';

/** One persisted-shape audit record. */
export interface McpAuditRecord {
  /** The authenticated principal's id (credential id), or `null` when anonymous. */
  principalId: string | null;
  /** The principal's `kind` (for example `agent`, `owner`, `user`), or `null`. */
  principalKind: string | null;
  tool: string;
  /** Host-supplied tenant (defaults to `principal.tenantId`), or `null`. */
  tenantId: string | null;
  outcome: McpAuditOutcome;
  /** Stable safe code of a denial or failure, when there was one. */
  errorCode?: string;
  /** Verified credential identity (issuer, subject, client id), when the adapter stamped one. */
  identityIssuer?: string;
  identitySubject?: string;
  identityClientId?: string;
  /** Sorted argument key names. Values are never recorded. */
  argumentKeys: readonly string[];
  occurredAt: Date;
}

/** Destination for audit records. A failure is reported, never rethrown. */
export interface McpAuditSink {
  record(record: McpAuditRecord): void | Promise<void>;
}

const MAX_ARGUMENT_KEYS = 32;
const MAX_KEY_LENGTH = 120;

/** Key names only, sorted and bounded; values never leave this function. */
export function mcpArgumentKeyNames(args: unknown): string[] {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  return Object.keys(args as Record<string, unknown>)
    .map((key) => key.slice(0, MAX_KEY_LENGTH))
    .sort()
    .slice(0, MAX_ARGUMENT_KEYS);
}

/** Build the record for an audited call event. */
export function mcpAuditRecordFromEvent(
  event: McpToolCallAuditEvent,
): McpAuditRecord {
  return Object.freeze({
    principalId: event.principal?.id ?? null,
    principalKind: event.principal?.kind ?? null,
    tool: event.tool,
    tenantId: event.tenantId,
    outcome: event.outcome === 'ok' ? 'allowed' : event.outcome,
    ...(event.error ? { errorCode: event.error.code } : {}),
    ...(event.identity
      ? {
          identityIssuer: event.identity.issuer,
          identitySubject: event.identity.subject,
          ...(event.identity.clientId
            ? { identityClientId: event.identity.clientId }
            : {}),
        }
      : {}),
    argumentKeys: event.argumentKeys,
    occurredAt: event.occurredAt,
  });
}

/** An in-memory sink for tests and local development. */
export function createInMemoryMcpAuditSink(): McpAuditSink & {
  readonly records: readonly McpAuditRecord[];
  list(query?: McpAuditQuery): McpAuditRecord[];
} {
  const records: McpAuditRecord[] = [];
  return {
    records,
    record(record) {
      records.push(record);
    },
    list(query = {}) {
      return records
        .filter(
          (r) =>
            (query.tenantId === undefined || r.tenantId === query.tenantId) &&
            (query.principalId === undefined ||
              r.principalId === query.principalId) &&
            (query.tool === undefined || r.tool === query.tool) &&
            (query.outcome === undefined || r.outcome === query.outcome),
        )
        .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
        .slice(0, query.limit ?? 100);
    },
  };
}

/** Filter for listing audit records. `tenantId` is the isolation boundary. */
export interface McpAuditQuery {
  /** Required by persistent stores; `null` selects global (no-tenant) rows. */
  tenantId?: string | null;
  principalId?: string;
  tool?: string;
  outcome?: McpAuditOutcome;
  /** 1..500, default 100. */
  limit?: number;
}
