/**
 * AgentPersona - Tenant-owned, context-scoped persona for an agent class.
 *
 * A persona layers behavioral configuration on top of a {@link TenantAgent}
 * binding (from `@happyvertical/smrt-agents`). Where `TenantAgent` answers
 * "is this agent available for the tenant, and what is its capability ceiling",
 * an `AgentPersona` answers "how should this agent behave for this tenant in
 * this context" — its instructions, allowed tools, run-as principal, acting
 * identity, and memory scope.
 *
 * There can be many personas per `(tenant, agentClass)` — one per context
 * (e.g. a site, property, or chat room) plus optional tenant-wide defaults.
 * Personas are unique on `(tenant_id, agent_class, name)`.
 *
 * Resolution (context + hierarchy + priority) lives in {@link PersonaResolver};
 * this class is the persisted record and its CRUD collection only.
 */

import {
  crossPackageRef,
  field,
  getClassName,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/**
 * Return the canonical agent type identifier for storage and lookup.
 *
 * Uses the registry's qualified name when the class is registered and falls
 * back to the raw input for dynamically defined or unregistered classes. This
 * mirrors `getAgentTypeName()` in `@happyvertical/smrt-agents` without reaching
 * into that package's internal module — personas store the same canonical form
 * that `TenantAgent` does so the two layers line up.
 */
export function canonicalAgentClass(name: string): string {
  const registered = ObjectRegistry.getClass(name);
  return registered?.qualifiedName || registered?.name || name;
}

/**
 * Return the meaningful aliases for an agent class — the canonical qualified
 * name plus the simple class name — deduplicated.
 *
 * Lookups match against both so a persona persisted under a simple name (e.g.
 * `Praeco`, when written through the generated create API without
 * normalization) is still found when resolving under the canonical qualified
 * name, and vice versa. Mirrors `getAgentTypeAliases()` in
 * `@happyvertical/smrt-agents`.
 */
export function agentClassAliases(name: string): string[] {
  const registered = ObjectRegistry.getClass(name);
  const canonical = registered?.qualifiedName || registered?.name || name;
  const simple = registered?.name || getClassName(name);
  return Array.from(new Set([canonical, simple].filter(Boolean)));
}

/**
 * Parse a JSON-array-of-strings stored as text, tolerating malformed input.
 */
function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * AgentPersona SmrtObject — a tenant/context-scoped behavioral profile for an
 * agent class.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'agent_personas',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  conflictColumns: ['tenant_id', 'agent_class', 'name'],
})
export class AgentPersona extends SmrtObject {
  /** Owning tenant (required — personas are never global). */
  @tenantId()
  tenantId: string = '';

  /**
   * Canonical qualified agent type this persona configures
   * (e.g. `@happyvertical/smrt-agents:Praeco`). Stored in canonical form so it
   * lines up with `TenantAgent.agentClass`.
   */
  @field({ type: 'text' })
  agentClass: string = '';

  /**
   * Human-readable persona name, unique per `(tenant, agentClass)`
   * (see `conflictColumns`). Inherited `name` from {@link SmrtObject} is the
   * conflict column; declared here for documentation and typing clarity.
   */
  name: string = '';

  /**
   * Optional context dimension type this persona is scoped to
   * (e.g. `'site'`, `'property'`, `'chatRoom'`). `null` means the persona is a
   * tenant-wide default that applies to every context for its agent class.
   */
  @field({ type: 'text', nullable: true })
  contextType: string | null = null;

  /**
   * Optional context dimension id. Only meaningful alongside `contextType`:
   * when set, the persona targets one specific context row; when `null` (with
   * a `contextType` set) it applies to every context of that type.
   */
  @field({ type: 'text', nullable: true })
  contextId: string | null = null;

  /** System prompt / behavioral instructions layered onto the agent. */
  @field({ type: 'text' })
  instructions: string = '';

  /**
   * Allowed tool identifiers, stored as a JSON array string. Use
   * {@link getAllowedTools} / {@link setAllowedTools} rather than reading this
   * field directly. Empty array (`'[]'`) means "no persona-specific tools"
   * (the resolver then falls back to manifest defaults, capped by the
   * `TenantAgent` ceiling).
   */
  @field({ type: 'text' })
  allowedTools: string = '[]';

  /**
   * The user whose principal this persona runs as (cross-package reference to
   * `@happyvertical/smrt-users:User`). Required — a persona always runs as a
   * concrete principal. Stored as a plain id column; no DDL FK constraint is
   * emitted (cross-package).
   */
  @crossPackageRef('@happyvertical/smrt-users:User', { required: true })
  runAsUserId: string = '';

  /**
   * Optional `Bot` profile the persona acts as for identity/audit
   * (cross-package reference to `@happyvertical/smrt-profiles:Profile`).
   * `null` when the persona has no distinct acting identity.
   */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  actsAsProfileId: string | null = null;

  /**
   * Memory scope key controlling how the agent's memory/reflection is
   * partitioned for this persona. Empty string means "use a resolver-derived
   * default".
   */
  @field({ type: 'text' })
  memoryScope: string = '';

  /**
   * Resolution priority — higher wins when several personas apply to the same
   * context at the same tenant level. Integer.
   */
  priority: number = 0;

  /** Whether this persona is active and eligible for resolution. */
  @field({ type: 'boolean' })
  enabled: boolean = true;

  /**
   * Allowed tool identifiers as an array.
   *
   * Tolerates malformed stored JSON by returning an empty array.
   */
  getAllowedTools(): string[] {
    return parseStringArray(this.allowedTools);
  }

  /**
   * Replace the allowed tool identifiers.
   */
  setAllowedTools(tools: string[]): void {
    this.allowedTools = JSON.stringify(tools ?? []);
  }
}

/**
 * Collection for managing {@link AgentPersona} records.
 */
export class AgentPersonaCollection extends SmrtCollection<AgentPersona> {
  static readonly _itemClass = AgentPersona;

  /**
   * List personas for a tenant + agent class, matching either the canonical
   * qualified name or the simple class name (see {@link agentClassAliases}).
   *
   * Ordered by descending priority then name.
   *
   * @param extraWhere - Additional equality filters merged into the query
   *   (e.g. `{ enabled: true }`).
   */
  private async listForClass(
    tenantId: string,
    agentClass: string,
    extraWhere: Record<string, unknown> = {},
  ): Promise<AgentPersona[]> {
    const aliases = agentClassAliases(agentClass);
    const where =
      aliases.length > 1
        ? { tenantId, 'agentClass in': aliases, ...extraWhere }
        : { tenantId, agentClass: aliases[0], ...extraWhere };
    const personas = await this.list({ where });
    return sortByPriorityThenName(personas);
  }

  /**
   * List every persona bound to a tenant + agent class.
   *
   * Ordered by descending priority then name so callers that don't need the
   * full resolver still get a deterministic, priority-first ordering.
   */
  async byTenantAndClass(
    tenantId: string,
    agentClass: string,
  ): Promise<AgentPersona[]> {
    return this.listForClass(tenantId, agentClass);
  }

  /**
   * List the enabled personas for a tenant + agent class, filtered to those
   * applicable to a context.
   *
   * `enabled` is filtered in the query; the context predicate (tenant-wide vs
   * type-scoped vs exact) is applied in memory since it is an OR over several
   * columns. A persona is applicable when it is a tenant-wide default (no
   * `contextType`) or its context matches the requested one. Ordered by
   * descending priority then name.
   *
   * @param context - Optional `{ contextType, contextId }` to filter by.
   */
  async findActive(
    tenantId: string,
    agentClass: string,
    context: { contextType?: string | null; contextId?: string | null } = {},
  ): Promise<AgentPersona[]> {
    const personas = await this.listForClass(tenantId, agentClass, {
      enabled: true,
    });
    return personas.filter((persona) =>
      personaAppliesToContext(persona, context),
    );
  }
}

/**
 * Whether a persona applies to a requested context.
 *
 * - No `contextType` on the persona → tenant-wide default, applies to all.
 * - `contextType` set, `contextId` null → type-scoped, applies when the
 *   requested `contextType` matches.
 * - Both set → exact, applies when both match.
 */
export function personaAppliesToContext(
  persona: Pick<AgentPersona, 'contextType' | 'contextId'>,
  context: { contextType?: string | null; contextId?: string | null },
): boolean {
  if (!persona.contextType) {
    return true;
  }
  if (persona.contextType !== (context.contextType ?? null)) {
    return false;
  }
  if (persona.contextId == null) {
    return true;
  }
  return persona.contextId === (context.contextId ?? null);
}

/**
 * Context-specificity rank used for resolution ordering.
 *
 * - `2` exact `(contextType, contextId)` match
 * - `1` type-scoped match (`contextType` matches, persona `contextId` null)
 * - `0` tenant-wide default (persona has no `contextType`)
 */
export function personaContextRank(
  persona: Pick<AgentPersona, 'contextType' | 'contextId'>,
): number {
  if (!persona.contextType) {
    return 0;
  }
  return persona.contextId == null ? 1 : 2;
}

function sortByPriorityThenName(personas: AgentPersona[]): AgentPersona[] {
  return [...personas].sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    return (a.name ?? '').localeCompare(b.name ?? '');
  });
}

export default AgentPersona;
