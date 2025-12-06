/**
 * NostrIdentity - Links Nostr identity to Profile
 *
 * Stores the Nostr keypair with encrypted private key for custodial auth.
 * The private key is encrypted using AES-256-GCM with the SERVER_MASTER_SECRET.
 * The public key serves as the unique identifier for NIP-05 verification.
 */

import {
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import {
  decryptPrivkey,
  type EncryptedKey,
  privkeyToNsec,
  pubkeyToNpub,
} from '../auth/nostrCrypto';
import type { Profile } from './Profile';

export interface NostrIdentityOptions extends SmrtObjectOptions {
  profileId?: string;
  pubkey?: string;
  encryptedPrivkey?: string;
  encryptionIv?: string;
  encryptionTag?: string;
  email?: string;
  nip05Username?: string;
  lastUsedAt?: Date | null;
  verifiedAt?: Date | null;
}

@smrt({
  tableName: 'nostr_identities',
  api: { include: ['list', 'get'] }, // No create/update via API - only internal
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class NostrIdentity extends SmrtObject {
  /**
   * Link to the Profile (Person, Organization, Bot)
   */
  @foreignKey('Profile', { required: true })
  profileId?: string;

  /**
   * Hex-encoded secp256k1 public key (64 characters)
   */
  pubkey: string = '';

  /**
   * AES-256-GCM encrypted private key (base64-encoded ciphertext)
   */
  encryptedPrivkey: string = '';

  /**
   * Initialization vector for AES-GCM decryption (base64)
   */
  encryptionIv: string = '';

  /**
   * Authentication tag from AES-GCM (base64)
   */
  encryptionTag: string = '';

  /**
   * Email address associated with this identity
   */
  email: string = '';

  /**
   * Username for NIP-05 verification (e.g., "alice" for alice@domain.com)
   */
  nip05Username: string = '';

  /**
   * Last time this identity was used for authentication
   */
  lastUsedAt: Date | null = null;

  /**
   * When this identity was verified via magic link
   */
  verifiedAt: Date | null = null;

  constructor(options: NostrIdentityOptions = {}) {
    super(options);
    if (options.profileId) this.profileId = options.profileId;
    if (options.pubkey) this.pubkey = options.pubkey;
    if (options.encryptedPrivkey)
      this.encryptedPrivkey = options.encryptedPrivkey;
    if (options.encryptionIv) this.encryptionIv = options.encryptionIv;
    if (options.encryptionTag) this.encryptionTag = options.encryptionTag;
    if (options.email) this.email = options.email;
    if (options.nip05Username) this.nip05Username = options.nip05Username;
    if (options.lastUsedAt !== undefined) this.lastUsedAt = options.lastUsedAt;
    if (options.verifiedAt !== undefined) this.verifiedAt = options.verifiedAt;
  }

  /**
   * Get the linked Profile
   */
  async getProfile(): Promise<Profile | null> {
    return (await this.getRelated('profileId')) as Profile | null;
  }

  /**
   * Find identity by public key
   */
  static async findByPubkey(
    pubkey: string,
    options: SmrtObjectOptions = {},
  ): Promise<NostrIdentity | null> {
    const { NostrIdentityCollection } = await import(
      '../collections/NostrIdentityCollection'
    );
    const collection = await (NostrIdentityCollection as any).create(options);
    return await collection.findOne({
      where: { pubkey },
    });
  }

  /**
   * Find identity by email
   */
  static async findByEmail(
    email: string,
    options: SmrtObjectOptions = {},
  ): Promise<NostrIdentity | null> {
    const { NostrIdentityCollection } = await import(
      '../collections/NostrIdentityCollection'
    );
    const collection = await (NostrIdentityCollection as any).create(options);
    return await collection.findOne({
      where: { email: email.toLowerCase() },
    });
  }

  /**
   * Find identity by NIP-05 username
   */
  static async findByNip05(
    username: string,
    options: SmrtObjectOptions = {},
  ): Promise<NostrIdentity | null> {
    const { NostrIdentityCollection } = await import(
      '../collections/NostrIdentityCollection'
    );
    const collection = await (NostrIdentityCollection as any).create(options);
    return await collection.findOne({
      where: { nip05Username: username.toLowerCase() },
    });
  }

  /**
   * Decrypt the private key using the server master secret
   * @param masterSecret - SERVER_MASTER_SECRET from environment
   * @returns Hex-encoded private key
   */
  decryptPrivkey(masterSecret: string): string {
    const encrypted: EncryptedKey = {
      ciphertext: this.encryptedPrivkey,
      iv: this.encryptionIv,
      tag: this.encryptionTag,
    };
    return decryptPrivkey(encrypted, masterSecret);
  }

  /**
   * Get the full keypair (requires master secret)
   * @param masterSecret - SERVER_MASTER_SECRET from environment
   */
  getKeypair(masterSecret: string): {
    pubkey: string;
    privkey: string;
    npub: string;
    nsec: string;
  } {
    const privkey = this.decryptPrivkey(masterSecret);
    return {
      pubkey: this.pubkey,
      privkey,
      npub: pubkeyToNpub(this.pubkey),
      nsec: privkeyToNsec(privkey),
    };
  }

  /**
   * Record usage of this identity
   */
  async recordUsage(): Promise<void> {
    this.lastUsedAt = new Date();
    await this.save();
  }

  /**
   * Mark this identity as verified
   */
  async markVerified(): Promise<void> {
    this.verifiedAt = new Date();
    this.lastUsedAt = new Date();
    await this.save();
  }

  /**
   * Check if this identity is verified
   */
  isVerified(): boolean {
    return this.verifiedAt !== null;
  }

  /**
   * Get the NIP-05 identifier (username@domain)
   * Note: Domain must be provided by the application
   */
  getNip05Identifier(domain: string): string {
    const username = this.nip05Username || this.email.split('@')[0];
    return `${username}@${domain}`;
  }
}
