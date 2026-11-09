/**
 * Identity link between a local installation and a hosted account (#4806).
 *
 * Protocol `smrt-cloud-link-v1` (design and security review on #4668):
 *
 * 1. The operator's CLI authenticates to the hosted application (H) as the
 *    hosted principal P through H's own session auth, then asks H for a
 *    challenge. H takes the account and tenant from P's session, never from
 *    the request, and binds the challenge to that session.
 * 2. The local installation (L) checks the challenge against what it called
 *    and what the operator expects (origin, application, its own link key,
 *    account and tenant), then signs a canonical transcript with its link
 *    key. The link key is derived from the installation seed, so the
 *    signature proves control of the installation; P's session proves control
 *    of the hosted account.
 * 3. H consumes the challenge exactly once, verifies the signature over the
 *    transcript it rebuilds from its own stored fields, and records a durable
 *    link keyed by the link public key. Linking again with the same inputs is
 *    idempotent; linking the same installation to anything else is refused.
 *
 * Both halves live here so the deployed runtime and the CLI share one
 * transcript encoding. The hosted half takes an injected {@link CloudLinkStore}
 * whose challenge consumption and link creation must be atomic; the in-memory
 * store is for tests only.
 */

import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { DEFAULT_ROLES } from '@happyvertical/smrt-users';

/** Protocol and transcript version tag. */
export const CLOUD_LINK_PROTOCOL = 'smrt-cloud-link-v1';
/** Default challenge lifetime. */
export const CLOUD_LINK_CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Longest challenge lifetime either side accepts. */
export const CLOUD_LINK_MAX_CHALLENGE_TTL_MS = 10 * 60 * 1000;
/** Clock skew the local side tolerates on `issuedAt` / `expiresAt`. */
export const CLOUD_LINK_CLOCK_SKEW_MS = 60 * 1000;
/** Outstanding (unconsumed, unexpired) challenges allowed per account. */
export const CLOUD_LINK_MAX_OUTSTANDING_CHALLENGES = 5;

/**
 * HMAC purpose of the link key. It is deliberately outside the
 * `smrt/local-installation/v1/<purpose>` namespace whose outputs are published
 * as UUIDs, so no public identifier can ever reveal private key material.
 */
const LINK_KEY_PURPOSE =
  'smrt/local-installation/v1/private-key/ed25519/cloud-link';
const PROOF_TAG = `${CLOUD_LINK_PROTOCOL}/proof`;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const APP_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const MAX_DISPLAY_LENGTH = 200;

/** Migration target the link is for. */
export type CloudLinkTarget = 'shared' | 'per-user';

/** The four seed-derived local identities, or their hosted counterparts. */
export interface CloudLinkIdentities {
  readonly tenantId: string;
  readonly ownerId: string;
  readonly profileId: string;
  readonly membershipId: string;
}

/** Challenge issued by H and checked, then signed, by L. */
export interface CloudLinkChallenge {
  readonly protocol: typeof CLOUD_LINK_PROTOCOL;
  readonly challengeId: string;
  readonly nonce: string;
  /** H's configured origin; never derived from request headers. */
  readonly origin: string;
  readonly appId: string;
  readonly target: CloudLinkTarget;
  /** Hosted account (user) ID, from P's session. */
  readonly accountId: string;
  /** Hosted tenant ID, from P's session. */
  readonly tenantId: string;
  readonly installationId: string;
  readonly linkPublicKey: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** For display only; never authoritative. */
  readonly display: {
    readonly accountEmail: string;
    readonly tenantName: string;
    readonly tenantOwnerCount: number;
    readonly tenantMemberCount: number;
  };
}

/**
 * The authenticated hosted principal, resolved by H's own session auth. Every
 * field comes from the server session and database, never from the client.
 */
export interface CloudLinkPrincipal {
  readonly sessionId: string;
  readonly accountId: string;
  readonly accountEmail: string;
  readonly tenantId: string;
  readonly tenantName: string;
  readonly profileId: string;
  readonly membershipId: string;
  /** P holds an active owner membership in the tenant. */
  readonly isTenantOwner: boolean;
  readonly tenantOwnerCount: number;
  readonly tenantMemberCount: number;
}

/** What L sends to request a challenge. */
export interface CloudLinkChallengeRequest {
  appId: string;
  installationId: string;
  linkPublicKey: string;
  target: CloudLinkTarget;
}

/** What L sends to complete a challenge. */
export interface CloudLinkCompletion {
  challengeId: string;
  localIdentities: CloudLinkIdentities;
  /** base64url Ed25519 signature over {@link cloudLinkProofTranscript}. */
  signature: string;
}

/** The durable link; also the receipt H returns and L stores. */
export interface CloudLinkRecord {
  readonly protocol: typeof CLOUD_LINK_PROTOCOL;
  readonly linkId: string;
  readonly linkPublicKey: string;
  readonly installationId: string;
  readonly appId: string;
  readonly origin: string;
  readonly target: CloudLinkTarget;
  readonly accountId: string;
  readonly tenantId: string;
  /**
   * Claims L made about itself. Stored only to build the identity map; H
   * must never authorize anything on them.
   */
  readonly localIdentities: CloudLinkIdentities;
  /** Hosted counterparts. On the per-user target they equal the local ones. */
  readonly hostedIdentities: CloudLinkIdentities;
  readonly createdAt: string;
}

/** A challenge as H stores it. */
export interface StoredCloudLinkChallenge {
  readonly challenge: CloudLinkChallenge;
  readonly sessionId: string;
  readonly hostedProfileId: string;
  readonly hostedMembershipId: string;
}

/**
 * Persistence for the hosted half. Every method is one atomic step:
 * {@link insertChallenge} checks the per-account cap and inserts together,
 * {@link consumeChallenge} is a compare-and-set (two concurrent calls never
 * both receive the challenge), and {@link createLinkIfAbsent} is an
 * insert-if-absent on `linkPublicKey` that returns the winning record.
 */
export interface CloudLinkStore {
  /**
   * Insert unless the account already holds `maxOutstanding` unconsumed,
   * unexpired challenges at `now`; `false` when the cap refused it.
   */
  insertChallenge(
    stored: StoredCloudLinkChallenge,
    limits: { maxOutstanding: number; now: Date },
  ): Promise<boolean>;
  /**
   * Atomically mark consumed and return it, only for the session it was
   * issued to; `null` (and nothing consumed) when unknown, used or another
   * session's.
   */
  consumeChallenge(
    challengeId: string,
    sessionId: string,
  ): Promise<StoredCloudLinkChallenge | null>;
  findLinkByPublicKey(linkPublicKey: string): Promise<CloudLinkRecord | null>;
  createLinkIfAbsent(record: CloudLinkRecord): Promise<CloudLinkRecord>;
}

/** Machine-readable refusal codes. */
export type CloudLinkErrorCode =
  | 'invalid_request'
  | 'invalid_challenge'
  | 'challenge_mismatch'
  | 'challenge_expired'
  | 'challenge_unavailable'
  | 'not_tenant_owner'
  | 'tenant_not_sole_member'
  | 'tenant_shared'
  | 'too_many_challenges'
  | 'signature_invalid'
  | 'installation_linked_elsewhere'
  | 'invalid_receipt';

/** A refused link step. Messages never contain secret material. */
export class CloudLinkError extends Error {
  override readonly name = 'CloudLinkError';
  constructor(
    readonly code: CloudLinkErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: CloudLinkErrorCode, message: string): never {
  throw new CloudLinkError(code, message);
}

/** Lowercase a UUID, or `null` when it is not one. */
export function canonicalCloudUuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lowered = value.toLowerCase();
  return UUID_PATTERN.test(lowered) ? lowered : null;
}

function requireUuid(
  value: unknown,
  label: string,
  code: CloudLinkErrorCode = 'invalid_request',
): string {
  return canonicalCloudUuid(value) ?? fail(code, `${label} must be a UUID.`);
}

/**
 * Normalize an origin: `https:` (or `http:` on loopback only), lowercase
 * host, default port dropped, and no path, query, fragment or credentials.
 */
export function normalizeCloudOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('invalid_request', 'The hosted origin is not a valid URL.');
  }
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    fail(
      'invalid_request',
      'The hosted origin must use https (http is accepted on loopback only).',
    );
  }
  if (
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    fail('invalid_request', 'The hosted origin must be a bare origin.');
  }
  return url.origin;
}

/** Strip control and formatting characters from a display string. */
export function sanitizeCloudDisplay(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .slice(0, MAX_DISPLAY_LENGTH);
}

function decodeBase64Url(value: unknown, bytes: number): Buffer | null {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== bytes || decoded.toString('base64url') !== value) {
    return null;
  }
  return decoded;
}

function publicKeyObject(encoded: string): KeyObject | null {
  const raw = decodeBase64Url(encoded, 32);
  if (!raw) return null;
  try {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return null;
  }
}

/** The installation's link key pair, derived from its private seed. */
export interface CloudLinkKeyPair {
  /** Raw 32-byte Ed25519 public key, base64url. */
  readonly publicKey: string;
  readonly privateKey: KeyObject;
}

/**
 * Derive the installation's Ed25519 link key from its seed
 * (`secrets/application.secret`). Deterministic: a restore or `recover-seed`
 * keeps it; `reseed` changes it, so a re-seeded copy links on its own.
 */
export function deriveCloudLinkKeyPair(
  applicationSecret: string,
): CloudLinkKeyPair {
  const key = Buffer.from(applicationSecret.trim(), 'base64url');
  const seed = createHmac('sha256', key).update(LINK_KEY_PURPOSE).digest();
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  try {
    const privateKey = createPrivateKey({
      key: der,
      format: 'der',
      type: 'pkcs8',
    });
    const spki = createPublicKey(privateKey).export({
      format: 'der',
      type: 'spki',
    });
    return Object.freeze({
      publicKey: spki.subarray(spki.length - 32).toString('base64url'),
      privateKey,
    });
  } finally {
    key.fill(0);
    seed.fill(0);
    der.fill(0);
  }
}

function lengthPrefixed(parts: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
}

/**
 * The exact bytes L signs: every field length-prefixed (u64 big-endian) under
 * the `smrt-cloud-link-v1/proof` domain tag. UUIDs are lowercase.
 */
export function cloudLinkProofTranscript(
  challenge: CloudLinkChallenge,
  localIdentities: CloudLinkIdentities,
): Buffer {
  return lengthPrefixed([
    PROOF_TAG,
    challenge.protocol,
    challenge.target,
    challenge.origin,
    challenge.appId,
    challenge.challengeId,
    challenge.nonce,
    challenge.issuedAt,
    challenge.expiresAt,
    challenge.accountId,
    challenge.tenantId,
    challenge.installationId,
    challenge.linkPublicKey,
    localIdentities.tenantId,
    localIdentities.ownerId,
    localIdentities.profileId,
    localIdentities.membershipId,
  ]);
}

function validIdentities(value: unknown, label: string): CloudLinkIdentities {
  const candidate = (value ?? {}) as Partial<CloudLinkIdentities>;
  const identities = Object.freeze({
    tenantId: requireUuid(candidate.tenantId, `${label} tenant`),
    ownerId: requireUuid(candidate.ownerId, `${label} owner`),
    profileId: requireUuid(candidate.profileId, `${label} profile`),
    membershipId: requireUuid(candidate.membershipId, `${label} membership`),
  });
  const values = Object.values(identities);
  if (new Set(values).size !== values.length) {
    fail('invalid_request', `${label} identities must be distinct.`);
  }
  if (values.some((id) => SYSTEM_ROLE_IDS.has(id))) {
    fail('invalid_request', `${label} identities may not be system role IDs.`);
  }
  return identities;
}

/** Well-known global system role IDs (#4673): identical on every side. */
export const SYSTEM_ROLE_IDS: ReadonlySet<string> = new Set(
  DEFAULT_ROLES.map((role) => role.id.toLowerCase()),
);

/** Canonical slug of each well-known system role ID. */
export const SYSTEM_ROLE_SLUGS: ReadonlyMap<string, string> = new Map(
  DEFAULT_ROLES.map((role) => [role.id.toLowerCase(), role.slug]),
);

/**
 * Sign the proof for a challenge L has already checked with
 * {@link verifyCloudLinkChallenge}. Pure Ed25519 (no prehash).
 */
export function signCloudLinkProof(
  privateKey: KeyObject,
  challenge: CloudLinkChallenge,
  localIdentities: CloudLinkIdentities,
): string {
  const identities = validIdentities(localIdentities, 'Local');
  return sign(
    null,
    cloudLinkProofTranscript(challenge, identities),
    privateKey,
  ).toString('base64url');
}

/** What L expects of a challenge before it signs. */
export interface CloudLinkExpectations {
  /** The origin L called; compared after normalization. */
  origin: string;
  appId: string;
  installationId: string;
  linkPublicKey: string;
  /** The hosted account ID the operator named (`--account`). */
  accountId: string;
  /** The hosted tenant ID the operator named (`--tenant`). */
  tenantId: string;
  target: CloudLinkTarget;
  /** Accept a shared-target tenant that has other owners. */
  allowSharedTenant?: boolean;
  now?: Date;
}

/**
 * L's check of a challenge, before it signs anything. Returns a normalized,
 * frozen copy with display strings stripped of control characters.
 */
export function verifyCloudLinkChallenge(
  value: unknown,
  expected: CloudLinkExpectations,
): CloudLinkChallenge {
  const raw = (value ?? {}) as Partial<CloudLinkChallenge>;
  const invalid = (what: string): never =>
    fail('invalid_challenge', `The link challenge has an invalid ${what}.`);
  if (raw.protocol !== CLOUD_LINK_PROTOCOL) invalid('protocol');
  if (raw.target !== 'shared' && raw.target !== 'per-user') invalid('target');
  const display = (raw.display ?? {}) as Partial<CloudLinkChallenge['display']>;
  const ownerCount = display.tenantOwnerCount;
  const memberCount = display.tenantMemberCount;
  if (
    !Number.isSafeInteger(ownerCount) ||
    !Number.isSafeInteger(memberCount) ||
    (ownerCount as number) < 1 ||
    (memberCount as number) < (ownerCount as number)
  ) {
    invalid('tenant summary');
  }
  const issuedAt = Date.parse(String(raw.issuedAt));
  const expiresAt = Date.parse(String(raw.expiresAt));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) {
    invalid('lifetime');
  }
  if (
    !decodeBase64Url(raw.nonce, 32) ||
    !canonicalCloudUuid(raw.challengeId) ||
    typeof raw.origin !== 'string' ||
    typeof raw.appId !== 'string' ||
    typeof raw.linkPublicKey !== 'string'
  ) {
    invalid('field');
  }
  const challenge: CloudLinkChallenge = Object.freeze({
    protocol: CLOUD_LINK_PROTOCOL,
    challengeId: canonicalCloudUuid(raw.challengeId) as string,
    nonce: raw.nonce as string,
    origin: raw.origin as string,
    appId: raw.appId as string,
    target: raw.target as CloudLinkTarget,
    accountId: canonicalCloudUuid(raw.accountId) ?? invalid('account'),
    tenantId: canonicalCloudUuid(raw.tenantId) ?? invalid('tenant'),
    installationId:
      canonicalCloudUuid(raw.installationId) ?? invalid('installation'),
    linkPublicKey: raw.linkPublicKey as string,
    issuedAt: raw.issuedAt as string,
    expiresAt: raw.expiresAt as string,
    display: Object.freeze({
      accountEmail: sanitizeCloudDisplay(display.accountEmail),
      tenantName: sanitizeCloudDisplay(display.tenantName),
      tenantOwnerCount: ownerCount as number,
      tenantMemberCount: memberCount as number,
    }),
  });
  const mismatch = (what: string): never =>
    fail(
      'challenge_mismatch',
      `The link challenge names a different ${what} than expected.`,
    );
  if (challenge.origin !== normalizeCloudOrigin(expected.origin)) {
    mismatch('origin');
  }
  if (challenge.appId !== expected.appId) mismatch('application');
  if (challenge.target !== expected.target) mismatch('target');
  if (
    challenge.installationId !== canonicalCloudUuid(expected.installationId)
  ) {
    mismatch('installation');
  }
  if (challenge.linkPublicKey !== expected.linkPublicKey) {
    mismatch('link key');
  }
  if (challenge.accountId !== canonicalCloudUuid(expected.accountId)) {
    mismatch('account');
  }
  if (challenge.tenantId !== canonicalCloudUuid(expected.tenantId)) {
    mismatch('tenant');
  }
  const now = (expected.now ?? new Date()).getTime();
  if (
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > CLOUD_LINK_MAX_CHALLENGE_TTL_MS ||
    issuedAt > now + CLOUD_LINK_CLOCK_SKEW_MS ||
    expiresAt + CLOUD_LINK_CLOCK_SKEW_MS <= now
  ) {
    fail(
      'challenge_expired',
      'The link challenge is expired or not yet valid.',
    );
  }
  if (challenge.target === 'per-user' && memberCount !== 1) {
    fail(
      'tenant_not_sole_member',
      'A per-user cloud database must belong to a tenant with exactly one member.',
    );
  }
  if (
    challenge.target === 'shared' &&
    (ownerCount as number) > 1 &&
    !expected.allowSharedTenant
  ) {
    fail(
      'tenant_shared',
      'The hosted tenant has other owners; confirm explicitly to migrate into it.',
    );
  }
  return challenge;
}

/**
 * L's check of the receipt H returned: it must be exactly the link L signed
 * for, and on the per-user target map every identity to itself.
 */
export function verifyCloudLinkReceipt(
  value: unknown,
  challenge: CloudLinkChallenge,
  localIdentities: CloudLinkIdentities,
): CloudLinkRecord {
  let record: CloudLinkRecord;
  try {
    record = parseCloudLinkRecord(value);
  } catch {
    return fail('invalid_receipt', 'The link receipt is malformed.');
  }
  const local = validIdentities(localIdentities, 'Local');
  const same =
    record.linkPublicKey === challenge.linkPublicKey &&
    record.installationId === challenge.installationId &&
    record.appId === challenge.appId &&
    record.origin === challenge.origin &&
    record.target === challenge.target &&
    record.accountId === challenge.accountId &&
    record.tenantId === challenge.tenantId &&
    sameIdentities(record.localIdentities, local) &&
    record.hostedIdentities.tenantId === challenge.tenantId &&
    record.hostedIdentities.ownerId === challenge.accountId &&
    (record.target !== 'per-user' ||
      sameIdentities(record.hostedIdentities, local));
  if (!same) {
    fail(
      'invalid_receipt',
      'The link receipt does not match the signed proof.',
    );
  }
  return record;
}

function sameIdentities(
  left: CloudLinkIdentities,
  right: CloudLinkIdentities,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.ownerId === right.ownerId &&
    left.profileId === right.profileId &&
    left.membershipId === right.membershipId
  );
}

/** Parse and normalize a stored or received link record. */
export function parseCloudLinkRecord(value: unknown): CloudLinkRecord {
  const raw = (value ?? {}) as Partial<CloudLinkRecord>;
  if (raw.protocol !== CLOUD_LINK_PROTOCOL) {
    fail('invalid_receipt', 'Unsupported link record.');
  }
  if (raw.target !== 'shared' && raw.target !== 'per-user') {
    fail('invalid_receipt', 'The link record has an invalid target.');
  }
  if (
    typeof raw.appId !== 'string' ||
    typeof raw.origin !== 'string' ||
    !publicKeyObject(String(raw.linkPublicKey)) ||
    Number.isNaN(Date.parse(String(raw.createdAt)))
  ) {
    fail('invalid_receipt', 'The link record is malformed.');
  }
  const local = validIdentities(raw.localIdentities, 'Local');
  const hosted = validIdentities(raw.hostedIdentities, 'Hosted');
  if (raw.target === 'shared') {
    const localValues = new Set(Object.values(local));
    if (Object.values(hosted).some((id) => localValues.has(id))) {
      fail(
        'invalid_receipt',
        'A shared-target link must map to distinct hosted identities.',
      );
    }
  }
  return Object.freeze({
    protocol: CLOUD_LINK_PROTOCOL,
    linkId: requireUuid(raw.linkId, 'Link', 'invalid_receipt'),
    linkPublicKey: raw.linkPublicKey as string,
    installationId: requireUuid(
      raw.installationId,
      'Installation',
      'invalid_receipt',
    ),
    appId: raw.appId as string,
    origin: normalizeCloudOrigin(raw.origin as string),
    target: raw.target,
    accountId: requireUuid(raw.accountId, 'Account', 'invalid_receipt'),
    tenantId: requireUuid(raw.tenantId, 'Tenant', 'invalid_receipt'),
    localIdentities: local,
    hostedIdentities: hosted,
    createdAt: raw.createdAt as string,
  });
}

/**
 * Local → hosted identity map of a link, lowercase. Global system role IDs
 * map to themselves. On the per-user target every identity maps to itself.
 */
export function cloudLinkIdentityMap(
  record: CloudLinkRecord,
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const id of SYSTEM_ROLE_IDS) map.set(id, id);
  for (const key of [
    'tenantId',
    'ownerId',
    'profileId',
    'membershipId',
  ] as const) {
    map.set(record.localIdentities[key], record.hostedIdentities[key]);
  }
  return map;
}

/** Options for {@link createCloudLinkService}. */
export interface CloudLinkServiceOptions {
  /**
   * H's public origin from server configuration. Never derive it from the
   * `Host` or `X-Forwarded-*` headers of the request being served.
   */
  origin: string;
  store: CloudLinkStore;
  now?: () => Date;
  challengeTtlMs?: number;
  maxOutstandingChallenges?: number;
}

/** The hosted half of the protocol. */
export interface CloudLinkService {
  issueChallenge(
    principal: CloudLinkPrincipal,
    request: CloudLinkChallengeRequest,
  ): Promise<CloudLinkChallenge>;
  completeChallenge(
    principal: CloudLinkPrincipal,
    completion: CloudLinkCompletion,
  ): Promise<CloudLinkRecord>;
}

function linkMatches(
  existing: CloudLinkRecord,
  candidate: CloudLinkRecord,
): boolean {
  return (
    existing.linkPublicKey === candidate.linkPublicKey &&
    existing.installationId === candidate.installationId &&
    existing.appId === candidate.appId &&
    existing.origin === candidate.origin &&
    existing.target === candidate.target &&
    existing.accountId === candidate.accountId &&
    existing.tenantId === candidate.tenantId &&
    sameIdentities(existing.localIdentities, candidate.localIdentities) &&
    sameIdentities(existing.hostedIdentities, candidate.hostedIdentities)
  );
}

/** Create the hosted half of the link protocol over an injected store. */
export function createCloudLinkService(
  options: CloudLinkServiceOptions,
): CloudLinkService {
  const origin = normalizeCloudOrigin(options.origin);
  const now = options.now ?? (() => new Date());
  const ttl = options.challengeTtlMs ?? CLOUD_LINK_CHALLENGE_TTL_MS;
  if (
    !Number.isSafeInteger(ttl) ||
    ttl <= 0 ||
    ttl > CLOUD_LINK_MAX_CHALLENGE_TTL_MS
  ) {
    throw new RangeError('challengeTtlMs must be at most 10 minutes.');
  }
  const maxOutstanding =
    options.maxOutstandingChallenges ?? CLOUD_LINK_MAX_OUTSTANDING_CHALLENGES;
  const store = options.store;

  function principalIds(principal: CloudLinkPrincipal) {
    if (typeof principal?.sessionId !== 'string' || !principal.sessionId) {
      fail('invalid_request', 'An authenticated hosted session is required.');
    }
    return {
      accountId: requireUuid(principal.accountId, 'Account'),
      tenantId: requireUuid(principal.tenantId, 'Tenant'),
      profileId: requireUuid(principal.profileId, 'Profile'),
      membershipId: requireUuid(principal.membershipId, 'Membership'),
    };
  }

  const service: CloudLinkService = {
    async issueChallenge(principal, request) {
      const ids = principalIds(principal);
      if (principal.isTenantOwner !== true) {
        fail(
          'not_tenant_owner',
          'Only an owner of the hosted tenant can link an installation to it.',
        );
      }
      const target = request?.target;
      if (target !== 'shared' && target !== 'per-user') {
        fail('invalid_request', 'Unknown link target.');
      }
      if (target === 'per-user' && principal.tenantMemberCount !== 1) {
        fail(
          'tenant_not_sole_member',
          'A per-user cloud database must belong to a tenant with exactly one member.',
        );
      }
      if (
        typeof request.appId !== 'string' ||
        !APP_ID_PATTERN.test(request.appId)
      ) {
        fail('invalid_request', 'The application ID is invalid.');
      }
      if (!publicKeyObject(request.linkPublicKey)) {
        fail('invalid_request', 'The link public key is invalid.');
      }
      const issued = now();
      const challenge: CloudLinkChallenge = Object.freeze({
        protocol: CLOUD_LINK_PROTOCOL,
        challengeId: randomUuid(),
        nonce: randomBytes(32).toString('base64url'),
        origin,
        appId: request.appId,
        target,
        accountId: ids.accountId,
        tenantId: ids.tenantId,
        installationId: requireUuid(request.installationId, 'Installation'),
        linkPublicKey: request.linkPublicKey,
        issuedAt: issued.toISOString(),
        expiresAt: new Date(issued.getTime() + ttl).toISOString(),
        display: Object.freeze({
          accountEmail: sanitizeCloudDisplay(principal.accountEmail),
          tenantName: sanitizeCloudDisplay(principal.tenantName),
          tenantOwnerCount: principal.tenantOwnerCount,
          tenantMemberCount: principal.tenantMemberCount,
        }),
      });
      const inserted = await store.insertChallenge(
        Object.freeze({
          challenge,
          sessionId: principal.sessionId,
          hostedProfileId: ids.profileId,
          hostedMembershipId: ids.membershipId,
        }),
        { maxOutstanding, now: issued },
      );
      if (!inserted) {
        fail(
          'too_many_challenges',
          'Too many outstanding link challenges; wait for them to expire.',
        );
      }
      return challenge;
    },

    async completeChallenge(principal, completion) {
      const ids = principalIds(principal);
      const challengeId = requireUuid(completion?.challengeId, 'Challenge');
      // Consumed (for its own session only) before anything else is checked:
      // one attempt per challenge.
      const stored = await store.consumeChallenge(
        challengeId,
        principal.sessionId,
      );
      if (!stored) {
        fail('challenge_unavailable', 'The link challenge is unknown or used.');
      }
      const { challenge } = stored;
      if (
        stored.sessionId !== principal.sessionId ||
        challenge.accountId !== ids.accountId ||
        challenge.tenantId !== ids.tenantId ||
        challenge.origin !== origin
      ) {
        fail(
          'challenge_unavailable',
          'The link challenge was issued to another session.',
        );
      }
      if (now().getTime() >= Date.parse(challenge.expiresAt)) {
        fail('challenge_expired', 'The link challenge has expired.');
      }
      const localIdentities = validIdentities(
        completion.localIdentities,
        'Local',
      );
      const signature = decodeBase64Url(completion.signature, 64);
      const key = publicKeyObject(challenge.linkPublicKey);
      if (
        !signature ||
        !key ||
        !verify(
          null,
          cloudLinkProofTranscript(challenge, localIdentities),
          key,
          signature,
        )
      ) {
        fail('signature_invalid', 'The link proof does not verify.');
      }
      // Hosted identities always come from the session that requested the
      // challenge, never from the client's claims.
      const hostedIdentities: CloudLinkIdentities = Object.freeze({
        tenantId: challenge.tenantId,
        ownerId: challenge.accountId,
        profileId: stored.hostedProfileId,
        membershipId: stored.hostedMembershipId,
      });
      if (
        challenge.target === 'per-user' &&
        !sameIdentities(hostedIdentities, localIdentities)
      ) {
        // A per-user database is the imported local one: the signed-in
        // principal must be the imported local owner, tenant, profile and
        // membership exactly.
        fail(
          'challenge_mismatch',
          'A per-user link requires the hosted account to be the imported local owner.',
        );
      }
      const candidate = parseCloudLinkRecord({
        protocol: CLOUD_LINK_PROTOCOL,
        linkId: randomUuid(),
        linkPublicKey: challenge.linkPublicKey,
        installationId: challenge.installationId,
        appId: challenge.appId,
        origin: challenge.origin,
        target: challenge.target,
        accountId: challenge.accountId,
        tenantId: challenge.tenantId,
        localIdentities,
        hostedIdentities,
        createdAt: now().toISOString(),
      });
      const existing =
        (await store.findLinkByPublicKey(candidate.linkPublicKey)) ??
        (await store.createLinkIfAbsent(candidate));
      if (!linkMatches(existing, candidate)) {
        fail(
          'installation_linked_elsewhere',
          'This installation is already linked to a different hosted account, tenant or target. Re-seed a copy to link it separately.',
        );
      }
      return existing;
    },
  };
  return Object.freeze(service);
}

function randomUuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * In-memory {@link CloudLinkStore}. Single-process and non-durable: for tests
 * and local development only, never for a deployed hosted application.
 */
export function createMemoryCloudLinkStore(): CloudLinkStore {
  const challenges = new Map<
    string,
    { stored: StoredCloudLinkChallenge; consumed: boolean }
  >();
  const links = new Map<string, CloudLinkRecord>();
  const outstanding = (accountId: string, at: Date) => {
    let count = 0;
    for (const { stored, consumed } of challenges.values()) {
      if (
        !consumed &&
        stored.challenge.accountId === accountId &&
        Date.parse(stored.challenge.expiresAt) > at.getTime()
      ) {
        count += 1;
      }
    }
    return count;
  };
  return Object.freeze({
    async insertChallenge(
      stored: StoredCloudLinkChallenge,
      limits: { maxOutstanding: number; now: Date },
    ) {
      if (challenges.has(stored.challenge.challengeId)) {
        throw new Error('Duplicate challenge ID.');
      }
      if (
        outstanding(stored.challenge.accountId, limits.now) >=
        limits.maxOutstanding
      ) {
        return false;
      }
      challenges.set(stored.challenge.challengeId, { stored, consumed: false });
      return true;
    },
    async consumeChallenge(challengeId: string, sessionId: string) {
      const entry = challenges.get(challengeId);
      if (!entry || entry.consumed || entry.stored.sessionId !== sessionId) {
        return null;
      }
      entry.consumed = true;
      return entry.stored;
    },
    async findLinkByPublicKey(linkPublicKey: string) {
      return links.get(linkPublicKey) ?? null;
    },
    async createLinkIfAbsent(record: CloudLinkRecord) {
      const existing = links.get(record.linkPublicKey);
      if (existing) return existing;
      links.set(record.linkPublicKey, record);
      return record;
    },
  });
}
