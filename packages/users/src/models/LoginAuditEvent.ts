/**
 * Durable record of a credential sign-in outcome (#3273).
 *
 * This is the default {@link LoginAuditSink} target: one row per decision
 * the {@link LoginAttemptLimiter} makes, written through the collection so it
 * is visible to the change feed and the retention sweep like any other smrt
 * object. Hosts with their own audit log supply a sink instead.
 *
 * @packageDocumentation
 */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

/** What happened to a sign-in attempt. */
export type LoginAuditOutcome =
  /** Refused before credential work: budget exhausted or key locked out. */
  | 'denied'
  /** Credential work ran and the credential was wrong. */
  | 'failed'
  /** Credential work ran and succeeded. */
  | 'succeeded'
  /** A failure exhausted the budget and the key is now locked out. */
  | 'locked'
  /** A credential was set, reset, or cleared (administrative). */
  | 'managed';

@smrt({
  tableName: 'users_login_audit_events',
  // Hashed keys only, but the sequence of rows still describes attack
  // traffic against identifiable subjects. Not for the change feed (#2937).
  sensitive: true,
  api: false,
  cli: false,
  mcp: false,
})
export class UsersLoginAuditEvent extends SmrtObject {
  /** Credential kind: `terminal-approve`, `pin`, `password`, `passkey`, … */
  @field({ type: 'text', required: true })
  kind = '';

  @field({ type: 'text', required: true })
  outcome: LoginAuditOutcome = 'failed';

  /** Hashed subject key, or null when the attempt had no subject. */
  @field({ type: 'text', nullable: true, indexed: true })
  subjectKeyHash: string | null = null;

  /** Hashed source key (IP or device), or null when the attempt had no source. */
  @field({ type: 'text', nullable: true, indexed: true })
  sourceKeyHash: string | null = null;

  /** Set on `denied`/`locked`: how long the client was told to wait. */
  @field({ type: 'integer', nullable: true })
  retryAfterSeconds: number | null = null;

  /**
   * When the decision was made.
   *
   * Indexed: the retention sweep prunes by this column.
   */
  @field({ type: 'datetime', required: true, indexed: true })
  occurredAt = new Date();

  /**
   * Free-form JSON the caller attached. Never credentials or session ids;
   * subjects stay hashed. The one identifier that belongs here is the acting
   * administrator on a `managed` event, since accountability is its purpose.
   */
  @field({ type: 'text' })
  metadata = '{}';

  getMetadata(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(this.metadata || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  setMetadata(value: Record<string, unknown>): void {
    this.metadata = JSON.stringify(value ?? {});
  }
}
