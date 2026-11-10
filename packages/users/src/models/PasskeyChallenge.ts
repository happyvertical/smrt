/**
 * Single-use ledger of CONSUMED passkey ceremony challenges (#3275).
 *
 * A ceremony challenge is issued statelessly (an HMAC-signed `ceremonyId`, so
 * an unauthenticated "begin" request writes nothing). Single use is enforced
 * here instead: when a ceremony is verified its challenge hash is inserted,
 * and the unique `challengeHash` turns a replay into a conflict. Rows are
 * worthless once `expiresAt` has passed (the signed ceremony itself no longer
 * verifies), so the retention sweep reaps them.
 *
 * Only the sha256 of the challenge is stored, never the challenge.
 *
 * @packageDocumentation
 */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

/** No configuration may keep a ceremony open longer than this (10 minutes). */
export const PASSKEY_CHALLENGE_TTL_CEILING_SECONDS = 10 * 60;

/** What a consumed challenge was issued for. */
export type PasskeyChallengePurpose = 'authentication' | 'registration';

@smrt({
  tableName: 'users_passkey_challenges',
  // Replay-protection material. Never in the change feed (#2937).
  sensitive: true,
  api: false,
  cli: false,
  mcp: false,
})
export class UsersPasskeyChallenge extends SmrtObject {
  /** sha256 hex of the consumed challenge (base64url string). Unique. */
  @field({ type: 'text', required: true, unique: true })
  challengeHash = '';

  /** `authentication` or `registration`. */
  @field({ type: 'text', required: true })
  purpose: PasskeyChallengePurpose = 'authentication';

  /**
   * When the ceremony stops verifying anyway.
   *
   * Indexed: the retention sweep prunes by this column.
   */
  @field({ type: 'datetime', required: true, indexed: true })
  expiresAt = new Date();
}
