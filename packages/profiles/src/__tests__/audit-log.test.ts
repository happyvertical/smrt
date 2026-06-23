/**
 * Tests for audit logging: the AuditLog model and AuditLogCollection, plus the
 * Profile-level recordAction / getAuditLogs wrappers.
 *
 * Real file-backed SQLite, no DB mocking.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  AuditLogCollection,
  ProfileCollection,
  ProfileTypeCollection,
} from '../index.js';

function getTestDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

async function setup(dbUrl: string) {
  const db = { type: 'sqlite' as const, url: dbUrl };
  const profiles = await ProfileCollection.create({ db });
  const profileTypes = await ProfileTypeCollection.create({ db });

  const type = await profileTypes.create({ name: 'Person' });
  await type.save();

  const actor = await profiles.create({
    typeId: type.id,
    name: 'Actor',
    email: `actor-${randomUUID()}@example.com`,
  });
  await actor.save();

  const principal = await profiles.create({
    typeId: type.id,
    name: 'Principal',
    email: `principal-${randomUUID()}@example.com`,
  });
  await principal.save();

  return { db, profiles, actor, principal };
}

describe('AuditLog model', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('audit-log');
  });

  it('records an entry via the static record() helper', async () => {
    const { db, actor } = await setup(dbUrl);

    const log = await AuditLog.record({
      db,
      profile: actor,
      action: 'issue.update',
      resourceType: 'Issue',
      resourceId: 'issue-1',
      source: 'cli',
      metadata: { runId: 'abc' },
    });

    expect(log.id).toBeDefined();
    expect(log.profileId).toBe(actor.id);
    expect(log.action).toBe('issue.update');
    expect(log.source).toBe('cli');
    expect(log.metadata).toEqual({ runId: 'abc' });
  });

  it('resolves the acting profile', async () => {
    const { db, actor } = await setup(dbUrl);
    const log = await AuditLog.record({
      db,
      profile: actor,
      action: 'a',
      resourceType: 'R',
      resourceId: '1',
    });

    const resolved = await log.getProfile();
    expect(resolved?.id).toBe(actor.id);
  });

  it('resolves on-behalf-of identity and effective actor', async () => {
    const { db, actor, principal } = await setup(dbUrl);

    // Pass-through identity: CI bot (actor) acting on behalf of principal.
    const passthrough = await AuditLog.record({
      db,
      profile: actor,
      onBehalfOf: principal,
      action: 'ci.run',
      resourceType: 'Workflow',
      resourceId: 'wf-1',
      source: 'ci',
    });

    expect((await passthrough.getOnBehalfOf())?.id).toBe(principal.id);
    // Effective actor is the on-behalf-of profile when present.
    expect((await passthrough.getEffectiveActor())?.id).toBe(principal.id);

    // Without on-behalf-of, the effective actor is the acting profile.
    const direct = await AuditLog.record({
      db,
      profile: actor,
      action: 'direct',
      resourceType: 'X',
      resourceId: '1',
    });
    expect(await direct.getOnBehalfOf()).toBeNull();
    expect((await direct.getEffectiveActor())?.id).toBe(actor.id);
  });
});

describe('AuditLogCollection', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('audit-log-collection');
  });

  it('records and queries logs across the available filters', async () => {
    const { db, actor, principal } = await setup(dbUrl);
    const logs = await AuditLogCollection.create({ db });

    await logs.record({
      profile: actor,
      action: 'issue.create',
      resourceType: 'Issue',
      resourceId: 'issue-1',
      source: 'web',
    });
    await logs.record({
      profile: actor,
      action: 'issue.update',
      resourceType: 'Issue',
      resourceId: 'issue-1',
      source: 'cli',
    });
    await logs.record({
      profile: actor,
      onBehalfOf: principal,
      action: 'deploy',
      resourceType: 'Service',
      resourceId: 'svc-1',
      source: 'ci',
    });

    expect(await logs.findByProfile(actor.id as string)).toHaveLength(3);
    expect(
      await logs.findByResource('Issue', 'issue-1'),
    ).toHaveLength(2);
    expect(await logs.findByAction('issue.update')).toHaveLength(1);
    expect(await logs.findBySource('ci')).toHaveLength(1);
    expect(await logs.findOnBehalfOf(principal.id as string)).toHaveLength(1);
  });

  it('defaults the source to web and metadata to an empty object', async () => {
    const { db, actor } = await setup(dbUrl);
    const logs = await AuditLogCollection.create({ db });

    const log = await logs.record({
      profile: actor,
      action: 'noop',
      resourceType: 'X',
      resourceId: '1',
    });

    expect(log.source).toBe('web');
    expect(log.metadata).toEqual({});
  });

  it('returns recent activity and resource timelines', async () => {
    const { db, actor } = await setup(dbUrl);
    const logs = await AuditLogCollection.create({ db });

    for (let i = 0; i < 3; i++) {
      await logs.record({
        profile: actor,
        action: `act.${i}`,
        resourceType: 'Doc',
        resourceId: 'doc-1',
      });
    }

    const recent = await logs.getRecentActivity(actor.id as string, 2);
    expect(recent).toHaveLength(2);

    const timeline = await logs.getResourceTimeline('Doc', 'doc-1');
    expect(timeline).toHaveLength(3);
  });
});

describe('Profile audit helpers', () => {
  let dbUrl: string;

  beforeEach(() => {
    dbUrl = getTestDbUrl('profile-audit');
  });

  it('records and reads audit logs through the profile model', async () => {
    const { actor } = await setup(dbUrl);

    await actor.recordAction({
      action: 'login',
      resourceType: 'Session',
      resourceId: 'sess-1',
      source: 'web',
    });

    const recent = await actor.getAuditLogs(10);
    expect(recent).toHaveLength(1);
    expect(recent[0].action).toBe('login');
  });
});
