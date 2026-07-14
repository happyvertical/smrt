import type { getDatabase } from '@happyvertical/sql';

export {
  coordinateOidcProvisioning,
  isOidcAbortedTransactionError,
  isOidcProvisioningRaceConflict,
  type OidcProvisioningCoordinatorOptions,
  type OidcProvisioningRaceClassifierOptions,
  saveOidcRaceArbiter,
} from '../auth/oidcProvisioningCoordinator.js';

import {
  createOidcProvisioningPerson as createPerson,
  insertOidcProvisioningIdentity as insertIdentity,
  type OidcProvisioningIdentityInput,
  type OidcProvisioningPersonInput,
} from '../auth/oidcProvisioningPrimitives';

type DatabaseInterface = Awaited<ReturnType<typeof getDatabase>>;

export type { OidcProvisioningIdentityInput, OidcProvisioningPersonInput };

/**
 * Trusted integration surface for framework packages participating in the
 * owner-aware OIDC provisioning transaction.
 *
 * Application code should use UserCollection.getOrCreateFromOidc() instead.
 * The generic result avoids duplicating nominal SMRT model declarations across
 * package entry bundles; trusted callers bind it to the root package model.
 */
export async function createOidcProvisioningPerson<TProfile>(
  db: DatabaseInterface,
  input: OidcProvisioningPersonInput,
): Promise<TProfile> {
  return (await createPerson(db, input)) as TProfile;
}

/** Trusted integration insert after the caller proves Profile ownership. */
export async function insertOidcProvisioningIdentity<TIdentity>(
  db: DatabaseInterface,
  input: OidcProvisioningIdentityInput,
): Promise<TIdentity> {
  return (await insertIdentity(db, input)) as TIdentity;
}
