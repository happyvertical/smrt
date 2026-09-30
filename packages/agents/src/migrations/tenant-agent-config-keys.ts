/**
 * Data repair for tenant agent config keys left behind by smrt #1092.
 *
 * #1092 canonicalized agent identity to the registry's qualified type
 * (`@scope/package:Class`). A tenant-bound agent with no Agent row owns its
 * slot configs under `tenantAgentConfigOwnerId(tenant, type)`, so the id the
 * admin UI reads became `<tenant>:@scope/package:Class` — but rows written
 * before (or by writers that kept composing the old id) sit under
 * `<tenant>:Class`, and the settings panels show nothing. Separately,
 * `tenant_agents.agent_class` may still hold a bare class or a renamed
 * package's qualified name. `TenantAgentCollection` self-heals a bare class
 * on read, but never the config rows and never a name the registry cannot map.
 *
 * This repair moves both to the canonical type:
 *
 * - `tenant_agents.agent_class` → canonical type (never onto an existing
 *   binding of the same tenant: two spellings of one binding are blocked);
 * - `agent_configs` rows whose owner id is `<row tenant_id>:<type>` → owner
 *   `<tenant>:<canonical>`, `agent_class` canonical, and the slug
 *   `AgentConfig.saveSlot()` gives a new row (`<owner>-<slot>`). Two rows
 *   landing on one `(tenant, owner, slot)` or one slug are blocked. Other
 *   owner ids (persona ids, Agent row ids) are left alone.
 *
 * Canonical type = `aliases[stored]` when given (for renamed packages the
 * registry cannot know), else `getAgentTypeName(stored)`, which needs the
 * agent classes registered in the running process (import the host's
 * agents first).
 *
 * `repairTenantAgentConfigKeys(db)` is a dry run and never writes. With
 * `apply: true` it re-plans inside one transaction (table locks on
 * PostgreSQL), refuses when anything is blocked, re-checks before commit,
 * and returns a ledger of every before/after value. Re-running after apply
 * finds nothing to do.
 */

import { detectEngine } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  getAgentTypeName,
  parseTenantAgentConfigOwnerId,
} from '../identity.js';

export const TENANT_AGENTS_TABLE = 'tenant_agents';
export const AGENT_CONFIGS_TABLE = 'agent_configs';

export class TenantAgentConfigKeyRepairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantAgentConfigKeyRepairError';
  }
}

export interface TenantAgentConfigKeyRepairOptions {
  /**
   * Stored spelling → canonical type, consulted before the registry. Use it
   * for types the registry cannot map, e.g. a package that was renamed
   * (`'@happyvertical/praeco:Praeco': '@anytown/praeco:Praeco'`).
   */
  aliases?: Readonly<Record<string, string>>;
  /** Full override of the canonicalization (aliases are then ignored). */
  resolveAgentType?: (stored: string) => string;
}

export interface TenantAgentKeyRow {
  id: string;
  tenantId: string;
  agentClass: string;
  targetAgentClass: string;
  reason?: string;
}

export interface AgentConfigKeyRow {
  id: string;
  tenantId: string | null;
  slotId: string;
  agentId: string;
  agentClass: string;
  slug: string;
  targetAgentId: string;
  targetAgentClass: string;
  targetSlug: string;
  /** No tenant binding owns the target owner id (after the binding repair). */
  unbound: boolean;
  reason?: string;
}

export interface TenantAgentConfigKeyPlan {
  tenantAgents: {
    clean: TenantAgentKeyRow[];
    planned: TenantAgentKeyRow[];
    blocked: TenantAgentKeyRow[];
  };
  configs: {
    clean: AgentConfigKeyRow[];
    planned: AgentConfigKeyRow[];
    blocked: AgentConfigKeyRow[];
    /** Owner ids that are not `<row tenant>:<type>` (persona/Agent row ids). */
    skipped: AgentConfigKeyRow[];
  };
}

export interface TenantAgentConfigKeyLedgerEntry {
  table: typeof TENANT_AGENTS_TABLE | typeof AGENT_CONFIGS_TABLE;
  id: string;
  before: Record<string, string>;
  after: Record<string, string>;
}

export interface TenantAgentConfigKeyRepairTotals {
  tenantAgents: {
    total: number;
    clean: number;
    planned: number;
    blocked: number;
  };
  configs: {
    total: number;
    clean: number;
    planned: number;
    blocked: number;
    skipped: number;
    unbound: number;
  };
  /** Rows written (0 on a dry run). */
  changed: number;
}

export interface TenantAgentConfigKeyRepairReport {
  mode: 'dry-run' | 'apply';
  /** The plan before any write (dry run) or the re-check after apply. */
  plan: TenantAgentConfigKeyPlan;
  totals: TenantAgentConfigKeyRepairTotals;
  ledger: TenantAgentConfigKeyLedgerEntry[];
}

export interface RawTenantAgentRow {
  id: unknown;
  tenant_id: unknown;
  agent_class: unknown;
}

export interface RawAgentConfigRow {
  id: unknown;
  tenant_id: unknown;
  agent_id: unknown;
  agent_class: unknown;
  slot_id: unknown;
  slug: unknown;
}

type Queryable = Pick<DatabaseInterface, 'query'>;

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function optionalText(value: unknown): string | null {
  const value_ = text(value);
  return value_.length > 0 ? value_ : null;
}

function canonicalizer(
  options: TenantAgentConfigKeyRepairOptions,
): (stored: string) => string {
  if (options.resolveAgentType) return options.resolveAgentType;
  const aliases = options.aliases ?? {};
  return (stored) =>
    Object.hasOwn(aliases, stored) ? aliases[stored] : getAgentTypeName(stored);
}

function group<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    groups.set(k, [...(groups.get(k) ?? []), row]);
  }
  return groups;
}

/** Pure planner over both tables' rows (no SQL), for tests and previews. */
export function planTenantAgentConfigKeyRepairRows(
  tenantAgentRows: readonly RawTenantAgentRow[],
  configRows: readonly RawAgentConfigRow[],
  options: TenantAgentConfigKeyRepairOptions = {},
): TenantAgentConfigKeyPlan {
  const canonical = canonicalizer(options);
  const plan: TenantAgentConfigKeyPlan = {
    tenantAgents: { clean: [], planned: [], blocked: [] },
    configs: { clean: [], planned: [], blocked: [], skipped: [] },
  };

  const bindings: TenantAgentKeyRow[] = tenantAgentRows.map((row) => {
    const agentClass = text(row.agent_class);
    return {
      id: text(row.id),
      tenantId: text(row.tenant_id),
      agentClass,
      targetAgentClass: canonical(agentClass),
    };
  });
  const bindingPeers = group(
    bindings,
    (row) => `${row.tenantId}\u0000${row.targetAgentClass}`,
  );
  for (const row of bindings) {
    const peers =
      bindingPeers.get(`${row.tenantId}\u0000${row.targetAgentClass}`) ?? [];
    if (peers.length > 1) {
      row.reason = `${peers.length} bindings for this tenant resolve to ${row.targetAgentClass}`;
      plan.tenantAgents.blocked.push(row);
    } else if (row.agentClass === row.targetAgentClass) {
      plan.tenantAgents.clean.push(row);
    } else {
      plan.tenantAgents.planned.push(row);
    }
  }
  const boundOwnerIds = new Set(
    bindings.map((row) => `${row.tenantId}:${row.targetAgentClass}`),
  );

  const configs: AgentConfigKeyRow[] = configRows.map((row) => {
    const tenantId = optionalText(row.tenant_id);
    const agentId = text(row.agent_id);
    const agentClass = text(row.agent_class);
    const slotId = text(row.slot_id);
    const slug = text(row.slug);
    const ownerType = tenantId
      ? parseTenantAgentConfigOwnerId(agentId, tenantId)
      : null;
    const base = {
      id: text(row.id),
      tenantId,
      slotId,
      agentId,
      agentClass,
      slug,
    };
    if (!tenantId || !ownerType) {
      return {
        ...base,
        targetAgentId: agentId,
        targetAgentClass: agentClass,
        targetSlug: slug,
        unbound: false,
        reason: tenantId
          ? 'owner id is not <tenant>:<agent type>'
          : 'no tenant_id',
      };
    }
    const targetType = canonical(ownerType);
    // Same shape as tenantAgentConfigOwnerId(), with the repair's own
    // canonicalization (aliases / resolveAgentType) already applied.
    const targetAgentId =
      targetType === ownerType ? agentId : `${tenantId}:${targetType}`;
    const moved = targetAgentId !== agentId;
    return {
      ...base,
      targetAgentId,
      targetAgentClass: targetType,
      targetSlug: moved ? `${targetAgentId}-${slotId}` : slug,
      unbound: !boundOwnerIds.has(targetAgentId),
    };
  });

  const slotPeers = group(
    configs.filter((row) => !row.reason),
    (row) => `${row.tenantId}\u0000${row.targetAgentId}\u0000${row.slotId}`,
  );
  const slugPeers = group(
    configs,
    (row) => `${row.tenantId}\u0000${row.targetSlug}`,
  );
  for (const row of configs) {
    if (row.reason) {
      plan.configs.skipped.push(row);
      continue;
    }
    const sameSlot =
      slotPeers.get(
        `${row.tenantId}\u0000${row.targetAgentId}\u0000${row.slotId}`,
      ) ?? [];
    const sameSlug =
      slugPeers.get(`${row.tenantId}\u0000${row.targetSlug}`) ?? [];
    if (sameSlot.length > 1) {
      // Two spellings of one slot (a seeded row and a later save): report
      // both rather than pick a winner.
      row.reason = `${sameSlot.length} rows hold slot "${row.slotId}" for ${row.targetAgentId}`;
      plan.configs.blocked.push(row);
    } else if (sameSlug.length > 1) {
      row.reason = `slug ${row.targetSlug} is already taken`;
      plan.configs.blocked.push(row);
    } else if (
      row.agentId === row.targetAgentId &&
      row.agentClass === row.targetAgentClass &&
      row.slug === row.targetSlug
    ) {
      plan.configs.clean.push(row);
    } else {
      plan.configs.planned.push(row);
    }
  }

  return plan;
}

async function readRows(db: Queryable) {
  const tenantAgents = await db.query(
    `SELECT id, tenant_id, agent_class FROM ${TENANT_AGENTS_TABLE} ORDER BY tenant_id, agent_class, id`,
  );
  const configs = await db.query(
    `SELECT id, tenant_id, agent_id, agent_class, slot_id, slug FROM ${AGENT_CONFIGS_TABLE} ORDER BY tenant_id, agent_id, slot_id, id`,
  );
  return {
    tenantAgents: tenantAgents.rows as RawTenantAgentRow[],
    configs: configs.rows as RawAgentConfigRow[],
  };
}

/** Read both tables and plan the repair (never writes). */
export async function planTenantAgentConfigKeyRepair(
  db: Queryable,
  options: TenantAgentConfigKeyRepairOptions = {},
): Promise<TenantAgentConfigKeyPlan> {
  const rows = await readRows(db);
  return planTenantAgentConfigKeyRepairRows(
    rows.tenantAgents,
    rows.configs,
    options,
  );
}

function describeBlocked(plan: TenantAgentConfigKeyPlan): string[] {
  return [
    ...plan.tenantAgents.blocked.map(
      (row) =>
        `${TENANT_AGENTS_TABLE} ${row.id} (${row.tenantId} ${row.agentClass}): ${row.reason}`,
    ),
    ...plan.configs.blocked.map(
      (row) =>
        `${AGENT_CONFIGS_TABLE} ${row.id} (${row.agentId}/${row.slotId}): ${row.reason}`,
    ),
  ];
}

function totalsFor(
  plan: TenantAgentConfigKeyPlan,
  changed: number,
): TenantAgentConfigKeyRepairTotals {
  const { tenantAgents: ta, configs: c } = plan;
  const considered = [...c.clean, ...c.planned, ...c.blocked];
  return {
    tenantAgents: {
      total: ta.clean.length + ta.planned.length + ta.blocked.length,
      clean: ta.clean.length,
      planned: ta.planned.length,
      blocked: ta.blocked.length,
    },
    configs: {
      total: considered.length + c.skipped.length,
      clean: c.clean.length,
      planned: c.planned.length,
      blocked: c.blocked.length,
      skipped: c.skipped.length,
      unbound: considered.filter((row) => row.unbound).length,
    },
    changed,
  };
}

/**
 * Plan (default) or apply the tenant agent config key repair. See the module
 * docs; `apply: true` requires a transaction-capable adapter.
 */
export async function repairTenantAgentConfigKeys(
  db: DatabaseInterface,
  options: TenantAgentConfigKeyRepairOptions & { apply?: boolean } = {},
): Promise<TenantAgentConfigKeyRepairReport> {
  if (!options.apply) {
    const plan = await planTenantAgentConfigKeyRepair(db, options);
    return { mode: 'dry-run', plan, totals: totalsFor(plan, 0), ledger: [] };
  }
  if (!db.transaction) {
    throw new TenantAgentConfigKeyRepairError(
      'Applying the tenant agent config key repair requires a transaction-capable database adapter',
    );
  }
  const postgres = detectEngine(db.url ?? '') === 'postgres';

  return db.transaction(async (tx) => {
    if (postgres) {
      await tx.query(
        `LOCK TABLE ${TENANT_AGENTS_TABLE}, ${AGENT_CONFIGS_TABLE} IN SHARE ROW EXCLUSIVE MODE`,
      );
    }
    const plan = await planTenantAgentConfigKeyRepair(tx, options);
    const blocked = describeBlocked(plan);
    if (blocked.length > 0) {
      throw new TenantAgentConfigKeyRepairError(
        `Tenant agent config key repair refused: ${blocked.length} row(s) blocked. Nothing was changed.\n${blocked.join('\n')}`,
      );
    }

    const now = new Date().toISOString();
    const ledger: TenantAgentConfigKeyLedgerEntry[] = [];
    for (const row of plan.tenantAgents.planned) {
      await tx.query(
        `UPDATE ${TENANT_AGENTS_TABLE} SET agent_class = ?, updated_at = ? WHERE id = ? AND agent_class = ?`,
        row.targetAgentClass,
        now,
        row.id,
        row.agentClass,
      );
      ledger.push({
        table: TENANT_AGENTS_TABLE,
        id: row.id,
        before: { agent_class: row.agentClass },
        after: { agent_class: row.targetAgentClass },
      });
    }
    for (const row of plan.configs.planned) {
      await tx.query(
        `UPDATE ${AGENT_CONFIGS_TABLE} SET agent_id = ?, agent_class = ?, slug = ?, updated_at = ? WHERE id = ? AND agent_id = ?`,
        row.targetAgentId,
        row.targetAgentClass,
        row.targetSlug,
        now,
        row.id,
        row.agentId,
      );
      ledger.push({
        table: AGENT_CONFIGS_TABLE,
        id: row.id,
        before: {
          agent_id: row.agentId,
          agent_class: row.agentClass,
          slug: row.slug,
        },
        after: {
          agent_id: row.targetAgentId,
          agent_class: row.targetAgentClass,
          slug: row.targetSlug,
        },
      });
    }

    const after = await planTenantAgentConfigKeyRepair(tx, options);
    const remaining =
      after.tenantAgents.planned.length + after.configs.planned.length;
    if (remaining > 0 || describeBlocked(after).length > 0) {
      throw new TenantAgentConfigKeyRepairError(
        `Tenant agent config key repair post-check failed (${remaining} row(s) still to repair); rolled back.`,
      );
    }
    return {
      mode: 'apply' as const,
      plan: after,
      totals: totalsFor(after, ledger.length),
      ledger,
    };
  });
}
