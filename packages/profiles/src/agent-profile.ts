/**
 * Agent (bot) profile resolution (#2995).
 *
 * An automated agent that participates in a conversation is still an author,
 * and every authoring seam in the framework — `ChatMessage.senderProfileId`,
 * `ChatParticipant.profileId`, `ChatReaction.profileId`, a persona's
 * `actsAsProfileId` — is a `crossPackageRef` to a {@link Profile} and therefore
 * a native uuid column on PostgreSQL/DuckDB. A slug-style agent identifier
 * (`anytown_site_assistant`) is not a representable author there: it fails the
 * uuid cast (22P02) at the boundary that owns it.
 *
 * `Profile` already models this: the `bot` profile type is "automated agents,
 * bots, and AI entities". This module is the owning-package API that turns a
 * stable agent identifier into that Profile's uuid, so consumers never have to
 * mint bot profiles themselves and never have to weaken a uuid column to text.
 *
 * Identity is keyed on `(tenantId, slug = agentId, context =
 * {@link AGENT_PROFILE_CONTEXT})`. The reserved slug context keeps an agent
 * profile from ever colliding with an unrelated human/organization profile that
 * happens to share the slug, and matches the model's
 * `(tenant_id, slug, context, _meta_type)` unique key.
 *
 * @module
 */

import type { ProfileCollection } from './collections/ProfileCollection';
import { ProfileTypeCollection } from './collections/ProfileTypeCollection';
import type { Profile } from './models/Profile';

/**
 * Reserved slug context for agent-owned profiles.
 *
 * Agent identifiers come from application configuration, not from the profile
 * namespace, so they are scoped into their own slug context rather than
 * competing with person/organization slugs.
 */
export const AGENT_PROFILE_CONTEXT = 'smrt:agent';

/** Slug of the {@link ProfileType} agent profiles are classified under. */
export const AGENT_PROFILE_TYPE_SLUG = 'bot';

/** Inputs for {@link resolveAgentProfile}. */
export interface ResolveAgentProfileParams {
  /** Stable agent identifier (e.g. `anytown_site_assistant`). */
  agentId: string;
  /** Owning tenant, or `null` for an untenanted agent. */
  tenantId?: string | null;
  /** Display name for a newly created profile. Defaults to `agentId`. */
  name?: string;
}

/**
 * Resolve — creating on first use — the {@link Profile} an agent authors as.
 *
 * The lookup is tenant-bound: an agent identifier resolves to a distinct
 * profile per tenant, so one tenant's assistant can never author into another
 * tenant's conversation. Resolution is idempotent; repeated calls for the same
 * `(tenantId, agentId)` return the same profile.
 *
 * @param profiles - Profile collection bound to the caller's database options.
 * @param params - Agent identity to resolve.
 * @returns The agent's profile, whose `id` is a real uuid.
 * @throws Error when `agentId` is empty.
 */
export async function resolveAgentProfile(
  profiles: ProfileCollection,
  params: ResolveAgentProfileParams,
): Promise<Profile> {
  const agentId = params.agentId?.trim();
  if (!agentId) {
    throw new Error('resolveAgentProfile requires a non-empty agentId');
  }
  const tenantId = params.tenantId ?? null;
  const key = { slug: agentId, context: AGENT_PROFILE_CONTEXT, tenantId };

  // First use races (two simultaneous first turns for one agent) are resolved by
  // converging on the natural key rather than by whoever's INSERT won: each
  // attempt re-reads before and after writing, so a racer whose own write lost
  // to a revision conflict or to the `(tenant_id, slug, context)` upsert still
  // returns the surviving row instead of a dangling id. Two attempts suffice —
  // the loser of the first is a plain read on the second.
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await profiles.get(key);
    if (existing) return existing;

    try {
      const profileTypes = await ProfileTypeCollection.create(profiles.options);
      const agentType = await profileTypes.getOrCreateBySlug(
        AGENT_PROFILE_TYPE_SLUG,
        {
          name: 'Bot',
          description: 'Automated agents, bots, and AI entities',
        },
      );

      const profile = await profiles.create({
        ...key,
        typeId: agentType.id as string,
        name: params.name?.trim() || agentId,
      });
      await profile.save();
    } catch (error) {
      lastError = error;
    }

    const settled = await profiles.get(key);
    if (settled) return settled;
  }

  throw new Error(
    `Could not resolve an agent profile for '${agentId}'${
      lastError instanceof Error ? `: ${lastError.message}` : ''
    }`,
  );
}

/**
 * Resolve an agent profile and return its uuid.
 *
 * Convenience wrapper for the common case — an authoring seam that needs the
 * id, not the row.
 *
 * @param profiles - Profile collection bound to the caller's database options.
 * @param params - Agent identity to resolve.
 * @returns The agent profile's uuid.
 */
export async function resolveAgentProfileId(
  profiles: ProfileCollection,
  params: ResolveAgentProfileParams,
): Promise<string> {
  const profile = await resolveAgentProfile(profiles, params);
  const id = profile.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(
      `Agent profile for '${params.agentId}' was persisted without an id`,
    );
  }
  return id;
}
