/**
 * Per-person passkey (WebAuthn) credentials (#3275).
 *
 * Its own object rather than a column on `User`, like the password and PIN
 * credentials: authentication extends without touching the identity model, the
 * key material is never selected by the many existing user reads, and it is
 * never serialized by accident. Unlike a password, a person may hold SEVERAL
 * passkeys (a laptop, a phone, a security key), so `userId` is not unique;
 * `credentialId` is, because the authenticator names the credential and the
 * discoverable sign-in finds the person from it.
 *
 * Tenant access still comes only from an active Membership, which sign-in
 * checks separately. See {@link PasskeyCredentialService}; that service and its
 * SvelteKit handlers are the only read and write paths.
 *
 * @packageDocumentation
 */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';

/** Whether a credential can be synced between devices (WebAuthn `credentialDeviceType`). */
export type PasskeyDeviceType = 'singleDevice' | 'multiDevice';

/** The transport hints WebAuthn defines; anything else stored is dropped on read. */
const KNOWN_TRANSPORTS: ReadonlySet<string> = new Set([
  'ble',
  'cable',
  'hybrid',
  'internal',
  'nfc',
  'smart-card',
  'usb',
]);

/** The transport hints worth storing, in order; anything unknown is dropped. */
export function knownPasskeyTransports(
  values: readonly unknown[] | null | undefined,
): string[] {
  return (values ?? []).filter(
    (value): value is string =>
      typeof value === 'string' && KNOWN_TRANSPORTS.has(value),
  );
}

@smrt({
  tableName: 'users_passkey_credentials',
  // Credential material. Never in the change feed (#2937), never on an API.
  sensitive: true,
  api: false,
  cli: false,
  mcp: false,
})
export class UsersPasskeyCredential extends SmrtObject {
  /** The person this passkey signs in. A person may hold several. */
  @foreignKey('User', { required: true })
  userId = '';

  /** The authenticator's credential id, base64url. Unique across all people. */
  @field({ type: 'text', required: true, unique: true, sensitive: true })
  credentialId = '';

  /** The credential public key (COSE), base64url. */
  @field({ type: 'text', required: true, sensitive: true })
  publicKey = '';

  /** The authenticator's signature counter at its last accepted assertion. */
  @field({ type: 'integer', required: true, default: 0 })
  signCount = 0;

  /** JSON array of transport hints; use {@link getTransports}. */
  @field({ type: 'text', nullable: true })
  transports: string | null = null;

  /** The name the person gave this passkey ("MacBook", "YubiKey"). */
  @field({ type: 'text', required: true })
  name = '';

  /** The authenticator model's AAGUID, when it reported one. */
  @field({ type: 'text', nullable: true })
  aaguid: string | null = null;

  /** Whether the credential is currently backed up (synced) by its provider. */
  @field({ type: 'boolean', required: true, default: false })
  backedUp = false;

  /** `singleDevice` or `multiDevice`, as reported at registration. */
  @field({ type: 'text', nullable: true })
  deviceType: PasskeyDeviceType | null = null;

  /** When this passkey last signed the person in. */
  @field({ type: 'datetime', nullable: true })
  lastUsedAt: Date | null = null;

  /** `self` (the only value today: a passkey is always registered by its owner). */
  @field({ type: 'text', nullable: true })
  createdBy: string | null = null;

  /** Transport hints, guarded: malformed or unknown entries are dropped. */
  getTransports(): string[] {
    if (!this.transports) return [];
    try {
      const parsed: unknown = JSON.parse(this.transports);
      return Array.isArray(parsed) ? knownPasskeyTransports(parsed) : [];
    } catch {
      return [];
    }
  }

  setTransports(value: readonly string[] | null | undefined): void {
    const known = knownPasskeyTransports(value);
    this.transports = known.length > 0 ? JSON.stringify(known) : null;
  }
}
