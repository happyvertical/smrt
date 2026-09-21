/**
 * Agent (bot) profile resolution (#2995).
 *
 * Real file-backed SQLite, no DB mocking. The uuid-column behaviour this API
 * exists for is proved against PostgreSQL in `@happyvertical/smrt-chat`'s
 * `agent-reply-postgres.test.ts`; here we pin the resolution contract:
 * idempotence, tenant isolation, classification, and slug scoping.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_PROFILE_CONTEXT,
  AGENT_PROFILE_TYPE_SLUG,
  ProfileCollection,
  resolveAgentProfile,
  resolveAgentProfileId,
} from '../index.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

describe('resolveAgentProfile', () => {
  let db: { type: 'sqlite'; url: string };
  let profiles: ProfileCollection;

  beforeEach(async () => {
    db = {
      type: 'sqlite',
      url: `file:${join(tmpdir(), `agent-profile-${randomUUID()}.db`)}`,
    };
    profiles = await ProfileCollection.create({ db });
  });

  it('creates a bot profile with a uuid id on first use', async () => {
    const profile = await resolveAgentProfile(profiles, {
      agentId: 'site_assistant',
      tenantId: randomUUID(),
    });

    expect(profile.id).toMatch(UUID_RE);
    expect(profile.slug).toBe('site_assistant');
    expect(profile.context).toBe(AGENT_PROFILE_CONTEXT);
    expect(profile.name).toBe('site_assistant');
    expect(await profile.getTypeSlug()).toBe(AGENT_PROFILE_TYPE_SLUG);
  });

  it('is idempotent for the same tenant and agent', async () => {
    const tenantId = randomUUID();
    const first = await resolveAgentProfileId(profiles, {
      agentId: 'site_assistant',
      tenantId,
    });
    const second = await resolveAgentProfileId(profiles, {
      agentId: 'site_assistant',
      tenantId,
    });

    expect(second).toBe(first);
  });

  it('resolves a distinct profile per tenant', async () => {
    const a = await resolveAgentProfileId(profiles, {
      agentId: 'site_assistant',
      tenantId: randomUUID(),
    });
    const b = await resolveAgentProfileId(profiles, {
      agentId: 'site_assistant',
      tenantId: randomUUID(),
    });

    expect(b).not.toBe(a);
  });

  it('resolves a distinct profile per agent id', async () => {
    const tenantId = randomUUID();
    const a = await resolveAgentProfileId(profiles, {
      agentId: 'site_assistant',
      tenantId,
    });
    const b = await resolveAgentProfileId(profiles, {
      agentId: 'weather_agent',
      tenantId,
    });

    expect(b).not.toBe(a);
  });

  it('accepts an untenanted agent', async () => {
    const id = await resolveAgentProfileId(profiles, {
      agentId: 'global_agent',
      tenantId: null,
    });

    expect(id).toMatch(UUID_RE);
  });

  it('honours an explicit display name', async () => {
    const profile = await resolveAgentProfile(profiles, {
      agentId: 'site_assistant',
      tenantId: randomUUID(),
      name: 'Site Assistant',
    });

    expect(profile.name).toBe('Site Assistant');
  });

  it('rejects an empty agent id', async () => {
    await expect(
      resolveAgentProfile(profiles, { agentId: '  ', tenantId: null }),
    ).rejects.toThrow('non-empty agentId');
  });
});
