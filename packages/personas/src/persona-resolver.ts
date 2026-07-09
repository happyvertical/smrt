/**
 * PersonaResolver - resolves the active {@link AgentPersona} for a
 * `(tenant, agentClass, context)` request.
 *
 * Layering, bottom to top (each layer overrides the previous):
 *
 *   1. **Manifest defaults** — the agent's built-in instructions / tools /
 *      memory scope (supplied by the caller as {@link ManifestPersonaDefaults}).
 *   2. **TenantAgent** — the tenant/class availability gate and capability
 *      ceiling (supplied as a {@link PersonaAvailabilityGate}; build one from a
 *      `ResolvedAgentAvailability` via {@link availabilityFromResolvedAgent}).
 *      `TenantAgent` decides *whether* the agent runs and *caps* its tools;
 *      it never sets instructions.
 *   3. **AgentPersona** — the tenant's own persona for the context: overrides
 *      instructions, sets tools (within the ceiling), run-as principal, acting
 *      identity, and memory scope.
 *
 * Tenant-hierarchy inheritance mirrors `TenantAgentCollection.resolveForTenant`:
 * the resolver walks from the requesting tenant up its ancestors (nearest
 * first). The nearest tenant level that has any applicable persona wins the
 * resolution (a closer level shadows a farther one); within that level the most
 * context-specific, highest-priority persona is selected. When no level has an
 * applicable persona a defined default is returned.
 *
 * The hierarchy walk reads personas across tenants, so `resolve()` is meant to
 * run in a system/admin path where cross-tenant reads are permitted (i.e. not
 * inside a strict per-tenant interceptor context) — the same expectation
 * `TenantAgentCollection.resolveForTenant` carries.
 */

import type { ResolvedAgentAvailability } from '@happyvertical/smrt-agents';
import {
  type AgentPersona,
  type AgentPersonaCollection,
  canonicalAgentClass,
  personaAppliesToContext,
  personaContextRank,
} from './agent-persona.js';

/**
 * The context a persona is being resolved for.
 */
export interface PersonaContext {
  /** Context dimension type (e.g. `'site'`). */
  contextType?: string | null;
  /** Context dimension id within `contextType`. */
  contextId?: string | null;
}

/**
 * Bottom-layer defaults for an agent class, typically derived from its build
 * manifest.
 */
export interface ManifestPersonaDefaults {
  /** Default system instructions when no persona overrides them. */
  instructions?: string;
  /** Default tool identifiers, capped by the availability ceiling. */
  allowedTools?: string[];
  /** Default memory scope. */
  memoryScope?: string;
}

/**
 * Middle-layer availability + capability ceiling, projected from a
 * `TenantAgent` resolution.
 */
export interface PersonaAvailabilityGate {
  /** Resolved `TenantAgent` status. `'disabled'` marks the persona unavailable. */
  status: 'active' | 'disabled';
  /**
   * Tool identifiers the tenant is permitted to grant. When set, resolved
   * `allowedTools` are intersected with this ceiling. `undefined` means no
   * ceiling (tools pass through unchanged).
   */
  toolCeiling?: string[];
  /** Tenant the binding was resolved from (provenance only). */
  sourceTenantId?: string;
}

/**
 * Options for {@link PersonaResolver.resolve}.
 */
export interface ResolvePersonaOptions {
  /**
   * Return ancestor tenant ids for a tenant, nearest parent first through to
   * the root — mirrors `TenantAgentCollection.resolveForTenant`. Omit for a
   * single-tenant resolution with no inheritance.
   */
  getAncestorIds?: (tenantId: string) => Promise<string[]>;
  /** Bottom-layer manifest defaults for the agent class. */
  manifestDefaults?: ManifestPersonaDefaults;
  /**
   * Middle-layer `TenantAgent` availability + ceiling. Omit to skip gating
   * (the result is always `available: true` with no tool ceiling).
   */
  availability?: PersonaAvailabilityGate | null;
}

/**
 * A fully resolved persona: the layered, ready-to-use configuration plus
 * provenance describing how it was resolved.
 */
export interface ResolvedPersona {
  /** Canonical qualified agent type the resolution was for. */
  agentClass: string;
  /** Tenant the resolution was requested for. */
  tenantId: string;
  /** Id of the selected persona, or `undefined` for the default fallback. */
  personaId?: string;
  /** Selected persona name, or `'default'` for the fallback. */
  name: string;
  /** Layered instructions (persona → manifest default). */
  instructions: string;
  /** Layered tool ids (persona/manifest tools, capped by the ceiling). */
  allowedTools: string[];
  /** Run-as user principal, if the selected persona sets one. */
  runAsUserId?: string;
  /** Acting `Bot` profile id, if the selected persona sets one. */
  actsAsProfileId?: string | null;
  /** Resolved memory scope (persona → manifest default → derived default). */
  memoryScope: string;
  /** Selected persona priority (`0` for the default fallback). */
  priority: number;
  /** Context type the resolution was requested for. */
  contextType?: string | null;
  /** Context id the resolution was requested for. */
  contextId?: string | null;
  /** Whether a persona matched (`'persona'`) or the default was used (`'default'`). */
  source: 'persona' | 'default';
  /** For a matched persona, whether it was the tenant's own or inherited. */
  personaSource?: 'explicit' | 'inherited';
  /** Tenant the matched persona came from (own tenant or an ancestor). */
  sourceTenantId?: string;
  /** Whether the `TenantAgent` gate reports the agent as available. */
  available: boolean;
}

/**
 * Project a `TenantAgent` resolution into a {@link PersonaAvailabilityGate}.
 *
 * This is the concrete bridge between the `@happyvertical/smrt-agents`
 * availability layer and the persona layer. Pass `toolPermissionPrefix` to
 * derive a tool ceiling from granted permission ids (permissions whose id
 * starts with the prefix become the ceiling, with the prefix stripped); omit it
 * to leave the ceiling open.
 *
 * @param resolved - A `ResolvedAgentAvailability` (or `null`/`undefined`).
 * @param options.toolPermissionPrefix - Permission-id prefix that marks
 *   tool grants (e.g. `'tool:'`).
 * @returns A gate, or `null` when `resolved` is nullish.
 */
export function availabilityFromResolvedAgent(
  resolved: ResolvedAgentAvailability | null | undefined,
  options: { toolPermissionPrefix?: string } = {},
): PersonaAvailabilityGate | null {
  if (!resolved) {
    return null;
  }

  const { toolPermissionPrefix } = options;
  let toolCeiling: string[] | undefined;
  if (toolPermissionPrefix) {
    toolCeiling = Object.entries(resolved.permissions ?? {})
      .filter(([id, granted]) => granted && id.startsWith(toolPermissionPrefix))
      .map(([id]) => id.slice(toolPermissionPrefix.length));
  }

  return {
    status: resolved.status,
    toolCeiling,
    sourceTenantId: resolved.sourceTenantId,
  };
}

/**
 * Resolves the active persona for a `(tenant, agentClass, context)` request.
 */
export class PersonaResolver {
  constructor(private readonly personas: AgentPersonaCollection) {}

  /**
   * Resolve the active persona.
   *
   * @param tenantId - Requesting tenant.
   * @param agentClass - Agent class (canonicalized internally).
   * @param context - Context dimension being resolved for.
   * @param options - Hierarchy walk, manifest defaults, and availability gate.
   * @returns The layered {@link ResolvedPersona} — either a matched persona or
   *   the defined default fallback.
   */
  async resolve(
    tenantId: string,
    agentClass: string,
    context: PersonaContext = {},
    options: ResolvePersonaOptions = {},
  ): Promise<ResolvedPersona> {
    const canonical = canonicalAgentClass(agentClass);
    const { getAncestorIds, manifestDefaults, availability } = options;

    const ancestorIds = getAncestorIds ? await getAncestorIds(tenantId) : [];
    const levels = [tenantId, ...ancestorIds];

    for (let level = 0; level < levels.length; level++) {
      const levelTenantId = levels[level];
      const candidates = await this.personas.findActive(
        levelTenantId,
        canonical,
        context,
      );

      if (candidates.length === 0) {
        continue;
      }

      const winner = pickWinner(candidates);
      return this.layerPersona(winner, {
        canonical,
        tenantId,
        context,
        manifestDefaults,
        availability,
        personaSource: level === 0 ? 'explicit' : 'inherited',
        sourceTenantId: levelTenantId,
      });
    }

    return this.defaultResolution({
      canonical,
      tenantId,
      context,
      manifestDefaults,
      availability,
    });
  }

  private layerPersona(
    persona: AgentPersona,
    ctx: LayerContext & {
      personaSource: 'explicit' | 'inherited';
      sourceTenantId: string;
    },
  ): ResolvedPersona {
    const { manifestDefaults, availability } = ctx;
    const personaTools = persona.getAllowedTools();
    const baseTools =
      personaTools.length > 0
        ? personaTools
        : (manifestDefaults?.allowedTools ?? []);

    return {
      agentClass: ctx.canonical,
      tenantId: ctx.tenantId,
      personaId: persona.id ?? undefined,
      name: persona.name,
      instructions:
        persona.instructions || manifestDefaults?.instructions || '',
      allowedTools: applyCeiling(baseTools, availability),
      runAsUserId: persona.runAsUserId || undefined,
      actsAsProfileId: persona.actsAsProfileId ?? null,
      memoryScope: resolveMemoryScope(persona.memoryScope, ctx),
      priority: persona.priority,
      contextType: ctx.context.contextType ?? null,
      contextId: ctx.context.contextId ?? null,
      source: 'persona',
      personaSource: ctx.personaSource,
      sourceTenantId: ctx.sourceTenantId,
      available: isAvailable(availability),
    };
  }

  private defaultResolution(ctx: LayerContext): ResolvedPersona {
    const { manifestDefaults, availability } = ctx;
    return {
      agentClass: ctx.canonical,
      tenantId: ctx.tenantId,
      name: 'default',
      instructions: manifestDefaults?.instructions ?? '',
      allowedTools: applyCeiling(
        manifestDefaults?.allowedTools ?? [],
        availability,
      ),
      actsAsProfileId: null,
      memoryScope: resolveMemoryScope('', ctx),
      priority: 0,
      contextType: ctx.context.contextType ?? null,
      contextId: ctx.context.contextId ?? null,
      source: 'default',
      available: isAvailable(availability),
    };
  }
}

interface LayerContext {
  canonical: string;
  tenantId: string;
  context: PersonaContext;
  manifestDefaults?: ManifestPersonaDefaults;
  availability?: PersonaAvailabilityGate | null;
}

/**
 * Pick the winning persona from candidates already known to apply to the
 * requested context and be enabled.
 *
 * Order: most context-specific first, then highest priority, then name for a
 * stable deterministic tie-break.
 */
function pickWinner(candidates: AgentPersona[]): AgentPersona {
  return [...candidates].sort((a, b) => {
    const rankDelta = personaContextRank(b) - personaContextRank(a);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    if (b.priority !== a.priority) {
      return b.priority - a.priority;
    }
    return (a.name ?? '').localeCompare(b.name ?? '');
  })[0];
}

function applyCeiling(
  tools: string[],
  availability?: PersonaAvailabilityGate | null,
): string[] {
  if (!availability?.toolCeiling) {
    return [...tools];
  }
  const ceiling = new Set(availability.toolCeiling);
  return tools.filter((tool) => ceiling.has(tool));
}

function isAvailable(availability?: PersonaAvailabilityGate | null): boolean {
  return availability ? availability.status === 'active' : true;
}

function resolveMemoryScope(explicit: string, ctx: LayerContext): string {
  if (explicit) {
    return explicit;
  }
  if (ctx.manifestDefaults?.memoryScope) {
    return ctx.manifestDefaults.memoryScope;
  }
  const contextSuffix = ctx.context.contextType
    ? `:${ctx.context.contextType}${ctx.context.contextId ? `:${ctx.context.contextId}` : ''}`
    : '';
  return `${ctx.canonical}:${ctx.tenantId}${contextSuffix}`;
}

// Re-export the context applicability helper for consumers building their own
// persona selection UIs without duplicating the semantics.
export { personaAppliesToContext };
