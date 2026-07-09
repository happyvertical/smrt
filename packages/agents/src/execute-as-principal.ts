/**
 * ExecuteAsPrincipal — run an agent's work AS its persona's bound user.
 *
 * This is deliberately NOT a new authorization layer. It reuses the framework's
 * existing principal-context machinery:
 *
 * - {@link withPrincipalPermissionContext} resolves the bound user's *live*
 *   permission set (the standard {@link PermissionResolver} cascade) and
 *   publishes `(smrt.user_id, smrt.tenant_id, smrt.permissions[])` onto the DB
 *   session. With Postgres RLS enabled, the manifest-derived policies then bound
 *   every query the agent makes per-`(table, action)` and per-tenant — through
 *   any door (in-process "side door", REST, MCP), with no per-call re-checking.
 *
 * - Because RLS is Postgres-only and opt-in, the exec/tool seam must ALSO assert
 *   the catalog permission for the `(collection, action)` when RLS is off
 *   (SQLite/dev). {@link PrincipalRun.assertOperation} wraps
 *   `assertOperationPermission` for exactly that, so the authority bound holds
 *   on every adapter.
 *
 * The effective authority of an agent action is therefore:
 *
 *   bound-user RBAC  ∩  agent-class capability ceiling  ∩  persona allowedTools
 *
 * where the RBAC half is enforced at the data layer (RLS) or the catalog seam
 * (`assertOperation`), and the tool half is enforced by
 * {@link PrincipalRun.assertToolAllowed} against `allowedTools` — which a
 * resolved persona has already intersected with the `TenantAgent` ceiling.
 *
 * Actions audit as on-behalf-of the originating user (see {@link PrincipalAuditEntry}).
 *
 * @packageDocumentation
 */

import { createLogger, type Logger } from '@happyvertical/logger';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  assertOperationPermission,
  type OperationPermissionCollectionInput,
  type OperationPermissionDecision,
  type PermissionResolver,
  type SessionPermissionRuntimeContext,
  withPrincipalPermissionContext,
} from '@happyvertical/smrt-users';

/**
 * The bound principal an agent runs as. A resolved persona structurally
 * satisfies this once its optional `runAsUserId` has been narrowed to a
 * concrete id — `allowedTools` on a `ResolvedPersona` is already the persona's
 * tools intersected with the `TenantAgent` capability ceiling.
 */
export interface PrincipalBinding {
  /** The user whose live permissions bound this execution. Required. */
  runAsUserId: string;
  /** Tenant the principal acts within. */
  tenantId: string | null;
  /**
   * The persona's tool allow-list (already capped by the agent-class ceiling).
   * This is a **fail-closed** whitelist, mirroring
   * `@happyvertical/smrt-chat`'s `AgentSession.isToolAllowed()` (S5 #1392): an
   * absent (`undefined`) or empty allow-list permits **NO** tools, never all of
   * them, so forgetting to pass it can only tighten authority. Resolved personas
   * always provide a concrete `string[]`.
   */
  allowedTools?: string[];
  /** Optional acting `Bot` profile id, recorded in the audit entry. */
  actsAsProfileId?: string | null;
}

/**
 * A single audit record describing an agent action performed by the bound
 * principal (`actorUserId`) on behalf of the originating user
 * (`onBehalfOfUserId`).
 */
export interface PrincipalAuditEntry {
  /** Action label, e.g. `'agent.run'`. */
  action: string;
  /** The persona's bound user the work ran as. */
  actorUserId: string;
  /** The user who triggered the agent, if known. */
  onBehalfOfUserId: string | null;
  /** Tenant the action ran within. */
  tenantId: string | null;
  /** Canonical agent class, when the caller supplies it. */
  agentClass?: string;
  /** Acting profile id, when the persona sets one. */
  actsAsProfileId?: string | null;
  /** Free-form additional context. */
  metadata?: Record<string, unknown>;
}

/**
 * Sink that records a {@link PrincipalAuditEntry}. Provide one to persist audit
 * rows (e.g. via `AuditLog.record`); when omitted, the entry is emitted as a
 * structured log line.
 */
export type PrincipalAuditSink = (
  entry: PrincipalAuditEntry,
) => void | Promise<void>;

/**
 * Options for {@link executeAsPrincipal}.
 */
export interface ExecuteAsPrincipalOptions extends SmrtClassOptions {
  /** The bound principal to run as. */
  principal: PrincipalBinding;
  /** The originating user the action is performed on behalf of (for audit). */
  onBehalfOfUserId?: string | null;
  /** Canonical agent class, recorded in the audit entry. */
  agentClass?: string;
  /** Audit action label. Defaults to `'agent.run'`. */
  action?: string;
  /** Extra audit metadata merged into the emitted entry. */
  auditMetadata?: Record<string, unknown>;
  /**
   * Pre-resolved permission slugs. When omitted, the principal's permissions
   * are resolved live so role changes reflect on the next execution.
   */
  permissions?: string[];
  /** Reuse an initialized resolver across executions. */
  resolver?: PermissionResolver;
  /** Opt into Postgres RLS transaction wrapping (defaults to package config). */
  postgresRls?: boolean;
  /**
   * Enter tenant context so tenant auto-filtering applies on every adapter.
   * Defaults to `true` whenever the principal has a tenant.
   */
  enterTenantContext?: boolean;
  /** Audit sink. Defaults to a structured log line. */
  audit?: PrincipalAuditSink;
  /** Logger used for the default audit sink. */
  logger?: Logger;
}

/**
 * Thrown when the persona attempts a tool outside its `allowedTools`.
 */
export class PrincipalToolNotAllowedError extends Error {
  readonly tool: string;
  readonly status = 403;

  constructor(tool: string) {
    super(`Tool '${tool}' is not permitted for this persona.`);
    this.name = 'PrincipalToolNotAllowedError';
    this.tool = tool;
  }
}

/**
 * The handle passed to the {@link executeAsPrincipal} body. Its
 * session-permission {@link context} is already published for the principal, so
 * data operations are bounded by RLS on Postgres. The assertions enforce the
 * remaining two authority dimensions.
 */
export interface PrincipalRun {
  /** The published session-permission runtime context for the principal. */
  context: SessionPermissionRuntimeContext;
  /** The principal's published (snapshot) permission slugs. */
  permissions: string[];
  /**
   * The effective, fail-closed tool allow-list — always a concrete array (an
   * absent binding allow-list normalizes to `[]`, i.e. no tools).
   */
  allowedTools: string[];
  /**
   * Whether `tool` is within the fail-closed allow-list. An empty allow-list,
   * or an empty/non-string tool name, permits nothing.
   */
  isToolAllowed(tool: string): boolean;
  /** Throw {@link PrincipalToolNotAllowedError} unless `tool` is allowed. */
  assertToolAllowed(tool: string): void;
  /**
   * Assert the principal holds the catalog permission for `(collection,
   * action)`, authorizing against the **published** principal set
   * (`context.permissionSet`) — the same snapshot the RLS session enforces — so
   * the bound is adapter-independent. This is the door-agnostic teeth for the
   * RLS-off adapters; under Postgres RLS it is a redundant (but harmless)
   * second gate. Throws `OperationPermissionError` on denial.
   */
  assertOperation(
    collection: OperationPermissionCollectionInput,
    action: string,
    extraOptions?: SmrtClassOptions,
  ): Promise<OperationPermissionDecision>;
}

async function emitAudit(
  entry: PrincipalAuditEntry,
  audit: PrincipalAuditSink | undefined,
  logger: Logger | undefined,
): Promise<void> {
  if (audit) {
    await audit(entry);
    return;
  }
  const log = logger ?? createLogger({ level: 'info' });
  log.info('agent action executed on behalf of originating user', {
    ...entry,
  });
}

/**
 * Run `fn` AS the persona's bound principal.
 *
 * Resolves the bound user's live permissions, publishes them onto the DB
 * session (so Postgres RLS bounds every query per-`(table, action)`), emits an
 * on-behalf-of audit entry, and hands `fn` a {@link PrincipalRun} whose
 * assertions enforce the persona tool ceiling and the RLS-off catalog gate.
 *
 * @example
 * ```typescript
 * await executeAsPrincipal(
 *   {
 *     db,
 *     principal: {
 *       runAsUserId: persona.runAsUserId,
 *       tenantId: persona.tenantId,
 *       allowedTools: persona.allowedTools,
 *     },
 *     onBehalfOfUserId: triggeringUserId,
 *     agentClass: persona.agentClass,
 *   },
 *   async (run) => {
 *     run.assertToolAllowed('articles.publish');
 *     await run.assertOperation('articles', 'update');
 *     await agent.run();
 *   },
 * );
 * ```
 */
export async function executeAsPrincipal<T>(
  options: ExecuteAsPrincipalOptions,
  fn: (run: PrincipalRun) => Promise<T>,
): Promise<T> {
  const {
    principal,
    onBehalfOfUserId = null,
    agentClass,
    action = 'agent.run',
    auditMetadata,
    permissions,
    resolver,
    postgresRls,
    enterTenantContext,
    audit,
    logger,
    ...smrtOptions
  } = options;

  const { runAsUserId, tenantId, actsAsProfileId = null } = principal;

  // Fail-closed tool allow-list (mirrors chat's AgentSession, S5 #1392): an
  // absent or non-array binding allow-list normalizes to `[]` — no tools — so a
  // missing ceiling can only tighten authority, never open it up.
  const toolWhitelist = Array.isArray(principal.allowedTools)
    ? principal.allowedTools
    : [];
  const isToolAllowed = (tool: string): boolean =>
    typeof tool === 'string' && tool.length > 0 && toolWhitelist.includes(tool);

  await emitAudit(
    {
      action,
      actorUserId: runAsUserId,
      onBehalfOfUserId,
      tenantId,
      agentClass,
      actsAsProfileId,
      metadata: auditMetadata,
    },
    audit,
    logger,
  );

  return withPrincipalPermissionContext(
    {
      ...smrtOptions,
      userId: runAsUserId,
      tenantId,
      permissions,
      resolver,
      postgresRls,
      enterTenantContext: enterTenantContext ?? tenantId !== null,
    },
    async (context) => {
      const run: PrincipalRun = {
        context,
        permissions: context.permissions,
        allowedTools: toolWhitelist,
        isToolAllowed,
        assertToolAllowed(tool: string): void {
          if (!isToolAllowed(tool)) {
            throw new PrincipalToolNotAllowedError(tool);
          }
        },
        async assertOperation(
          collection: OperationPermissionCollectionInput,
          operationAction: string,
          extraOptions?: SmrtClassOptions,
        ): Promise<OperationPermissionDecision> {
          return assertOperationPermission({
            ...smrtOptions,
            ...extraOptions,
            collection,
            action: operationAction,
            // Authorize against the PUBLISHED principal set (the same snapshot
            // Postgres RLS enforces for this context), not a fresh live
            // re-resolve — keeps the RLS-off gate adapter-independent.
            permissionSet: context.permissionSet,
          });
        },
      };
      return fn(run);
    },
  );
}
