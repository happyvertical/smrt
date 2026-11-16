import { SmrtObject } from '@happyvertical/smrt-core';
import { BackfillTracker } from '@happyvertical/smrt-core/migrations';
import {
  Person,
  ProfileCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snapshotObjectRegistryState } from '../../../core/src/test-utils.js';
import { UserCollection } from '../collections/UserCollection.js';
import { backfillLegacyUserProfiles } from '../migrations/backfillLegacyUserProfiles.js';
import { provisionCanonicalMailboxIdentity } from '../services/canonical-mailbox-identity.js';
import { UserStatus } from '../types/index.js';

const email = 'owner@example.com';
const userId = '11111111-1111-4111-8111-111111111111';

describe.each([false, true])('#4931 users app replacement=%s', (replace) => {
  let restore: () => void;
  let expected: typeof Person;
  let person: Person | undefined;
  const tx = { url: 'sqlite://issue-4931-transaction', query: vi.fn() };
  const saved: SmrtObject[] = [];

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    expected = replace
      ? (await import('./issue-4931-app.fixture.js')).registerAppModels().Person
      : Person;
    person = undefined;
    saved.length = 0;
    vi.spyOn(Person.prototype, 'initialize').mockImplementation(
      async function () {
        person = this;
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
      getOrCreateGlobalBySlug: async () => ({ id: 'person-type' }),
    } as never);
    vi.spyOn(ProfileCollection, 'create').mockResolvedValue({
      findUniqueGlobalPersonByEmail: async () => null,
      reserveCanonicalIdentityEmail: async () => person,
    } as never);
    vi.spyOn(UserCollection, 'create').mockResolvedValue({
      findCanonicalByEmail: async () => null,
      create: async (input: object) => ({ id: userId, ...input }),
    } as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    restore();
  });

  function assertPerson() {
    expect(person?.constructor).toBe(expected);
    expect(person?.options.db).toBe(tx);
    expect(saved).toEqual([person]);
  }

  it('canonical mailbox provisioning creates the effective Person on the caller transaction', async () => {
    const result = await provisionCanonicalMailboxIdentity(
      { db: tx as never },
      {
        email,
        status: UserStatus.PENDING,
        allowPending: true,
        refuse: (message) => new Error(message),
      },
    );
    assertPerson();
    expect(result.profileId).toBe(person?.id);
    expect(result.user.profileId).toBe(person?.id);
  });

  it('legacy backfill creates the effective Person on its transaction handle', async () => {
    vi.spyOn(BackfillTracker, 'requireExistingTable').mockReturnValue(
      undefined,
    );
    vi.spyOn(BackfillTracker.prototype, 'isApplied').mockResolvedValue(true);
    vi.spyOn(BackfillTracker.prototype, 'recordApplied').mockResolvedValue(
      undefined,
    );
    tx.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('FROM users')
        ? [{ id: userId, email, email_key: email, profile_id: null }]
        : [],
      rowCount: sql.includes('UPDATE users') ? 1 : 0,
    }));
    const transaction = vi.fn(
      async (work: (bound: typeof tx) => Promise<unknown>) => work(tx),
    );
    await expect(
      backfillLegacyUserProfiles({ transaction } as never),
    ).resolves.toEqual({ created: 1, linked: 1 });
    assertPerson();
    expect(transaction).toHaveBeenCalledOnce();
    expect(
      tx.query.mock.calls.some(([sql]) => sql.includes('UPDATE users')),
    ).toBe(true);
  });
});
