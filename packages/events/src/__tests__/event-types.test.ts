/**
 * EventType model + EventTypeCollection integration tests.
 *
 * Exercises the real create -> save -> query flow against a temp-file (file:tmpdir)
 * SQLite database (no mocks). Covers JSON schema helpers, slug-based
 * lookup/get-or-create, default seeding, and tenant scoping.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventType, EventTypeCollection } from '../index.js';

function getTestDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

async function makeTypes(name: string) {
  const dbUrl = getTestDbUrl(name);
  const types = await EventTypeCollection.create({
    db: { type: 'sqlite', url: dbUrl },
  });
  return { dbUrl, types };
}

describe('EventType model', () => {
  it('persists name, description, and round-trips schema JSON', async () => {
    const { types } = await makeTypes('eventtype-persist');

    const type = await types.create({
      name: 'Basketball Game',
      slug: 'basketball-game',
      description: 'A regulation basketball game',
      schema: { properties: { quarters: { type: 'number' } } },
    });
    await type.save();

    const loaded = await types.get({ id: type.id });
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe('Basketball Game');
    expect(loaded?.description).toBe('A regulation basketball game');
    expect(loaded?.getSchema()).toEqual({
      properties: { quarters: { type: 'number' } },
    });
  });

  it('accepts schema supplied as a JSON string and parses it back', async () => {
    const { types } = await makeTypes('eventtype-schema-string');

    const type = await types.create({
      name: 'Concert',
      slug: 'concert',
      schema: '{"setlist":true}',
      participantSchema: '{"instrument":"string"}',
    });
    await type.save();

    expect(type.getSchema()).toEqual({ setlist: true });
    expect(type.getParticipantSchema()).toEqual({ instrument: 'string' });
  });

  it('returns empty objects for missing or malformed schema JSON', async () => {
    const type = new EventType({ name: 'Empty' });
    expect(type.getSchema()).toEqual({});
    expect(type.getParticipantSchema()).toEqual({});

    type.schema = 'not-valid-json{';
    type.participantSchema = 'also-broken';
    expect(type.getSchema()).toEqual({});
    expect(type.getParticipantSchema()).toEqual({});
  });

  it('mutates schema and participant schema via setters', async () => {
    const { types } = await makeTypes('eventtype-setters');

    const type = await types.create({ name: 'Conference', slug: 'conference' });
    type.setSchema({ tracks: 3 });
    type.setParticipantSchema({ badge: 'required' });
    await type.save();

    const loaded = await types.get({ id: type.id });
    expect(loaded?.getSchema()).toEqual({ tracks: 3 });
    expect(loaded?.getParticipantSchema()).toEqual({ badge: 'required' });
  });
});

describe('EventTypeCollection', () => {
  it('getOrCreate creates a new type and auto-generates a display name', async () => {
    const { types } = await makeTypes('eventtype-getorcreate');

    const created = await types.getOrCreate('town-hall');
    expect(created.slug).toBe('town-hall');
    // Slug 'town-hall' -> 'Town Hall'
    expect(created.name).toBe('Town Hall');
  });

  it('getOrCreate returns the existing type on a second call', async () => {
    const { types } = await makeTypes('eventtype-getorcreate-existing');

    const first = await types.getOrCreate('meeting', 'Council Meeting');
    const second = await types.getOrCreate('meeting', 'Ignored Name');

    expect(second.id).toBe(first.id);
    expect(second.name).toBe('Council Meeting');
  });

  it('getBySlug finds a saved type and returns null for unknown slugs', async () => {
    const { types } = await makeTypes('eventtype-getbyslug');

    const created = await types.getOrCreate('keynote', 'Keynote');
    const found = await types.getBySlug('keynote');
    expect(found?.id).toBe(created.id);

    const missing = await types.getBySlug('does-not-exist');
    expect(missing).toBeNull();
  });

  it('initializeDefaults seeds the full default catalogue idempotently', async () => {
    const { types } = await makeTypes('eventtype-defaults');

    const seeded = await types.initializeDefaults();
    expect(seeded.length).toBeGreaterThan(20);
    expect(seeded.map((t) => t.slug)).toContain('game');
    expect(seeded.map((t) => t.slug)).toContain('vote');

    const all = await types.list({});
    const firstCount = all.length;

    // Re-seeding must not duplicate existing slugs.
    await types.initializeDefaults();
    const allAgain = await types.list({});
    expect(allAgain.length).toBe(firstCount);
  });

  it('scopes types by tenant and resolves globals with findWithGlobals', async () => {
    const { types } = await makeTypes('eventtype-tenant');

    const tenantType = await types.create({
      name: 'Tenant Game',
      slug: 'tenant-game',
      tenantId: 'tenant-a',
    });
    await tenantType.save();

    const globalType = await types.create({
      name: 'Global Game',
      slug: 'global-game',
      tenantId: null,
    });
    await globalType.save();

    const byTenant = await types.findByTenant('tenant-a');
    expect(byTenant.map((t) => t.id)).toContain(tenantType.id);
    expect(byTenant.map((t) => t.id)).not.toContain(globalType.id);

    const globals = await types.findGlobal();
    expect(globals.map((t) => t.id)).toContain(globalType.id);

    const withGlobals = await types.findWithGlobals('tenant-a');
    const ids = withGlobals.map((t) => t.id);
    expect(ids).toContain(tenantType.id);
    expect(ids).toContain(globalType.id);
  });
});
