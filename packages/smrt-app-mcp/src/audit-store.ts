// Self-register this package's manifest for consumers that import via this
// subpath without the main entry (smrt#1132).
import './__smrt-register__.js';

import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  TenantScoped,
  tenantId,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type {
  McpAuditOutcome,
  McpAuditQuery,
  McpAuditRecord,
  McpAuditSink,
} from './audit.js';

/**
 * One persisted MCP tool call. Stores identity, tool, tenant, outcome and
 * argument KEY names only: never argument values or response bodies.
 */
@smrt({
  tableName: 'smrt_mcp_call_audits',
  // Audit rows are read through `McpCallAuditCollection.listAudits`, which
  // requires an explicit tenant; no generated read surface (fail closed).
  api: false,
  mcp: false,
  cli: false,
})
@TenantScoped({ mode: 'optional' })
export class McpCallAudit extends SmrtObject {
  /** The tenant the call ran for; `null` for a global/anonymous call. */
  @tenantId({ nullable: true })
  tenantId: string | null | undefined = undefined;

  /** The principal id (credential id); `null` for an anonymous call. */
  @field({ type: 'text', nullable: true })
  principalId: string | null = null;

  /** The principal kind (agent, owner, user, ...); `null` when unknown. */
  @field({ type: 'text', nullable: true })
  principalKind: string | null = null;

  @field({ type: 'text', nullable: true })
  identityIssuer: string | null = null;

  @field({ type: 'text', nullable: true })
  identitySubject: string | null = null;

  @field({ type: 'text', nullable: true })
  identityClientId: string | null = null;

  /**
   * The tool the call named. Required for identity: the record exists to say
   * which tool ran, and `listAudits` looks rows up by it.
   */
  @field({ type: 'text', required: true, requiredFor: 'identity', default: '' })
  tool = '';

  @field({ type: 'text', required: true, default: 'allowed' })
  outcome: McpAuditOutcome = 'allowed';

  @field({ type: 'text', nullable: true })
  errorCode: string | null = null;

  @field({ type: 'json' })
  argumentKeys: string[] = [];

  @field({ type: 'datetime', required: true })
  occurredAt: Date = new Date();
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Tenant-aware persistence and queries for {@link McpCallAudit}. */
export class McpCallAuditCollection extends SmrtCollection<McpCallAudit> {
  static readonly _itemClass = McpCallAudit;

  /** Persist one record under its own tenant (or the global scope). */
  async append(record: McpAuditRecord): Promise<McpCallAudit> {
    const write = () =>
      this.create({
        tenantId: record.tenantId,
        principalId: record.principalId,
        principalKind: record.principalKind,
        identityIssuer: record.identityIssuer ?? null,
        identitySubject: record.identitySubject ?? null,
        identityClientId: record.identityClientId ?? null,
        tool: record.tool,
        outcome: record.outcome,
        errorCode: record.errorCode ?? null,
        argumentKeys: [...record.argumentKeys],
        occurredAt: record.occurredAt,
      });
    return record.tenantId
      ? withTenant({ tenantId: record.tenantId }, write)
      : withSystemContext(write);
  }

  /**
   * Newest-first records for one tenant, optionally narrowed by principal,
   * tool or outcome. `tenantId` is mandatory: `null` lists global rows.
   */
  async listAudits(query: McpAuditQuery & { tenantId: string | null }) {
    if (query.tenantId === undefined) {
      throw new TypeError('listAudits requires an explicit tenantId.');
    }
    const limit = Math.min(
      Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1),
      MAX_LIMIT,
    );
    const where: Record<string, unknown> = { tenantId: query.tenantId };
    if (query.principalId !== undefined) where.principalId = query.principalId;
    if (query.tool !== undefined) where.tool = query.tool;
    if (query.outcome !== undefined) where.outcome = query.outcome;
    const read = () => this.list({ where, orderBy: 'occurred_at DESC', limit });
    const rows = query.tenantId
      ? await withTenant({ tenantId: query.tenantId }, read)
      : await withSystemContext(read);
    return rows.map((row): McpAuditRecord & { id: string } => ({
      id: String(row.id),
      principalId: row.principalId ?? null,
      principalKind: row.principalKind ?? null,
      tool: row.tool,
      tenantId: row.tenantId ?? null,
      outcome: row.outcome,
      ...(row.errorCode ? { errorCode: row.errorCode } : {}),
      ...(row.identityIssuer ? { identityIssuer: row.identityIssuer } : {}),
      ...(row.identitySubject ? { identitySubject: row.identitySubject } : {}),
      ...(row.identityClientId
        ? { identityClientId: row.identityClientId }
        : {}),
      argumentKeys: Array.isArray(row.argumentKeys) ? row.argumentKeys : [],
      occurredAt: new Date(row.occurredAt),
    }));
  }
}

/** Options for {@link createSmrtMcpAuditStore}. */
export interface SmrtMcpAuditStoreOptions {
  /** SMRT options bag (`{ db }`), the same one `smrtOptions` supplies. */
  smrtOptions: () => Record<string, unknown>;
}

/**
 * The default persistent audit sink: a SMRT-model-backed, tenant-aware store.
 * Pass it as `auditSink` and read it back with `list`.
 */
export function createSmrtMcpAuditStore(
  options: SmrtMcpAuditStoreOptions,
): McpAuditSink & {
  list(
    query: McpAuditQuery & { tenantId: string | null },
  ): ReturnType<McpCallAuditCollection['listAudits']>;
} {
  // Resolved per operation: `smrtOptions()` may return request-scoped state
  // (e.g. a transaction-bound db under RLS) that must not outlive its request.
  const get = () =>
    McpCallAuditCollection.create(
      options.smrtOptions() as never,
    ) as Promise<McpCallAuditCollection>;
  return {
    async record(record) {
      await (await get()).append(record);
    },
    async list(query) {
      return (await get()).listAudits(query);
    },
  };
}
