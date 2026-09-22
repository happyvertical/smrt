/**
 * Agent-reply authoring — PostgreSQL uuid boundary (#2995).
 *
 * `ChatMessage.senderProfileId` and `ChatParticipant.profileId` are
 * `crossPackageRef`s to `@happyvertical/smrt-profiles:Profile` and therefore
 * materialize as native `uuid` columns on PostgreSQL. The agent-reply path used
 * to author with `AgentSession.agentId` — an application slug such as
 * `anytown_site_assistant` — so every assistant reply failed the uuid cast
 * (`22P02: invalid input syntax for type uuid`) and no agent reply could be
 * persisted.
 *
 * This regression is invisible on SQLite, where the same column is text and
 * accepts the slug, which is why the package's SQLite-backed suite stayed
 * green. It therefore has to be proven against a real PostgreSQL database.
 *
 * Gated on `DATABASE_URL` (skips without a PostgreSQL test database).
 */

import {
  ProfileCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatService, sendAgentReply } from '../services/ChatService.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const AGENT_ID = 'anytown_site_assistant';

describePostgres('agent reply authoring on PostgreSQL (#2995)', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let chat: ChatService;
  let tenantId: string;
  let actorProfileId: string;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        '@happyvertical/smrt-chat:ChatRoom',
        '@happyvertical/smrt-chat:ChatMessage',
        '@happyvertical/smrt-chat:ChatParticipant',
        '@happyvertical/smrt-chat:ChatThread',
        '@happyvertical/smrt-chat:ChatReaction',
        '@happyvertical/smrt-chat:AgentSession',
        '@happyvertical/smrt-chat:VoiceSession',
        '@happyvertical/smrt-profiles:Profile',
        '@happyvertical/smrt-profiles:ProfileType',
      ],
    });
    const options = { db: isolated.db };

    tenantId = crypto.randomUUID();

    const profileTypes = await ProfileTypeCollection.create(options);
    const personType = await profileTypes.getOrCreateBySlug('person', {
      name: 'Person',
    });
    const profiles = await ProfileCollection.create(options);
    const actor = await profiles.create({
      tenantId,
      typeId: personType.id as string,
      name: 'Operator',
    });
    await actor.save();
    actorProfileId = actor.id as string;

    chat = await ChatService.create(options);
  });

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('persists an assistant reply authored as the agent profile uuid', async () => {
    const { session } = await chat.createAgentSession({
      tenantId,
      agentId: AGENT_ID,
      actorProfileId,
    });

    // The session records a resolved Profile uuid, never the agent slug.
    expect(session.agentProfileId).toMatch(UUID_RE);
    expect(session.agentProfileId).not.toBe(AGENT_ID);

    await chat.sendAgentUserMessage({
      tenantId,
      agentSessionId: session.id as string,
      actorProfileId,
      content: 'Hello?',
    });

    // Before #2995 this threw:
    //   invalid input syntax for type uuid: "anytown_site_assistant" (22P02)
    const reply = await sendAgentReply(chat, {
      tenantId,
      agentSessionId: session.id as string,
      content: 'Hello back.',
    });

    expect(reply.role).toBe('assistant');
    expect(reply.senderProfileId).toBe(session.agentProfileId);

    const rows = await isolated?.db.query(
      `SELECT CAST(sender_profile_id AS VARCHAR) AS sender, role
         FROM chat_messages
        WHERE id = ?`,
      reply.id as string,
    );
    expect(rows?.rows[0]?.sender).toBe(session.agentProfileId);
  });

  it('resolves one stable agent profile per (tenant, agent) and isolates tenants', async () => {
    const first = await chat.createAgentSession({
      tenantId,
      agentId: AGENT_ID,
      actorProfileId,
    });
    const otherTenantId = crypto.randomUUID();
    const profileTypes = await ProfileTypeCollection.create({
      db: isolated?.db,
    });
    const personType = await profileTypes.getOrCreateBySlug('person', {
      name: 'Person',
    });
    const profiles = await ProfileCollection.create({ db: isolated?.db });
    const otherActor = await profiles.create({
      tenantId: otherTenantId,
      typeId: personType.id as string,
      name: 'Other operator',
    });
    await otherActor.save();

    const second = await chat.createAgentSession({
      tenantId,
      agentId: AGENT_ID,
      actorProfileId,
    });
    const otherTenant = await chat.createAgentSession({
      tenantId: otherTenantId,
      agentId: AGENT_ID,
      actorProfileId: otherActor.id as string,
    });

    expect(second.session.agentProfileId).toBe(first.session.agentProfileId);
    expect(otherTenant.session.agentProfileId).toMatch(UUID_RE);
    expect(otherTenant.session.agentProfileId).not.toBe(
      first.session.agentProfileId,
    );
  });

  it('backfills a session created before #2995 on its next agent turn', async () => {
    const { session, room } = await chat.createAgentSession({
      tenantId,
      agentId: AGENT_ID,
      actorProfileId,
    });
    const agentProfileId = session.agentProfileId as string;

    // Simulate a pre-#2995 row: no resolved agent profile, and no participant
    // row for it (the old code enrolled the slug, which this column cannot
    // even hold on PostgreSQL).
    await isolated?.db.query(
      'UPDATE agent_sessions SET agent_profile_id = NULL WHERE id = ?',
      session.id as string,
    );
    await isolated?.db.query(
      'DELETE FROM chat_participants WHERE room_id = ? AND profile_id = ?',
      room.id as string,
      agentProfileId,
    );

    const reply = await sendAgentReply(chat, {
      tenantId,
      agentSessionId: session.id as string,
      content: 'Still here.',
    });

    expect(reply.senderProfileId).toBe(agentProfileId);

    const rows = await isolated?.db.query(
      `SELECT CAST(agent_profile_id AS VARCHAR) AS agent_profile_id
         FROM agent_sessions WHERE id = ?`,
      session.id as string,
    );
    expect(rows?.rows[0]?.agent_profile_id).toBe(agentProfileId);
  });
});
