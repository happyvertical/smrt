import type { getDatabase } from '@happyvertical/sql';
import { ProfileCollection } from '../collections/ProfileCollection';
import { ProfileTypeCollection } from '../collections/ProfileTypeCollection';
import { OidcIdentity } from '../models/OidcIdentity';
import type { Profile } from '../models/Profile';
import { Person } from '../models/ProfileTypes';
import { saveOidcRaceArbiter } from './oidcProvisioningCoordinator';

type DatabaseInterface = Awaited<ReturnType<typeof getDatabase>>;

export interface OidcProvisioningPersonInput {
  email?: string;
  name?: string;
  preferredUsername?: string;
  subject: string;
}

export interface OidcProvisioningIdentityInput {
  email?: string;
  issuer: string;
  profileId: string;
  provider: string;
  subject: string;
}

/** Create and reserve a fresh global Person inside the caller's transaction. */
export async function createOidcProvisioningPerson(
  db: DatabaseInterface,
  input: OidcProvisioningPersonInput,
): Promise<Profile> {
  const typeCollection = await ProfileTypeCollection.create({ db });
  const personType = await typeCollection.getOrCreateGlobalBySlug('person', {
    name: 'Person',
    description: 'Individual person profile',
  });
  const typeId = requireProvisioningId(personType.id, 'Person ProfileType');
  let profile: Profile = new Person({
    db,
    // OIDC display names are not identity keys. A per-profile slug keeps
    // SMRT's natural-key upsert from replacing an unrelated Person.
    slug: `oidc-${crypto.randomUUID()}`,
    tenantId: null,
    typeId,
    email: input.email ?? '',
    name: input.name || input.preferredUsername || input.subject,
  });
  await profile.initialize();
  await saveOidcRaceArbiter(() => profile.save());

  if (input.email) {
    const profiles = await ProfileCollection.create({ db });
    profile = await profiles.reserveCanonicalIdentityEmail(
      requireProvisioningId(profile.id, 'Created Profile'),
      input.email,
    );
  }
  return profile;
}

/** Insert the identity after the caller proves Profile ownership. */
export async function insertOidcProvisioningIdentity(
  db: DatabaseInterface,
  input: OidcProvisioningIdentityInput,
): Promise<OidcIdentity> {
  const identity = new OidcIdentity({
    db,
    email: input.email ?? '',
    issuer: input.issuer,
    profileId: input.profileId,
    provider: input.provider,
    subject: input.subject,
  });
  await identity.initialize();
  await saveOidcRaceArbiter(() => identity.save());
  return identity;
}

function requireProvisioningId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${label} did not produce an id.`);
  }
  return value;
}
