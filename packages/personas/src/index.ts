/**
 * @happyvertical/smrt-personas
 *
 * Tenant-owned, context-scoped agent personas and their resolution. Layers over
 * `@happyvertical/smrt-agents`' `TenantAgent` availability/ceiling gate to
 * decide how an agent should behave for a given tenant and context.
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

export {
  AgentPersona,
  AgentPersonaCollection,
  canonicalAgentClass,
  personaAppliesToContext,
  personaContextRank,
} from './agent-persona.js';
export {
  availabilityFromResolvedAgent,
  type ManifestPersonaDefaults,
  type PersonaAvailabilityGate,
  type PersonaContext,
  PersonaResolver,
  type ResolvedPersona,
  type ResolvePersonaOptions,
} from './persona-resolver.js';
