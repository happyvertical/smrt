/**
 * Magic Link Service
 *
 * Handles the magic link authentication flow including:
 * - Token generation and storage
 * - Email sending (via callback)
 * - Token verification
 * - Rate limiting checks
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { MagicLinkTokenCollection } from '../collections/MagicLinkTokenCollection';
import { NostrIdentityCollection } from '../collections/NostrIdentityCollection';
import { MagicLinkToken } from '../models/MagicLinkToken';
import type { NostrIdentity } from '../models/NostrIdentity';
import type { Profile } from '../models/Profile';
import { encryptPrivkey, generateNostrKeypair } from './nostrCrypto';

export interface MagicLinkConfig {
  /** Base URL for magic links (e.g., "https://example.com") */
  baseUrl: string;
  /** Path for verification endpoint (default: "/auth/verify") */
  verifyPath?: string;
  /** Token expiration in minutes (default: 15) */
  expiresInMinutes?: number;
  /** Maximum tokens per email per hour (default: 5) */
  maxTokensPerEmailPerHour?: number;
  /** Maximum tokens per IP per hour (default: 10) */
  maxTokensPerIpPerHour?: number;
  /** Server master secret for encryption */
  masterSecret: string;
  /** Callback to send the email */
  sendEmail: (to: string, magicLink: string) => Promise<void>;
  /** Database options */
  db: SmrtObjectOptions['db'];
}

export interface InitiateResult {
  success: boolean;
  /** The Nostr identity (existing or new) */
  nostrIdentity?: NostrIdentity;
  /** The profile (existing or new) */
  profile?: Profile;
  /** True if a new profile was created */
  created: boolean;
  /** Error message if success is false */
  error?: string;
  /** Error code for programmatic handling */
  errorCode?: 'RATE_LIMITED_EMAIL' | 'RATE_LIMITED_IP' | 'EMAIL_SEND_FAILED';
}

export interface VerifyResult {
  success: boolean;
  /** The profile */
  profile?: Profile;
  /** The Nostr identity */
  nostrIdentity?: NostrIdentity;
  /** The decrypted keypair (only on success) */
  keypair?: {
    pubkey: string;
    privkey: string;
    npub: string;
    nsec: string;
  };
  /** Error message if success is false */
  error?: string;
  /** Error code for programmatic handling */
  errorCode?: 'INVALID_TOKEN' | 'EXPIRED_TOKEN' | 'USED_TOKEN' | 'NOT_FOUND';
}

export interface MagicLinkService {
  /**
   * Initiate magic link flow - generates token and sends email
   */
  initiate(
    email: string,
    options?: {
      requestedFromIp?: string;
      nip05Username?: string;
    },
  ): Promise<InitiateResult>;

  /**
   * Verify a magic link token and return decrypted keypair
   */
  verify(token: string): Promise<VerifyResult>;
}

/**
 * Create a magic link service instance
 */
export function createMagicLinkService(
  config: MagicLinkConfig,
): MagicLinkService {
  const {
    baseUrl,
    verifyPath = '/auth/verify',
    expiresInMinutes = 15,
    maxTokensPerEmailPerHour = 5,
    maxTokensPerIpPerHour = 10,
    masterSecret,
    sendEmail,
    db,
  } = config;

  return {
    async initiate(
      email: string,
      options: {
        requestedFromIp?: string;
        nip05Username?: string;
      } = {},
    ): Promise<InitiateResult> {
      const normalizedEmail = email.toLowerCase().trim();
      const { requestedFromIp, nip05Username } = options;

      // Create collections
      const identityCollection = await NostrIdentityCollection.create({ db });
      const tokenCollection = await MagicLinkTokenCollection.create({ db });

      // Rate limiting checks
      if (
        await tokenCollection.isRateLimitedByEmail(
          normalizedEmail,
          maxTokensPerEmailPerHour,
        )
      ) {
        return {
          success: false,
          created: false,
          error: 'Too many requests for this email. Please try again later.',
          errorCode: 'RATE_LIMITED_EMAIL',
        };
      }

      if (
        requestedFromIp &&
        (await tokenCollection.isRateLimitedByIp(
          requestedFromIp,
          maxTokensPerIpPerHour,
        ))
      ) {
        return {
          success: false,
          created: false,
          error: 'Too many requests from this IP. Please try again later.',
          errorCode: 'RATE_LIMITED_IP',
        };
      }

      // Check if identity exists
      let nostrIdentity = await identityCollection.findByEmail(normalizedEmail);
      let profile: Profile | null = null;
      let created = false;

      if (!nostrIdentity) {
        // Create new identity and profile
        const { Person } = await import('../models/ProfileTypes');
        const { ProfileTypeCollection } = await import(
          '../collections/ProfileTypeCollection'
        );

        // Profile.typeId is a required FK, so resolve (or seed) the canonical
        // 'person' type before creating the profile — otherwise `.save()`
        // fails required-field validation. Mirrors createProfileFromNostr /
        // createProfileFromOidc in resolveIdentity.ts.
        const typeCollection = await ProfileTypeCollection.create({ db });
        let personType = await typeCollection.getBySlug('person');
        if (!personType) {
          const { ProfileType } = await import('../models/ProfileType');
          personType = new ProfileType({
            db,
            slug: 'person',
            name: 'Person',
            description: 'Individual person profile',
          });
          await personType.initialize();
          await personType.save();
        }

        // Create a new profile for this user (Person is an STI subclass of Profile)
        profile = new Person({
          db,
          typeId: personType.id as string,
          email: normalizedEmail,
          name: normalizedEmail.split('@')[0], // Default name from email
        });
        await profile.initialize();
        await profile.save();

        // Generate keypair and encrypt
        const keypair = generateNostrKeypair();
        const encrypted = encryptPrivkey(keypair.privkey, masterSecret);

        // Create Nostr identity
        const { NostrIdentity: NostrIdentityClass } = await import(
          '../models/NostrIdentity'
        );
        nostrIdentity = new NostrIdentityClass({
          db,
          profileId: profile.id!,
          pubkey: keypair.pubkey,
          encryptedPrivkey: encrypted.ciphertext,
          encryptionIv: encrypted.iv,
          encryptionTag: encrypted.tag,
          email: normalizedEmail,
          nip05Username:
            nip05Username?.toLowerCase() || normalizedEmail.split('@')[0],
        });
        await nostrIdentity.initialize();
        await nostrIdentity.save();

        created = true;
      } else {
        profile = await nostrIdentity.getProfile();
      }

      // Generate magic link token
      const { token } = await MagicLinkToken.generate(
        nostrIdentity,
        normalizedEmail,
        {
          expiresInMinutes,
          requestedFromIp,
          db,
        },
      );

      // Build magic link URL
      const magicLink = `${baseUrl}${verifyPath}?token=${encodeURIComponent(token)}`;

      // Send email
      try {
        await sendEmail(normalizedEmail, magicLink);
      } catch (emailError) {
        return {
          success: false,
          created,
          nostrIdentity,
          profile: profile || undefined,
          error: 'Failed to send email. Please try again.',
          errorCode: 'EMAIL_SEND_FAILED',
        };
      }

      return {
        success: true,
        created,
        nostrIdentity,
        profile: profile || undefined,
      };
    },

    async verify(token: string): Promise<VerifyResult> {
      // Verify token
      const magicLinkToken = await MagicLinkToken.verify(token, { db });

      if (!magicLinkToken) {
        // Try to get more specific error
        const tokenHash = MagicLinkToken.hashToken(token);
        const tokenCollection = await MagicLinkTokenCollection.create({ db });
        const existingToken = await tokenCollection.findByTokenHash(tokenHash);

        if (!existingToken) {
          return {
            success: false,
            error: 'Invalid or expired token.',
            errorCode: 'NOT_FOUND',
          };
        }

        if (existingToken.isUsed()) {
          return {
            success: false,
            error: 'This link has already been used.',
            errorCode: 'USED_TOKEN',
          };
        }

        if (existingToken.isExpired()) {
          return {
            success: false,
            error: 'This link has expired. Please request a new one.',
            errorCode: 'EXPIRED_TOKEN',
          };
        }

        return {
          success: false,
          error: 'Invalid token.',
          errorCode: 'INVALID_TOKEN',
        };
      }

      // Mark token as used
      await magicLinkToken.markUsed();

      // Get the Nostr identity
      const nostrIdentity = await magicLinkToken.getNostrIdentity();
      if (!nostrIdentity) {
        return {
          success: false,
          error: 'Identity not found.',
          errorCode: 'NOT_FOUND',
        };
      }

      // Mark identity as verified
      await nostrIdentity.markVerified();

      // Get profile
      const profile = await nostrIdentity.getProfile();

      // Decrypt keypair
      const keypair = nostrIdentity.getKeypair(masterSecret);

      return {
        success: true,
        profile: profile || undefined,
        nostrIdentity,
        keypair,
      };
    },
  };
}
