/** Shared canonical global mailbox ownership policy; caller supplies transaction. */
import { randomUUID } from 'node:crypto';
import {
  isPostgresDatabase,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import {
  normalizeIdentityEmail,
  Person,
  ProfileCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import type { DatabaseInterface } from '@happyvertical/sql';
import { UserCollection } from '../collections/UserCollection.js';
import { UserStatus } from '../types/index.js';

/** Never adopts a matching unowned Profile or revives an unavailable User. */
export async function provisionCanonicalMailboxIdentity(
  options: SmrtClassOptions,
  input: {
    email: string;
    status: UserStatus.ACTIVE | UserStatus.PENDING;
    allowPending: boolean;
    lock?: boolean;
    refuse: (message: string) => Error;
  },
) {
  const email = normalizeIdentityEmail(input.email);
  const users = await UserCollection.create(options);
  const profiles = await ProfileCollection.create(options);
  let user = await users.findCanonicalByEmail(email);
  if (
    user?.id &&
    input.lock &&
    isPostgresDatabase(options.db as DatabaseInterface)
  ) {
    await (options.db as DatabaseInterface).query(
      'SELECT id FROM users WHERE id = ? FOR UPDATE',
      user.id,
    );
    user = await users.get({ id: user.id }, { cache: false });
    if (!user || normalizeIdentityEmail(user.email) !== email)
      throw input.refuse('Identity is unavailable');
  }
  let profileId: string;
  if (user) {
    if (
      user.status !== UserStatus.ACTIVE &&
      !(input.allowPending && user.status === UserStatus.PENDING)
    )
      throw input.refuse('Invitation user is unavailable');
    const profile = await profiles.requireCanonicalGlobalPerson(
      user.profileId,
      email,
    );
    profileId = requiredId(profile.id);
    const owners = await users.list({ where: { profileId }, limit: 2 });
    if (owners.length !== 1 || owners[0].id !== user.id)
      throw input.refuse('Invitation identity ownership is inconsistent');
  } else {
    // Matching unowned Profile email is not proof of ownership.
    if (await profiles.findUniqueGlobalPersonByEmail(email))
      throw input.refuse(
        'Invitation email requires explicit identity reconciliation',
      );
    const types = await ProfileTypeCollection.create(options);
    const personType = await types.getOrCreateGlobalBySlug('person', {
      name: 'Person',
      description: 'Individual person profile',
    });
    const person = new Person({
      ...options,
      tenantId: null,
      typeId: requiredId(personType.id),
      slug: `mailbox-${randomUUID()}`,
      name: email,
      email,
    });
    await person.initialize();
    await person.save();
    profileId = requiredId(person.id);
    await profiles.reserveCanonicalIdentityEmail(profileId, email);
    user = await users.create({ email, profileId, status: input.status });
  }
  return { user, profileId };
}
function requiredId(id: unknown): string {
  if (typeof id !== 'string' || !id)
    throw new Error('Canonical identity record has no id');
  return id;
}
