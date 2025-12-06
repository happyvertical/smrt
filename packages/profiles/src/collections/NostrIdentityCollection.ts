/**
 * NostrIdentityCollection - Collection for managing Nostr identity records
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { encryptPrivkey, generateNostrKeypair } from '../auth/nostrCrypto';
import { NostrIdentity } from '../models/NostrIdentity';
import type { Profile } from '../models/Profile';

export interface Nip05Response {
  names: Record<string, string>;
  relays?: Record<string, string[]>;
}

export class NostrIdentityCollection extends SmrtCollection<NostrIdentity> {
  static readonly _itemClass = NostrIdentity;

  /**
   * Find identities for a profile
   */
  async findByProfile(profileId: string): Promise<NostrIdentity[]> {
    return await this.list({
      where: { profileId },
    });
  }

  /**
   * Find identity by public key
   */
  async findByPubkey(pubkey: string): Promise<NostrIdentity | null> {
    return await this.findOne({
      where: { pubkey },
    });
  }

  /**
   * Find identity by email
   */
  async findByEmail(email: string): Promise<NostrIdentity | null> {
    return await this.findOne({
      where: { email: email.toLowerCase() },
    });
  }

  /**
   * Find identity by NIP-05 username
   */
  async findByNip05(username: string): Promise<NostrIdentity | null> {
    return await this.findOne({
      where: { nip05Username: username.toLowerCase() },
    });
  }

  /**
   * Link a new Nostr identity to a profile with a new keypair
   * @param profile - The profile to link to
   * @param email - Email address for this identity
   * @param masterSecret - Server master secret for encryption
   * @param nip05Username - Optional NIP-05 username (defaults to email local part)
   */
  async createForProfile(
    profile: Profile,
    email: string,
    masterSecret: string,
    nip05Username?: string,
  ): Promise<NostrIdentity> {
    const normalizedEmail = email.toLowerCase();

    // Check if already exists for this email
    const existing = await this.findByEmail(normalizedEmail);
    if (existing) {
      throw new Error(`Nostr identity already exists for email: ${email}`);
    }

    // Generate new keypair
    const keypair = generateNostrKeypair();

    // Encrypt private key
    const encrypted = encryptPrivkey(keypair.privkey, masterSecret);

    // Derive NIP-05 username from email if not provided
    const username =
      nip05Username?.toLowerCase() || normalizedEmail.split('@')[0];

    // Create identity
    const identity = new NostrIdentity({
      ...this.options,
      profileId: profile.id as string,
      pubkey: keypair.pubkey,
      encryptedPrivkey: encrypted.ciphertext,
      encryptionIv: encrypted.iv,
      encryptionTag: encrypted.tag,
      email: normalizedEmail,
      nip05Username: username,
    });

    await identity.initialize();
    await identity.save();

    return identity;
  }

  /**
   * Link an existing Nostr identity (with encrypted keypair) to a profile
   */
  async linkToProfile(
    profile: Profile,
    nostrData: {
      pubkey: string;
      encryptedPrivkey: string;
      encryptionIv: string;
      encryptionTag: string;
      email: string;
      nip05Username?: string;
    },
  ): Promise<NostrIdentity> {
    // Check if pubkey already exists
    const existingPubkey = await this.findByPubkey(nostrData.pubkey);
    if (existingPubkey) {
      throw new Error('Nostr identity with this public key already exists');
    }

    // Check if email already exists
    const existingEmail = await this.findByEmail(nostrData.email);
    if (existingEmail) {
      throw new Error('Nostr identity with this email already exists');
    }

    const identity = new NostrIdentity({
      ...this.options,
      profileId: profile.id as string,
      pubkey: nostrData.pubkey,
      encryptedPrivkey: nostrData.encryptedPrivkey,
      encryptionIv: nostrData.encryptionIv,
      encryptionTag: nostrData.encryptionTag,
      email: nostrData.email.toLowerCase(),
      nip05Username:
        nostrData.nip05Username?.toLowerCase() ||
        nostrData.email.toLowerCase().split('@')[0],
    });

    await identity.initialize();
    await identity.save();

    return identity;
  }

  /**
   * Unlink a Nostr identity from a profile
   */
  async unlinkFromProfile(profileId: string, pubkey: string): Promise<boolean> {
    const identity = await this.findOne({
      where: { profileId, pubkey },
    });

    if (identity) {
      await identity.delete();
      return true;
    }
    return false;
  }

  /**
   * Get NIP-05 response data for the /.well-known/nostr.json endpoint
   * @param username - Optional username filter, returns all if not provided
   */
  async getNip05Response(username?: string): Promise<Nip05Response> {
    const where = username ? { nip05Username: username.toLowerCase() } : {};

    const identities = await this.list({
      where,
      // Only return verified identities for NIP-05
      // Uncomment if you want to require verification:
      // where: { ...where, 'verifiedAt IS NOT': null },
    });

    const names: Record<string, string> = {};
    for (const identity of identities) {
      if (identity.nip05Username && identity.pubkey) {
        names[identity.nip05Username] = identity.pubkey;
      }
    }

    return { names };
  }

  /**
   * Check if a NIP-05 username is available
   */
  async isNip05Available(username: string): Promise<boolean> {
    const existing = await this.findByNip05(username);
    return existing === null;
  }

  /**
   * Update NIP-05 username for an identity
   */
  async updateNip05Username(
    identity: NostrIdentity,
    newUsername: string,
  ): Promise<NostrIdentity> {
    const normalizedUsername = newUsername.toLowerCase();

    // Check if username is available
    const existing = await this.findByNip05(normalizedUsername);
    if (existing && existing.id !== identity.id) {
      throw new Error(`NIP-05 username "${newUsername}" is already taken`);
    }

    identity.nip05Username = normalizedUsername;
    await identity.save();

    return identity;
  }
}
