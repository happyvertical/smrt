import type { DatabaseInterface } from '@happyvertical/sql';
import {
  deduplicateNaturalKeys,
  type NaturalKeyDedupOptions,
  type NaturalKeyDedupResult,
  type NaturalKeyDedupTarget,
} from './natural-key-dedup.js';

/** Options for the explicit, maintenance-window authority-pair migration. */
export type DeduplicateAuthorityPairsOptions = NaturalKeyDedupOptions;

/** Per-table result of {@link deduplicateAuthorityPairs}. */
export interface DeduplicateAuthorityPairsResult {
  membershipOverrides: NaturalKeyDedupResult;
  tenantPermissionOverrides: NaturalKeyDedupResult;
  groupMembers: NaturalKeyDedupResult;
}

/**
 * `effect` is a text column; a legacy JSON-typed column renders the value
 * quoted, so both spellings are matched.
 */
const effectIs = (value: string) =>
  `CAST(effect AS TEXT) IN ('${value}', '"${value}"')`;

const TARGETS: readonly NaturalKeyDedupTarget[] = [
  {
    table: 'membership_overrides',
    columns: ['membership_id', 'permission_id'],
    index: 'membership_overrides_membership_id_permission_id_idx',
    // The resolver applies DENY over GRANT, so the pair's effective state is
    // DENY whenever any DENY row exists: keep that one.
    survivorOrder: `CASE WHEN ${effectIs('deny')} THEN 0 ELSE 1 END`,
  },
  {
    table: 'tenant_permission_overrides',
    columns: ['tenant_id', 'permission_id'],
    index: 'tenant_permission_overrides_tenant_id_permission_id_idx',
    // Tenant DENY is a hard block, GRANT beats INHERIT: keep the effective one.
    survivorOrder: `CASE WHEN ${effectIs('deny')} THEN 0 WHEN ${effectIs('grant')} THEN 1 ELSE 2 END`,
  },
  {
    table: 'group_members',
    columns: ['group_id', 'user_id'],
    index: 'group_members_group_id_user_id_idx',
  },
];

/**
 * Collapse duplicate `MembershipOverride`, `TenantPermissionOverride` and
 * `GroupMember` rows to one per natural-key pair and install the unique
 * indexes their models now declare (#3375). Run BEFORE ordinary schema
 * migration, with every writer stopped: adding the indexes directly fails
 * while duplicates exist, and older application versions do not write
 * against them safely.
 *
 * Override pairs keep the row whose effect the resolver already applies
 * (DENY, then GRANT, then INHERIT), so the effective authority of every pair
 * is unchanged; ties, and group memberships, keep the earliest `created_at`
 * (lowest `id` breaks ties; null timestamps sort last). Survivors are
 * unchanged. All three tables commit together; failure leaves them intact.
 * Re-running is safe.
 */
export async function deduplicateAuthorityPairs(
  db: DatabaseInterface,
  options: DeduplicateAuthorityPairsOptions = {},
): Promise<DeduplicateAuthorityPairsResult> {
  const [membershipOverrides, tenantPermissionOverrides, groupMembers] =
    await deduplicateNaturalKeys(
      db,
      TARGETS,
      options,
      'Authority pair deduplication',
    );
  return { membershipOverrides, tenantPermissionOverrides, groupMembers };
}
