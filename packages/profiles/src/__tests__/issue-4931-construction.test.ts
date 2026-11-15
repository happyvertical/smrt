import { SmrtObject } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snapshotObjectRegistryState } from '../../../core/src/test-utils.js';
import { createAuditWriter } from '../audit-trail.js';
import { createMagicLinkService } from '../auth/magicLinkService.js';
import {
  createOidcProvisioningPerson,
  insertOidcProvisioningIdentity,
} from '../auth/oidcProvisioningPrimitives.js';
import { createProfileFromNostr } from '../auth/resolveIdentity.js';
import { AuditLogCollection } from '../collections/AuditLogCollection.js';
import { MagicLinkTokenCollection } from '../collections/MagicLinkTokenCollection.js';
import { NostrIdentityCollection } from '../collections/NostrIdentityCollection.js';
import { OidcProfileEmailReservationCollection } from '../collections/OidcProfileEmailReservationCollection.js';
import { ProfileCollection } from '../collections/ProfileCollection.js';
import { ProfileTypeCollection } from '../collections/ProfileTypeCollection.js';
import { ApiKey } from '../models/ApiKey.js';
import { AuditLog } from '../models/AuditLog.js';
import { MagicLinkToken } from '../models/MagicLinkToken.js';
import { NostrIdentity } from '../models/NostrIdentity.js';
import { OidcIdentity } from '../models/OidcIdentity.js';
import { OidcProfileEmailReservation } from '../models/OidcProfileEmailReservation.js';
import type { Profile } from '../models/Profile.js';
import { ProfileType } from '../models/ProfileType.js';
import { Person } from '../models/ProfileTypes.js';

const models = {
  ProfileType,
  ApiKey,
  AuditLog,
  MagicLinkToken,
  NostrIdentity,
  OidcIdentity,
  OidcProfileEmailReservation,
  Person,
};
const db = { url: 'sqlite://issue-4931-transaction', query: vi.fn() } as never;
const actor = { id: 'actor', options: { db } } as Profile;
const nostrData = {
  pubkey: 'public',
  encryptedPrivkey: 'encrypted',
  encryptionIv: 'iv',
  encryptionTag: 'tag',
};

describe.each([false, true])('#4931 profiles app replacement=%s', (replace) => {
  let restore: () => void;
  let expected: typeof models;
  const initialized: SmrtObject[] = [];
  const saved: SmrtObject[] = [];

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    expected = replace
      ? (await import('./issue-4931-app.fixture.js')).registerAppModels()
      : models;
    initialized.length = 0;
    saved.length = 0;
    vi.spyOn(SmrtObject.prototype, 'initialize').mockImplementation(
      async function () {
        initialized.push(this);
        return this;
      },
    );
    vi.spyOn(SmrtObject.prototype, 'save').mockImplementation(
      async function () {
        this.id ||= crypto.randomUUID();
        saved.push(this);
        return this;
      },
    );
    vi.spyOn(ProfileTypeCollection, 'create').mockResolvedValue({
      getBySlug: async () => ({ id: 'person-type' }),
      getOrCreateGlobalBySlug: async () => ({ id: 'person-type' }),
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restore();
  });

  function assertCreated(model: keyof typeof models, count = 1) {
    const objects = initialized.filter((item) => item instanceof models[model]);
    expect(objects).toHaveLength(count);
    for (const object of objects) {
      expect(object.constructor).toBe(expected[model]);
      expect(object.options.db).toBe(db);
      expect(saved.filter((item) => item === object)).toHaveLength(1);
    }
    return objects[0];
  }

  it('audit writer creates an effective AuditLog on the supplied executor', async () => {
    await createAuditWriter()(
      {
        actorId: 'actor',
        action: 'created',
        resourceType: 'Record',
        resourceId: 'record',
      } as never,
      db,
    );
    assertCreated('AuditLog');
  });

  it('AuditLog.record creates the effective AuditLog', async () => {
    const result = await AuditLog.record({
      db,
      profile: actor,
      action: 'created',
      resourceType: 'Record',
      resourceId: 'record',
    });
    expect(result).toBe(assertCreated('AuditLog'));
  });

  it('AuditLogCollection.record creates the effective AuditLog once', async () => {
    const logs = new AuditLogCollection({ db });
    vi.spyOn(logs, 'db', 'get').mockReturnValue(db);
    const result = await logs.record({
      profile: actor,
      action: 'created',
      resourceType: 'Record',
      resourceId: 'record',
    });
    expect(result).toBe(assertCreated('AuditLog'));
  });

  it('ApiKey.generate keeps pre-initialize key material on the effective ApiKey', async () => {
    const result = await ApiKey.generate(actor, { db, name: 'test' });
    expect(result.apiKey).toBe(assertCreated('ApiKey'));
    expect(result.apiKey.keyHash).toBe(ApiKey.hashKey(result.key));
    expect(result.apiKey.keyPrefix).toBe(result.key.slice(0, 16));
  });

  it('MagicLinkToken.generate creates the effective token', async () => {
    const result = await MagicLinkToken.generate(
      { id: 'identity', options: { db } } as NostrIdentity,
      'OWNER@example.com',
      { db },
    );
    expect(result.magicLinkToken).toBe(assertCreated('MagicLinkToken'));
  });

  it('OIDC person provisioning creates the effective Person in the caller transaction', async () => {
    const person = await createOidcProvisioningPerson(db, {
      subject: 'subject',
    });
    expect(person).toBe(assertCreated('Person'));
  });

  it('OIDC identity insertion creates the effective OidcIdentity', async () => {
    const identity = await insertOidcProvisioningIdentity(db, {
      issuer: 'issuer',
      subject: 'subject',
      profileId: 'actor',
      provider: 'oidc',
    });
    expect(identity).toBe(assertCreated('OidcIdentity'));
  });

  it('Nostr provisioning creates both the effective Person and NostrIdentity', async () => {
    vi.spyOn(NostrIdentity, 'findByEmail').mockResolvedValue(null);
    const result = await createProfileFromNostr(
      'owner@example.com',
      nostrData,
      { db },
    );
    expect(result.profile).toBe(assertCreated('Person'));
    expect(result.nostrIdentity).toBe(assertCreated('NostrIdentity'));
  });

  it('Nostr provisioning seeds the effective ProfileType when absent', async () => {
    vi.spyOn(NostrIdentity, 'findByEmail').mockResolvedValue(null);
    vi.mocked(ProfileTypeCollection.create).mockResolvedValue({
      getBySlug: async () => null,
    } as never);
    await createProfileFromNostr('owner@example.com', nostrData, { db });
    assertCreated('ProfileType');
  });

  it('magic-link initiation creates the effective ProfileType, Person and NostrIdentity', async () => {
    vi.mocked(ProfileTypeCollection.create).mockResolvedValue({
      getBySlug: async () => null,
    } as never);
    vi.spyOn(NostrIdentityCollection, 'create').mockResolvedValue({
      findByEmail: async () => null,
    } as never);
    vi.spyOn(MagicLinkTokenCollection, 'create').mockResolvedValue({
      isRateLimitedByEmail: async () => false,
    } as never);
    const service = createMagicLinkService({
      db,
      baseUrl: 'https://example.com',
      masterSecret: 'test-master-secret',
      sendEmail: async () => {},
    });
    const result = await service.initiate('owner@example.com');
    expect(result.success).toBe(true);
    expect(result.profile).toBe(assertCreated('Person'));
    expect(result.nostrIdentity).toBe(assertCreated('NostrIdentity'));
    assertCreated('ProfileType');
  });

  it('NostrIdentityCollection.createForProfile creates the effective identity once', async () => {
    const collection = new NostrIdentityCollection({ db });
    vi.spyOn(collection, 'db', 'get').mockReturnValue(db);
    vi.spyOn(collection, 'findByEmail').mockResolvedValue(null);
    const identity = await collection.createForProfile(
      actor,
      'owner@example.com',
      'test-master-secret',
    );
    expect(identity).toBe(assertCreated('NostrIdentity'));
  });

  it('NostrIdentityCollection.linkToProfile creates the effective identity once', async () => {
    const collection = new NostrIdentityCollection({ db });
    vi.spyOn(collection, 'db', 'get').mockReturnValue(db);
    vi.spyOn(collection, 'findByEmail').mockResolvedValue(null);
    vi.spyOn(collection, 'findByPubkey').mockResolvedValue(null);
    const identity = await collection.linkToProfile(actor, {
      ...nostrData,
      email: 'owner@example.com',
    });
    expect(identity).toBe(assertCreated('NostrIdentity'));
  });

  it('email reservation creates the effective reservation on the same executor', async () => {
    const profiles = new ProfileCollection({ db });
    vi.spyOn(profiles, 'requireCanonicalGlobalPerson').mockResolvedValue({
      email: 'owner@example.com',
    } as Profile);
    vi.spyOn(OidcProfileEmailReservationCollection, 'create').mockResolvedValue(
      { list: async () => [] } as never,
    );
    await profiles.reserveCanonicalIdentityEmail('actor', 'owner@example.com');
    assertCreated('OidcProfileEmailReservation');
  });
});
