/**
 * Persona-as-durable-instance helpers (#1890).
 *
 * Treats an {@link AgentPersona} as a **durable instance** of an agent class:
 * N configured instances per tenant, each independently scheduled, memory-scoped,
 * and permission-scoped. This module wires that instance concept to the
 * `@happyvertical/smrt-agents` runtime:
 *
 * - **Identity** — {@link personaInstanceKey} / {@link agentOptionsForPersona}
 *   map a persona to the `AgentOptions.instanceKey` the framework folds into a
 *   per-instance dispatch subscriber, memory scope, and interest scope. The
 *   `default` persona reuses the **singleton** identity (a `null` key), which is
 *   what makes the singleton→multi upgrade non-destructive.
 * - **Scheduling** — {@link schedulePersonaInstance} binds an `AgentSchedule` to
 *   a persona instance (the schedule already carries `agentId`).
 * - **Admin** — {@link buildPersonaInstanceAdmin} renders the agent class's
 *   `uiSlots`/`adminRoutes` once per instance, with {@link addPersonaInstance} /
 *   {@link removePersonaInstance} affordances.
 * - **Upgrade** — {@link upgradeSingletonToDefaultPersona} maps an existing
 *   singleton to a single `default` persona without touching its data.
 *
 * Multi-instance is a per-package opt-in on the agent class
 * (`static multiInstance = true`); these helpers manage the persona rows that
 * back it. A singleton (non-opted) agent needs none of this and is unchanged.
 */

import {
  type AgentAdminRoute,
  type AgentManifestInfo,
  type AgentSchedule,
  type AgentScheduleCollection,
  type AgentUISlots,
  instanceScopedSubscriber,
} from '@happyvertical/smrt-agents';
import {
  type AgentPersona,
  type AgentPersonaCollection,
  canonicalAgentClass,
} from './agent-persona.js';

/**
 * The reserved persona name for the singleton/default instance.
 *
 * Matches the `PersonaResolver` default-fallback name so the concept is
 * consistent across the package. A persona with this name is the tenant's
 * singleton identity: it maps to a `null` instance key (see
 * {@link personaInstanceKey}), reusing the class-keyed dispatch subscriber and
 * un-suffixed memory scope an un-upgraded agent already uses.
 */
export const DEFAULT_PERSONA_NAME = 'default';

/**
 * The durable per-instance key for a persona, or `null` for the singleton.
 *
 * - The `default` persona → `null`: it *is* the singleton identity, so an agent
 *   run as it keeps the class-keyed dispatch subscriber and un-suffixed memory
 *   scope. This is why upgrading a singleton to a default persona changes no
 *   runtime identity (non-destructive).
 * - Any other persona → its `id`: a distinct, stable instance key the framework
 *   folds into a per-instance subscriber/memory/interest scope.
 *
 * @throws Error if a non-default persona has no `id` (it must be saved first —
 *   an unsaved non-default persona would masquerade as the singleton).
 */
export function personaInstanceKey(
  persona: Pick<AgentPersona, 'name' | 'id'>,
): string | null {
  if (persona.name === DEFAULT_PERSONA_NAME) {
    return null;
  }
  if (!persona.id) {
    throw new Error(
      'personaInstanceKey: a non-default persona must be saved (have an id) ' +
        'before it can act as a durable instance',
    );
  }
  return persona.id;
}

/**
 * Whether a persona is the singleton/default instance.
 */
export function isDefaultPersona(persona: Pick<AgentPersona, 'name'>): boolean {
  return persona.name === DEFAULT_PERSONA_NAME;
}

/**
 * The subset of `AgentOptions` a runtime spreads to construct an agent as this
 * persona instance. Kept structural (no agents runtime import needed by the
 * caller) — spread into `new AgentClass({ ...agentOptionsForPersona(p), db })`.
 */
export interface PersonaAgentOptions {
  /** Per-instance key — `null` for the default (singleton) persona. */
  instanceKey: string | null;
  /** The tenant the persona belongs to. */
  tenantId: string;
}

/**
 * Project a persona into the agent construction options that give the agent its
 * per-instance identity.
 */
export function agentOptionsForPersona(
  persona: AgentPersona,
): PersonaAgentOptions {
  return {
    instanceKey: personaInstanceKey(persona),
    tenantId: persona.tenantId,
  };
}

/**
 * Options for {@link schedulePersonaInstance}.
 */
export interface SchedulePersonaInstanceOptions {
  /** Cron expression (5-field). */
  cron: string;
  /** Timezone label (default `'UTC'`). */
  timezone?: string;
  /** Agent method to invoke (default `'run'`). */
  method?: string;
  /** Config passed to the agent on each run. */
  agentConfig?: Record<string, unknown>;
  /** Arguments passed to the method. */
  methodArgs?: Record<string, unknown>;
  /** Whether the schedule starts enabled (default `true`). */
  enabled?: boolean;
}

/**
 * Create an `AgentSchedule` bound to a persona **instance**.
 *
 * The schedule's `agentType` is the persona's agent class and its `agentId` is
 * the persona instance key ({@link personaInstanceKey}) — `null` for the default
 * (so it runs the singleton), the persona id otherwise (so the runtime
 * constructs that specific instance). This is the per-instance scheduling the
 * issue calls for: many schedules for one class, one per instance.
 *
 * @param schedules - The `AgentScheduleCollection` to create into.
 * @param persona - The persona instance to schedule (must be saved).
 * @param options - Cron and run settings.
 */
export async function schedulePersonaInstance(
  schedules: AgentScheduleCollection,
  persona: AgentPersona,
  options: SchedulePersonaInstanceOptions,
): Promise<AgentSchedule> {
  const instanceKey = personaInstanceKey(persona);
  const schedule = await schedules.create({
    tenantId: persona.tenantId,
    agentType: persona.agentClass,
    agentId: instanceKey,
    cron: options.cron,
    timezone: options.timezone ?? 'UTC',
    method: options.method ?? 'run',
    agentConfig: options.agentConfig ?? {},
    methodArgs: options.methodArgs ?? {},
    enabled: options.enabled ?? true,
  });
  await schedule.save();
  return schedule;
}

/**
 * One instance's row in the instance-aware admin surface.
 *
 * Carries the agent class's admin surface (`slots` / `adminRoutes`) rendered for
 * THIS instance, plus the resolved per-instance dispatch subscriber so the admin
 * can show how the instance is routed.
 */
export interface PersonaInstanceView {
  /** The persona id backing this instance. */
  personaId: string;
  /** Persona (instance) name. */
  name: string;
  /** Per-instance key — `null` for the default (singleton). */
  instanceKey: string | null;
  /** Whether this is the default (singleton) instance. */
  isDefault: boolean;
  /** Whether the instance is enabled. */
  enabled: boolean;
  /** Resolution priority. */
  priority: number;
  /** Context scoping (if any). */
  contextType: string | null;
  contextId: string | null;
  /** The principal the instance runs as. */
  runAsUserId: string;
  /** Optional acting bot identity. */
  actsAsProfileId: string | null;
  /** The per-instance dispatch subscriber identity. */
  dispatchSubscriber: string;
  /** The agent class's UI slots, rendered for this instance. */
  slots: AgentUISlots;
  /** The agent class's admin routes, rendered for this instance. */
  adminRoutes: AgentAdminRoute[];
}

/**
 * The instance-aware admin surface for one `(tenant, agentClass)` pair.
 */
export interface PersonaInstanceAdminView {
  /** Canonical agent class the surface is for. */
  agentClass: string;
  /** Tenant the surface is for. */
  tenantId: string;
  /** One entry per configured instance (persona), priority-ordered. */
  instances: PersonaInstanceView[];
  /** Whether new instances may be added (always true for the persona model). */
  canAddInstance: boolean;
}

/**
 * Options for {@link buildPersonaInstanceAdmin}.
 */
export interface BuildPersonaInstanceAdminOptions {
  /** Tenant to render the surface for. */
  tenantId: string;
  /** Agent class (canonicalized internally). */
  agentClass: string;
  /**
   * The agent class's manifest surface. Its `uiSlots` / `adminRoutes` are
   * rendered once per instance. Optional — omit to render instances with empty
   * panels (e.g. a class that declares none).
   */
  manifest?: Pick<AgentManifestInfo, 'uiSlots' | 'adminRoutes'>;
}

/**
 * Build the instance-aware admin surface: one panel set per configured instance.
 *
 * Lists the tenant's persona instances for the class and renders the class's
 * `uiSlots`/`adminRoutes` for each, so an admin sees N instances (not one class
 * panel) with add/remove affordances. The default (singleton) instance appears
 * with `instanceKey: null` and the class-keyed subscriber.
 *
 * @param personas - Persona collection to read instances from.
 * @param options - Tenant, class, and the class manifest to render per instance.
 */
export async function buildPersonaInstanceAdmin(
  personas: AgentPersonaCollection,
  options: BuildPersonaInstanceAdminOptions,
): Promise<PersonaInstanceAdminView> {
  const canonical = canonicalAgentClass(options.agentClass);
  const slots = options.manifest?.uiSlots ?? {};
  const adminRoutes = options.manifest?.adminRoutes ?? [];

  const rows = await personas.byTenantAndClass(options.tenantId, canonical);

  const instances: PersonaInstanceView[] = rows.map((persona) => {
    const instanceKey = personaInstanceKey(persona);
    return {
      personaId: persona.id as string,
      name: persona.name,
      instanceKey,
      isDefault: isDefaultPersona(persona),
      enabled: persona.enabled,
      priority: persona.priority,
      contextType: persona.contextType,
      contextId: persona.contextId,
      runAsUserId: persona.runAsUserId,
      actsAsProfileId: persona.actsAsProfileId,
      dispatchSubscriber: instanceScopedSubscriber(canonical, instanceKey),
      slots,
      adminRoutes,
    };
  });

  return {
    agentClass: canonical,
    tenantId: options.tenantId,
    instances,
    canAddInstance: true,
  };
}

/**
 * Options for {@link addPersonaInstance}.
 */
export interface AddPersonaInstanceOptions {
  tenantId: string;
  agentClass: string;
  /** Instance name (unique per `(tenant, agentClass)`). */
  name: string;
  /** The principal the instance runs as (required by `AgentPersona`). */
  runAsUserId: string;
  instructions?: string;
  allowedTools?: string[];
  contextType?: string | null;
  contextId?: string | null;
  priority?: number;
  memoryScope?: string;
  actsAsProfileId?: string | null;
  enabled?: boolean;
}

/**
 * Add a new instance (persona) — the "add" admin affordance.
 *
 * Creates and saves an `AgentPersona`, canonicalizing the agent class so it
 * lines up with `TenantAgent`. The `(tenant_id, agent_class, name)` unique
 * constraint rejects a duplicate name.
 */
export async function addPersonaInstance(
  personas: AgentPersonaCollection,
  options: AddPersonaInstanceOptions,
): Promise<AgentPersona> {
  const persona = await personas.create({
    tenantId: options.tenantId,
    agentClass: canonicalAgentClass(options.agentClass),
    name: options.name,
    instructions: options.instructions ?? '',
    contextType: options.contextType ?? null,
    contextId: options.contextId ?? null,
    priority: options.priority ?? 0,
    enabled: options.enabled ?? true,
    runAsUserId: options.runAsUserId,
    actsAsProfileId: options.actsAsProfileId ?? null,
    memoryScope: options.memoryScope ?? '',
  });
  if (options.allowedTools) {
    persona.setAllowedTools(options.allowedTools);
  }
  await persona.save();
  return persona;
}

/**
 * Remove an instance (persona) by id — the "remove" admin affordance.
 *
 * Deletes only the named instance; other instances of the class are untouched.
 * A no-op (returns `false`) when the persona does not exist.
 *
 * @returns `true` if a persona was removed, `false` if none matched the id.
 */
export async function removePersonaInstance(
  personas: AgentPersonaCollection,
  personaId: string,
): Promise<boolean> {
  const persona = await personas.get({ id: personaId });
  if (!persona) {
    return false;
  }
  await persona.delete();
  return true;
}

/**
 * Options for {@link upgradeSingletonToDefaultPersona}.
 */
export interface UpgradeSingletonOptions {
  tenantId: string;
  agentClass: string;
  /** The principal the default persona runs as (required by `AgentPersona`). */
  runAsUserId: string;
  /** Instructions to seed the default persona with (from existing config). */
  instructions?: string;
  /** Tools to seed (from existing config). */
  allowedTools?: string[];
  /**
   * Memory scope for the default persona. Leave empty (default) to let the
   * resolver derive it — for the default (null-keyed) instance the derived
   * scope equals the singleton's existing `agent/<type>` scope, so existing
   * learned memory is preserved untouched.
   */
  memoryScope?: string;
  actsAsProfileId?: string | null;
}

/**
 * The result of a singleton→multi upgrade.
 */
export interface UpgradeSingletonResult {
  /** The default persona representing the existing singleton instance. */
  persona: AgentPersona;
  /** `true` if it was created now, `false` if a default persona already existed. */
  created: boolean;
  /**
   * The instance key for the default persona — always `null`, i.e. it maps to
   * the existing singleton runtime identity (same dispatch subscriber + memory
   * scope), which is what makes the upgrade non-destructive.
   */
  instanceKey: null;
}

/**
 * Non-destructively upgrade a singleton agent to the multi-instance model by
 * mapping the existing instance to a single `default` persona.
 *
 * The default persona is null-keyed, so it *reuses the singleton's exact runtime
 * identity* — the class-keyed dispatch subscriber and the un-suffixed
 * `agent/<type>` memory scope. Nothing about the running agent, its config, its
 * dispatch subscriptions, or its learned memory changes; a persona row is simply
 * added so further instances can now be created alongside it.
 *
 * Idempotent: if a `default` persona already exists for the pair it is returned
 * with `created: false` and nothing is duplicated.
 *
 * @param personas - Persona collection to read/create into.
 * @param options - Tenant, class, and the principal + config to seed.
 */
export async function upgradeSingletonToDefaultPersona(
  personas: AgentPersonaCollection,
  options: UpgradeSingletonOptions,
): Promise<UpgradeSingletonResult> {
  const canonical = canonicalAgentClass(options.agentClass);

  const existing = await personas.byTenantAndClass(options.tenantId, canonical);
  const existingDefault = existing.find(isDefaultPersona);
  if (existingDefault) {
    return { persona: existingDefault, created: false, instanceKey: null };
  }

  const persona = await addPersonaInstance(personas, {
    tenantId: options.tenantId,
    agentClass: canonical,
    name: DEFAULT_PERSONA_NAME,
    runAsUserId: options.runAsUserId,
    instructions: options.instructions,
    allowedTools: options.allowedTools,
    memoryScope: options.memoryScope,
    actsAsProfileId: options.actsAsProfileId,
    priority: 0,
    enabled: true,
  });

  return { persona, created: true, instanceKey: null };
}
