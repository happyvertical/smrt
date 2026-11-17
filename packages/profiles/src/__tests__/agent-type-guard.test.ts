/**
 * The `bot` profile type is the MCP agent marker (#5086): an unprivileged
 * request principal must not move a profile off it or rename it.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentTypeChangeError,
  ProfileCollection,
  ProfileTypeCollection,
  resolveAgentProfile,
} from '../index.js';
import { createOwnedSqliteFixtures } from './owned-sqlite-fixtures.js';

const fixtures = createOwnedSqliteFixtures();
type Getter = () => { systemContext: boolean; superAdminBypass: boolean };
const root = globalThis as { __smrtGetRequestPermissionContext?: Getter };

function asPrincipal(
  context: { systemContext: boolean; superAdminBypass: boolean },
  run: () => Promise<void>,
) {
  const previous = root.__smrtGetRequestPermissionContext;
  root.__smrtGetRequestPermissionContext = () => context;
  return run().finally(() => {
    root.__smrtGetRequestPermissionContext = previous;
  });
}

const plain = { systemContext: false, superAdminBypass: false };

describe('bot profile type guard', () => {
  let db: { type: 'sqlite'; url: string };
  let profiles: ProfileCollection;

  beforeEach(async () => {
    db = { type: 'sqlite', url: fixtures.url('agent-type-guard') };
    profiles = await ProfileCollection.create({ db });
    fixtures.track(profiles.db);
  });
  afterEach(() => fixtures.cleanup());

  async function setup() {
    const tenantId = randomUUID();
    const agent = await resolveAgentProfile(profiles, {
      agentId: 'notes_agent',
      tenantId,
    });
    const types = await ProfileTypeCollection.create({ db });
    const person = await types.getOrCreateBySlug('person', { name: 'Person' });
    return { agent, person, types, tenantId };
  }

  it('refuses an unprivileged principal moving an agent off the bot type', async () => {
    const { agent, person } = await setup();
    await asPrincipal(plain, async () => {
      const loaded = await profiles.get(agent.id as string);
      if (!loaded) throw new Error('missing');
      loaded.typeId = person.id as string;
      await expect(loaded.save()).rejects.toBeInstanceOf(AgentTypeChangeError);
    });
    expect(await (await profiles.get(agent.id as string))?.getTypeSlug()).toBe(
      'bot',
    );
  });

  it('refuses moving a person onto the bot type', async () => {
    const { person, types, tenantId } = await setup();
    const human = await profiles.create({
      slug: 'human',
      name: 'Human',
      tenantId,
      typeId: person.id as string,
    });
    await human.save();
    const bot = await types.getBySlug('bot');
    await asPrincipal(plain, async () => {
      const loaded = await profiles.get(human.id as string);
      if (!loaded) throw new Error('missing');
      loaded.typeId = bot?.id as string;
      await expect(loaded.save()).rejects.toBeInstanceOf(AgentTypeChangeError);
    });
  });

  it('allows a principal moving a profile between two non-bot types', async () => {
    const { person, types, tenantId } = await setup();
    const org = await types.getOrCreateBySlug('organization', {
      name: 'Organization',
    });
    const human = await profiles.create({
      slug: 'between-types',
      name: 'Between types',
      tenantId,
      typeId: person.id as string,
    });
    await human.save();
    await asPrincipal(plain, async () => {
      const loaded = await profiles.get(human.id as string);
      if (!loaded) throw new Error('missing');
      loaded.typeId = org.id as string;
      await loaded.save();
      const back = await profiles.get(human.id as string);
      expect(back?.typeId).toBe(org.id);
    });
  });

  it('allows system, super-admin and principal-free code, and unrelated edits', async () => {
    const { agent, person } = await setup();
    // An unrelated edit by a principal is untouched.
    await asPrincipal(plain, async () => {
      const loaded = await profiles.get(agent.id as string);
      if (!loaded) throw new Error('missing');
      loaded.name = 'Renamed agent';
      await loaded.save();
    });
    for (const context of [
      { systemContext: true, superAdminBypass: false },
      { systemContext: false, superAdminBypass: true },
    ]) {
      await asPrincipal(context, async () => {
        const loaded = await profiles.get(agent.id as string);
        if (!loaded) throw new Error('missing');
        loaded.typeId = person.id as string;
        await loaded.save();
        const back = await profiles.get(agent.id as string);
        if (!back) throw new Error('missing');
        back.typeId = (
          await (await ProfileTypeCollection.create({ db })).getBySlug('bot')
        )?.id as string;
        await back.save();
      });
    }
    // No principal context at all (provisioning, CLI): trusted.
    const loaded = await profiles.get(agent.id as string);
    if (!loaded) throw new Error('missing');
    loaded.typeId = person.id as string;
    await loaded.save();
  });

  it('refuses a principal renaming the bot type', async () => {
    const { types } = await setup();
    const bot = await types.getBySlug('bot');
    if (!bot) throw new Error('missing bot type');
    await asPrincipal(plain, async () => {
      const loaded = await types.get(bot.id as string);
      if (!loaded) throw new Error('missing');
      loaded.slug = 'robot';
      await expect(loaded.save()).rejects.toBeInstanceOf(AgentTypeChangeError);
    });
    expect((await types.get(bot.id as string))?.slug).toBe('bot');
  });

  it('refuses a natural-key upsert that would adopt an agent row as a person', async () => {
    const { agent, person, tenantId } = await setup();
    await asPrincipal(plain, async () => {
      // `create` persists, so the refusal surfaces from the call itself.
      await expect(
        profiles.create({
          slug: agent.slug,
          context: agent.context,
          tenantId,
          name: 'Impostor',
          typeId: person.id as string,
        }),
      ).rejects.toBeInstanceOf(AgentTypeChangeError);
    });
    expect(await (await profiles.get(agent.id as string))?.getTypeSlug()).toBe(
      'bot',
    );
  });

  it('refuses creating a bot profile or a bot type, but provisioning still works', async () => {
    const { types, tenantId } = await setup();
    const bot = await types.getBySlug('bot');
    await asPrincipal(plain, async () => {
      await expect(
        profiles.create({
          slug: 'fake-agent',
          tenantId,
          name: 'Fake',
          typeId: bot?.id as string,
        }),
      ).rejects.toBeInstanceOf(AgentTypeChangeError);
      await expect(
        types.create({ slug: 'bot', name: 'Bot' }),
      ).rejects.toBeInstanceOf(AgentTypeChangeError);
      // The framework's own provisioning API stays usable by any caller.
      const made = await resolveAgentProfile(profiles, {
        agentId: 'another_agent',
        tenantId,
      });
      expect(await made.getTypeSlug()).toBe('bot');
    });
  });
});
