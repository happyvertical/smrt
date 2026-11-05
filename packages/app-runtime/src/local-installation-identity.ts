import { createHmac } from 'node:crypto';

function installationUuid(key: Buffer, purpose: string): string {
  const bytes = createHmac('sha256', key)
    .update(`smrt/local-installation/v1/${purpose}`)
    .digest();
  // RFC 9562 UUIDv8 with the RFC variant.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex', 0, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Derive public identifiers from the existing private installation seed. */
export function deriveLocalInstallationIdentity(applicationSecret: string) {
  const key = Buffer.from(applicationSecret.trim(), 'base64url');
  return {
    deviceId: installationUuid(key, 'device'),
    tenantId: installationUuid(key, 'default-tenant'),
    ownerId: installationUuid(key, 'owner'),
    profileId: installationUuid(key, 'owner-profile'),
    membershipId: installationUuid(key, 'owner-membership'),
  };
}

export type LocalInstallationIdentity = ReturnType<
  typeof deriveLocalInstallationIdentity
>;
