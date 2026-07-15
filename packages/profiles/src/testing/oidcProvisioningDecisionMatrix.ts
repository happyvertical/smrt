/**
 * Canonical executable contract for Profile and User OIDC provisioning.
 *
 * The Profiles and Users suites execute the applicable rows directly. Public
 * documentation links here instead of maintaining a second behavioral table.
 */

export type OidcProvisioningIdentityState =
  | 'none'
  | 'exact_global_person'
  | 'exact_legacy_tenant_profile'
  | 'exact_legacy_non_person_profile'
  | 'exact_ambiguous_legacy_links'
  | 'exact_missing_profile';

export type OidcProvisioningEmailState =
  | 'missing'
  | 'no_match'
  | 'one_unowned_global_person'
  | 'tenant_scoped_collision'
  | 'non_person_collision'
  | 'duplicate_normalized_profiles'
  | 'already_owned_global_person'
  | 'different_global_person';

export type OidcProvisioningVerificationState =
  | 'verified'
  | 'unverified'
  | 'claim_missing';

export type OidcProvisioningResolverResult =
  | 'absent'
  | 'undefined'
  | 'null'
  | 'same_profile'
  | 'different_profile'
  | 'owned_profile'
  | 'throws';

export type OidcProvisioningOwnerAuthorizationResult =
  | 'matching_owner'
  | 'multiple_owners'
  | 'no_owner'
  | 'null'
  | 'wrong_user';

export type OidcProvisioningExecutionState =
  | 'first_callback'
  | 'exact_subsequent_callback'
  | 'concurrent_winner_and_observer'
  | 'concurrent_email_competitors'
  | 'durable_arbiter_retry'
  | 'caller_owned_transaction'
  | 'concurrent_authorized_callbacks'
  | 'root_transaction_rollback'
  | 'duckdb_caller_owned_transaction';

export type OidcProvisioningPublicErrorCode =
  | 'ambiguous_email'
  | 'ambiguous_identity'
  | 'email_mismatch'
  | 'email_key_backfill_required'
  | 'missing_profile'
  | 'non_person'
  | 'profile_owned'
  | 'rejected'
  | 'tenant_scoped'
  | 'transaction_required'
  | 'user_email_backfill_required'
  | 'user_email_conflict'
  | null;

export type OidcProvisioningPublicError =
  | { code: Exclude<OidcProvisioningPublicErrorCode, null> }
  | { messageIncludes: string }
  | { name: string }
  | null;

export type OidcProvisioningSelectedProfile =
  | 'new_profile'
  | 'email_match'
  | 'exact_identity_profile'
  | 'resolver_profile'
  | 'authorized_profile'
  | 'concurrent_winner'
  | null;

export type OidcProvisioningReadiness =
  | 'none'
  | 'profile_email_keys'
  | 'profile_and_user_email_keys';

export interface OidcProvisioningCreatedRows {
  profile: number;
  oidcIdentity: number;
  user: number;
  session: number;
}

export interface OidcProvisioningSurfaceExpectation {
  outcome: 'success' | 'rejected' | 'mixed';
  publicError: OidcProvisioningPublicError;
  selectedProfile: OidcProvisioningSelectedProfile;
  resolverCalls: number | 'at_least_2';
  ownerAuthorizerCalls: number | 'at_least_2';
  /** Exact issuer/subject authority is never rebindable. */
  rebindAllowed: false;
  /** Backfill marker state installed by the runner for this surface. */
  readiness: OidcProvisioningReadiness;
  retry: 'none' | 'once_after_race';
  resultCreated: 'created' | 'reused' | 'created_and_reused' | 'none';
  createdRows: OidcProvisioningCreatedRows;
}

export type OidcProvisioningAdapterStatus =
  | 'required'
  | 'sqlite_parity'
  | 'root_serialized'
  | 'not_applicable'
  | 'unsupported';

export interface OidcProvisioningAdapterExpectation {
  status: OidcProvisioningAdapterStatus;
  invariant?: string;
}

export interface OidcProvisioningScenario {
  id: string;
  title: string;
  identity: OidcProvisioningIdentityState;
  email: OidcProvisioningEmailState;
  verification: OidcProvisioningVerificationState;
  resolver: OidcProvisioningResolverResult;
  ownerAuthorization?: OidcProvisioningOwnerAuthorizationResult;
  execution: OidcProvisioningExecutionState;
  adapters: {
    sqlite: OidcProvisioningAdapterExpectation;
    postgres: OidcProvisioningAdapterExpectation;
    duckdb: OidcProvisioningAdapterExpectation;
  };
  expectations: {
    profiles?: OidcProvisioningSurfaceExpectation;
    users?: OidcProvisioningSurfaceExpectation;
  };
}

const ROOT_ADAPTERS = {
  sqlite: { status: 'required' },
  postgres: { status: 'sqlite_parity' },
  duckdb: {
    status: 'root_serialized',
    invariant:
      'DuckDB provisioning is supported through a root database and is serialized per database URL.',
  },
} as const satisfies OidcProvisioningScenario['adapters'];

const POSTGRES_SENSITIVE_ADAPTERS = {
  sqlite: { status: 'required' },
  postgres: { status: 'required' },
  duckdb: {
    status: 'root_serialized',
    invariant:
      'DuckDB uses root-handle serialization instead of overlapping independent transactions.',
  },
} as const satisfies OidcProvisioningScenario['adapters'];

const CALLER_TRANSACTION_ADAPTERS = {
  sqlite: { status: 'required' },
  postgres: { status: 'required' },
  duckdb: {
    status: 'unsupported',
    invariant:
      'DuckDB transaction handles do not support the savepoint contract; pass the root database.',
  },
} as const satisfies OidcProvisioningScenario['adapters'];

const DUCKDB_CALLER_TRANSACTION_ADAPTERS = {
  sqlite: { status: 'not_applicable' },
  postgres: { status: 'not_applicable' },
  duckdb: {
    status: 'required',
    invariant:
      'DuckDB transaction handles fail closed before provisioning writes and leave the caller transaction usable.',
  },
} as const satisfies OidcProvisioningScenario['adapters'];

const noRows = (): OidcProvisioningCreatedRows => ({
  profile: 0,
  oidcIdentity: 0,
  user: 0,
  session: 0,
});

function expectation(
  overrides: Partial<OidcProvisioningSurfaceExpectation> = {},
): OidcProvisioningSurfaceExpectation {
  const expectation: OidcProvisioningSurfaceExpectation = {
    outcome: 'success',
    publicError: null,
    selectedProfile: 'new_profile',
    resolverCalls: 0,
    ownerAuthorizerCalls: 0,
    rebindAllowed: false,
    readiness: 'none',
    retry: 'none',
    resultCreated: 'created',
    createdRows: noRows(),
    ...overrides,
  };
  if (
    overrides.resultCreated === undefined &&
    expectation.outcome === 'rejected'
  ) {
    expectation.resultCreated = 'none';
  }
  return expectation;
}

/**
 * Typed scenario table consumed by both package suites.
 *
 * Row counts are deltas from the declared fixture state. A rejected row always
 * declares zero User and session creation; the runners assert every delta.
 */
export const OIDC_PROVISIONING_DECISION_MATRIX = [
  {
    id: 'new-verified-no-match',
    title: 'verified first callback creates a new canonical identity',
    identity: 'none',
    email: 'no_match',
    verification: 'verified',
    resolver: 'absent',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      profiles: expectation({
        readiness: 'profile_email_keys',
        createdRows: { ...noRows(), profile: 1, oidcIdentity: 1 },
      }),
      users: expectation({
        readiness: 'profile_and_user_email_keys',
        createdRows: {
          profile: 1,
          oidcIdentity: 1,
          user: 1,
          session: 0,
        },
      }),
    },
  },
  {
    id: 'new-missing-email',
    title:
      'Profile-only provisioning allows a missing email while Users reject',
    identity: 'none',
    email: 'missing',
    verification: 'claim_missing',
    resolver: 'absent',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      profiles: expectation({
        createdRows: { ...noRows(), profile: 1, oidcIdentity: 1 },
      }),
      users: expectation({
        outcome: 'rejected',
        publicError: { messageIncludes: 'missing required "email"' },
        selectedProfile: null,
      }),
    },
  },
  {
    id: 'new-unverified-no-match',
    title:
      'Profile-only provisioning isolates an unverified email while Users reject',
    identity: 'none',
    email: 'no_match',
    verification: 'unverified',
    resolver: 'absent',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      profiles: expectation({
        readiness: 'profile_email_keys',
        createdRows: { ...noRows(), profile: 1, oidcIdentity: 1 },
      }),
      users: expectation({
        outcome: 'rejected',
        publicError: { messageIncludes: 'unverified email' },
        selectedProfile: null,
      }),
    },
  },
  {
    id: 'new-unverified-email-match',
    title: 'an unverified email never reuses an existing Profile',
    identity: 'none',
    email: 'one_unowned_global_person',
    verification: 'unverified',
    resolver: 'absent',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      profiles: expectation({
        outcome: 'rejected',
        publicError: { messageIncludes: 'not verified' },
        selectedProfile: null,
        readiness: 'profile_email_keys',
      }),
      users: expectation({
        outcome: 'rejected',
        publicError: { messageIncludes: 'unverified email' },
        selectedProfile: null,
      }),
    },
  },
  {
    id: 'new-verified-email-match',
    title: 'only owner-aware User provisioning may reuse a safe email match',
    identity: 'none',
    email: 'one_unowned_global_person',
    verification: 'verified',
    resolver: 'absent',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      profiles: expectation({
        outcome: 'rejected',
        publicError: {
          messageIncludes: 'cannot prove that Profile is unowned',
        },
        selectedProfile: null,
        readiness: 'profile_email_keys',
      }),
      users: expectation({
        selectedProfile: 'email_match',
        readiness: 'profile_and_user_email_keys',
        resultCreated: 'reused',
        createdRows: { ...noRows(), oidcIdentity: 1, user: 1 },
      }),
    },
  },
  {
    id: 'new-verified-tenant-collision',
    title: 'tenant-scoped email collisions fail closed',
    identity: 'none',
    email: 'tenant_scoped_collision',
    verification: 'verified',
    resolver: 'absent',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      profiles: expectation({
        outcome: 'rejected',
        publicError: { code: 'tenant_scoped' },
        selectedProfile: null,
        readiness: 'profile_email_keys',
      }),
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'tenant_scoped' },
        selectedProfile: null,
        readiness: 'profile_email_keys',
      }),
    },
  },
  {
    id: 'new-verified-non-person-collision',
    title: 'non-Person email collisions fail closed',
    identity: 'none',
    email: 'non_person_collision',
    verification: 'verified',
    resolver: 'absent',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      profiles: expectation({
        outcome: 'rejected',
        publicError: { code: 'non_person' },
        selectedProfile: null,
        readiness: 'profile_email_keys',
      }),
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'non_person' },
        selectedProfile: null,
        readiness: 'profile_email_keys',
      }),
    },
  },
  {
    id: 'new-verified-duplicate-email',
    title: 'duplicate normalized Profile emails fail closed',
    identity: 'none',
    email: 'duplicate_normalized_profiles',
    verification: 'verified',
    resolver: 'absent',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      profiles: expectation({
        outcome: 'rejected',
        publicError: { code: 'ambiguous_email' },
        selectedProfile: null,
        readiness: 'profile_email_keys',
      }),
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'ambiguous_email' },
        selectedProfile: null,
        readiness: 'profile_email_keys',
      }),
    },
  },
  {
    id: 'new-verified-owned-profile',
    title: 'an already-owned email match cannot acquire another identity',
    identity: 'none',
    email: 'already_owned_global_person',
    verification: 'verified',
    resolver: 'absent',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'profile_owned' },
        selectedProfile: null,
        readiness: 'profile_email_keys',
      }),
    },
  },
  {
    id: 'owner-authorized-first-binding',
    title:
      'explicit owner authorization binds a verified first identity to its pre-provisioned User',
    identity: 'none',
    email: 'already_owned_global_person',
    verification: 'verified',
    resolver: 'absent',
    ownerAuthorization: 'matching_owner',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        selectedProfile: 'authorized_profile',
        ownerAuthorizerCalls: 1,
        readiness: 'profile_and_user_email_keys',
        resultCreated: 'reused',
        createdRows: { ...noRows(), oidcIdentity: 1 },
      }),
    },
  },
  {
    id: 'owner-authorizer-rejects',
    title: 'a null owner authorization rejects before identity creation',
    identity: 'none',
    email: 'already_owned_global_person',
    verification: 'verified',
    resolver: 'absent',
    ownerAuthorization: 'null',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'rejected' },
        selectedProfile: null,
        ownerAuthorizerCalls: 1,
      }),
    },
  },
  {
    id: 'owner-authorized-unverified',
    title: 'owner authorization never overrides an explicitly unverified email',
    identity: 'none',
    email: 'already_owned_global_person',
    verification: 'unverified',
    resolver: 'absent',
    ownerAuthorization: 'matching_owner',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'rejected' },
        selectedProfile: null,
        ownerAuthorizerCalls: 1,
      }),
    },
  },
  {
    id: 'owner-authorized-missing-verification',
    title: 'owner authorization requires an explicit true verification claim',
    identity: 'none',
    email: 'already_owned_global_person',
    verification: 'claim_missing',
    resolver: 'absent',
    ownerAuthorization: 'matching_owner',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'rejected' },
        selectedProfile: null,
        ownerAuthorizerCalls: 1,
      }),
    },
  },
  {
    id: 'owner-authorized-profile-email-mismatch',
    title: 'an authorized Profile must match the verified claim email',
    identity: 'none',
    email: 'different_global_person',
    verification: 'verified',
    resolver: 'absent',
    ownerAuthorization: 'matching_owner',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'email_mismatch' },
        selectedProfile: null,
        ownerAuthorizerCalls: 1,
        readiness: 'profile_email_keys',
      }),
    },
  },
  {
    id: 'owner-authorized-user-email-mismatch',
    title: 'the authorized owner must match the verified claim email',
    identity: 'none',
    email: 'already_owned_global_person',
    verification: 'verified',
    resolver: 'absent',
    ownerAuthorization: 'matching_owner',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'user_email_conflict' },
        selectedProfile: null,
        ownerAuthorizerCalls: 1,
        readiness: 'profile_and_user_email_keys',
      }),
    },
  },
  {
    id: 'owner-authorized-tenant-profile',
    title: 'owner authorization cannot select a tenant-scoped Profile',
    identity: 'none',
    email: 'tenant_scoped_collision',
    verification: 'verified',
    resolver: 'absent',
    ownerAuthorization: 'matching_owner',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'tenant_scoped' },
        selectedProfile: null,
        ownerAuthorizerCalls: 1,
        readiness: 'profile_email_keys',
      }),
    },
  },
  {
    id: 'owner-authorized-non-person',
    title: 'owner authorization cannot select a non-Person Profile',
    identity: 'none',
    email: 'non_person_collision',
    verification: 'verified',
    resolver: 'absent',
    ownerAuthorization: 'matching_owner',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'non_person' },
        selectedProfile: null,
        ownerAuthorizerCalls: 1,
        readiness: 'profile_email_keys',
      }),
    },
  },
  {
    id: 'owner-authorized-ambiguous-profile',
    title: 'owner authorization cannot select an ambiguous Profile email',
    identity: 'none',
    email: 'duplicate_normalized_profiles',
    verification: 'verified',
    resolver: 'absent',
    ownerAuthorization: 'matching_owner',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'ambiguous_email' },
        selectedProfile: null,
        ownerAuthorizerCalls: 1,
        readiness: 'profile_email_keys',
      }),
    },
  },
  {
    id: 'owner-authorized-no-owner',
    title: 'owner authorization requires exactly one Profile owner',
    identity: 'none',
    email: 'one_unowned_global_person',
    verification: 'verified',
    resolver: 'absent',
    ownerAuthorization: 'no_owner',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'profile_owned' },
        selectedProfile: null,
        ownerAuthorizerCalls: 1,
        readiness: 'profile_email_keys',
      }),
    },
  },
  {
    id: 'owner-authorized-multiple-owners',
    title: 'owner authorization rejects legacy multiple Profile owners',
    identity: 'none',
    email: 'already_owned_global_person',
    verification: 'verified',
    resolver: 'absent',
    ownerAuthorization: 'multiple_owners',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'profile_owned' },
        selectedProfile: null,
        ownerAuthorizerCalls: 1,
        readiness: 'profile_email_keys',
      }),
    },
  },
  {
    id: 'owner-authorized-wrong-user',
    title: 'owner authorization rejects a User that does not own the Profile',
    identity: 'none',
    email: 'already_owned_global_person',
    verification: 'verified',
    resolver: 'absent',
    ownerAuthorization: 'wrong_user',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'profile_owned' },
        selectedProfile: null,
        ownerAuthorizerCalls: 1,
        readiness: 'profile_email_keys',
      }),
    },
  },
  {
    id: 'owner-authorized-conflicting-identity',
    title: 'owner authorization cannot rebind an exact conflicting identity',
    identity: 'exact_global_person',
    email: 'different_global_person',
    verification: 'verified',
    resolver: 'absent',
    ownerAuthorization: 'matching_owner',
    execution: 'exact_subsequent_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'rejected' },
        selectedProfile: null,
        ownerAuthorizerCalls: 1,
        readiness: 'profile_and_user_email_keys',
      }),
    },
  },
  {
    id: 'owner-authorized-concurrent-callbacks',
    title:
      'concurrent authorized callbacks converge on one existing User and identity',
    identity: 'none',
    email: 'already_owned_global_person',
    verification: 'verified',
    resolver: 'absent',
    ownerAuthorization: 'matching_owner',
    execution: 'concurrent_authorized_callbacks',
    adapters: POSTGRES_SENSITIVE_ADAPTERS,
    expectations: {
      users: expectation({
        selectedProfile: 'authorized_profile',
        ownerAuthorizerCalls: 'at_least_2',
        readiness: 'profile_and_user_email_keys',
        resultCreated: 'reused',
        createdRows: { ...noRows(), oidcIdentity: 1 },
      }),
    },
  },
  {
    id: 'owner-authorizer-durable-arbiter-retry',
    title: 'a durable race retry invokes the idempotent owner authorizer again',
    identity: 'none',
    email: 'already_owned_global_person',
    verification: 'verified',
    resolver: 'absent',
    ownerAuthorization: 'matching_owner',
    execution: 'durable_arbiter_retry',
    adapters: POSTGRES_SENSITIVE_ADAPTERS,
    expectations: {
      users: expectation({
        selectedProfile: 'authorized_profile',
        ownerAuthorizerCalls: 2,
        readiness: 'profile_and_user_email_keys',
        retry: 'once_after_race',
        resultCreated: 'reused',
        createdRows: { ...noRows(), oidcIdentity: 1 },
      }),
    },
  },
  {
    id: 'exact-safe-owned',
    title: 'an exact safe identity reuses its canonical Profile and User',
    identity: 'exact_global_person',
    email: 'already_owned_global_person',
    verification: 'verified',
    resolver: 'absent',
    execution: 'exact_subsequent_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      profiles: expectation({
        selectedProfile: 'exact_identity_profile',
        resultCreated: 'reused',
      }),
      users: expectation({
        selectedProfile: 'exact_identity_profile',
        readiness: 'profile_email_keys',
        resultCreated: 'reused',
      }),
    },
  },
  {
    id: 'exact-safe-unowned',
    title: 'an exact safe identity without an owner may create one User',
    identity: 'exact_global_person',
    email: 'one_unowned_global_person',
    verification: 'verified',
    resolver: 'absent',
    execution: 'exact_subsequent_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      profiles: expectation({
        selectedProfile: 'exact_identity_profile',
        resultCreated: 'reused',
      }),
      users: expectation({
        selectedProfile: 'exact_identity_profile',
        readiness: 'profile_and_user_email_keys',
        resultCreated: 'reused',
        createdRows: { ...noRows(), user: 1 },
      }),
    },
  },
  {
    id: 'exact-legacy-tenant-profile',
    title: 'Profile-only legacy exact reuse succeeds while Users fail closed',
    identity: 'exact_legacy_tenant_profile',
    email: 'tenant_scoped_collision',
    verification: 'verified',
    resolver: 'absent',
    execution: 'exact_subsequent_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      profiles: expectation({
        selectedProfile: 'exact_identity_profile',
        resultCreated: 'reused',
      }),
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'tenant_scoped' },
        selectedProfile: null,
        readiness: 'profile_email_keys',
      }),
    },
  },
  {
    id: 'exact-legacy-non-person-profile',
    title:
      'Profile-only non-Person exact reuse succeeds while Users fail closed',
    identity: 'exact_legacy_non_person_profile',
    email: 'non_person_collision',
    verification: 'verified',
    resolver: 'absent',
    execution: 'exact_subsequent_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      profiles: expectation({
        selectedProfile: 'exact_identity_profile',
        resultCreated: 'reused',
      }),
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'non_person' },
        selectedProfile: null,
        readiness: 'profile_email_keys',
      }),
    },
  },
  {
    id: 'exact-ambiguous-legacy-links',
    title: 'ambiguous legacy exact identities fail closed',
    identity: 'exact_ambiguous_legacy_links',
    email: 'one_unowned_global_person',
    verification: 'verified',
    resolver: 'absent',
    execution: 'exact_subsequent_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      profiles: expectation({
        outcome: 'rejected',
        publicError: { name: 'AmbiguousOidcIdentityError' },
        selectedProfile: null,
      }),
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'ambiguous_identity' },
        selectedProfile: null,
      }),
    },
  },
  {
    id: 'exact-missing-profile',
    title: 'an exact identity with a missing Profile fails closed',
    identity: 'exact_missing_profile',
    email: 'no_match',
    verification: 'verified',
    resolver: 'absent',
    execution: 'exact_subsequent_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      profiles: expectation({
        outcome: 'rejected',
        publicError: {
          messageIncludes: 'provisioning result was not found',
        },
        selectedProfile: null,
      }),
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'missing_profile' },
        selectedProfile: null,
        readiness: 'profile_email_keys',
      }),
    },
  },
  {
    id: 'resolver-undefined-new',
    title: 'undefined resolver output selects the secure default',
    identity: 'none',
    email: 'no_match',
    verification: 'verified',
    resolver: 'undefined',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        resolverCalls: 1,
        readiness: 'profile_and_user_email_keys',
        createdRows: {
          profile: 1,
          oidcIdentity: 1,
          user: 1,
          session: 0,
        },
      }),
    },
  },
  {
    id: 'resolver-null-new',
    title: 'null resolver output rejects before provisioning',
    identity: 'none',
    email: 'no_match',
    verification: 'verified',
    resolver: 'null',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'rejected' },
        selectedProfile: null,
        resolverCalls: 1,
      }),
    },
  },
  {
    id: 'resolver-same-new',
    title:
      'a resolver may select the same safe canonical Profile for a new identity',
    identity: 'none',
    email: 'one_unowned_global_person',
    verification: 'verified',
    resolver: 'same_profile',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        selectedProfile: 'resolver_profile',
        resolverCalls: 1,
        readiness: 'profile_and_user_email_keys',
        resultCreated: 'reused',
        createdRows: { ...noRows(), oidcIdentity: 1, user: 1 },
      }),
    },
  },
  {
    id: 'resolver-owned-new',
    title: 'a resolver-selected owned Profile fails closed',
    identity: 'none',
    email: 'already_owned_global_person',
    verification: 'verified',
    resolver: 'owned_profile',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'profile_owned' },
        selectedProfile: null,
        resolverCalls: 1,
        readiness: 'profile_email_keys',
      }),
    },
  },
  {
    id: 'resolver-same-exact',
    title: 'a resolver may confirm but not rebind an exact identity',
    identity: 'exact_global_person',
    email: 'already_owned_global_person',
    verification: 'verified',
    resolver: 'same_profile',
    execution: 'exact_subsequent_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        selectedProfile: 'exact_identity_profile',
        resolverCalls: 1,
        readiness: 'profile_email_keys',
        resultCreated: 'reused',
      }),
    },
  },
  {
    id: 'resolver-different-exact',
    title: 'a resolver cannot rebind an exact identity to a different Profile',
    identity: 'exact_global_person',
    email: 'different_global_person',
    verification: 'verified',
    resolver: 'different_profile',
    execution: 'exact_subsequent_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'rejected' },
        selectedProfile: null,
        resolverCalls: 1,
      }),
    },
  },
  {
    id: 'resolver-null-exact',
    title: 'null resolver output rejects exact identity reuse',
    identity: 'exact_global_person',
    email: 'already_owned_global_person',
    verification: 'verified',
    resolver: 'null',
    execution: 'exact_subsequent_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'rejected' },
        selectedProfile: null,
        resolverCalls: 1,
      }),
    },
  },
  {
    id: 'resolver-throws-new',
    title: 'resolver exceptions roll back without authentication state',
    identity: 'none',
    email: 'no_match',
    verification: 'verified',
    resolver: 'throws',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'rejected',
        publicError: { messageIncludes: 'matrix resolver failure' },
        selectedProfile: null,
        resolverCalls: 1,
      }),
    },
  },
  {
    id: 'profile-readiness-missing',
    title: 'email-based lookup fails until Profile email keys are ready',
    identity: 'none',
    email: 'one_unowned_global_person',
    verification: 'verified',
    resolver: 'absent',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      profiles: expectation({
        outcome: 'rejected',
        publicError: { code: 'email_key_backfill_required' },
        selectedProfile: null,
      }),
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'email_key_backfill_required' },
        selectedProfile: null,
      }),
    },
  },
  {
    id: 'user-readiness-missing',
    title: 'User creation fails until User email keys are ready',
    identity: 'none',
    email: 'no_match',
    verification: 'verified',
    resolver: 'absent',
    execution: 'first_callback',
    adapters: ROOT_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'user_email_backfill_required' },
        selectedProfile: null,
        readiness: 'profile_email_keys',
      }),
    },
  },
  {
    id: 'concurrent-winner-and-observer',
    title: 'both concurrent callbacks run policy and converge on the winner',
    identity: 'none',
    email: 'no_match',
    verification: 'verified',
    resolver: 'undefined',
    execution: 'concurrent_winner_and_observer',
    adapters: POSTGRES_SENSITIVE_ADAPTERS,
    expectations: {
      profiles: expectation({
        selectedProfile: 'concurrent_winner',
        readiness: 'profile_email_keys',
        resultCreated: 'created_and_reused',
        createdRows: { ...noRows(), profile: 1, oidcIdentity: 1 },
      }),
      users: expectation({
        selectedProfile: 'concurrent_winner',
        resolverCalls: 'at_least_2',
        readiness: 'profile_and_user_email_keys',
        resultCreated: 'created_and_reused',
        createdRows: {
          profile: 1,
          oidcIdentity: 1,
          user: 1,
          session: 0,
        },
      }),
    },
  },
  {
    id: 'concurrent-email-competitors',
    title: 'only one concurrent subject may claim a verified email',
    identity: 'none',
    email: 'no_match',
    verification: 'verified',
    resolver: 'undefined',
    execution: 'concurrent_email_competitors',
    adapters: POSTGRES_SENSITIVE_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'mixed',
        publicError: { code: 'profile_owned' },
        selectedProfile: 'concurrent_winner',
        resolverCalls: 'at_least_2',
        readiness: 'profile_and_user_email_keys',
        createdRows: {
          profile: 1,
          oidcIdentity: 1,
          user: 1,
          session: 0,
        },
      }),
    },
  },
  {
    id: 'resolver-durable-arbiter-retry',
    title: 'a durable race retry invokes the idempotent resolver again',
    identity: 'none',
    email: 'no_match',
    verification: 'verified',
    resolver: 'undefined',
    execution: 'durable_arbiter_retry',
    adapters: POSTGRES_SENSITIVE_ADAPTERS,
    expectations: {
      users: expectation({
        resolverCalls: 2,
        readiness: 'profile_and_user_email_keys',
        retry: 'once_after_race',
        createdRows: {
          profile: 1,
          oidcIdentity: 1,
          user: 1,
          session: 0,
        },
      }),
    },
  },
  {
    id: 'caller-owned-transaction',
    title: 'caller-owned transactions use a savepoint where supported',
    identity: 'none',
    email: 'no_match',
    verification: 'verified',
    resolver: 'undefined',
    execution: 'caller_owned_transaction',
    adapters: CALLER_TRANSACTION_ADAPTERS,
    expectations: {
      profiles: expectation({
        readiness: 'profile_email_keys',
        createdRows: { ...noRows(), profile: 1, oidcIdentity: 1 },
      }),
      users: expectation({
        resolverCalls: 1,
        readiness: 'profile_and_user_email_keys',
        createdRows: {
          profile: 1,
          oidcIdentity: 1,
          user: 1,
          session: 0,
        },
      }),
    },
  },
  {
    id: 'root-transaction-resolver-rollback',
    title: 'root coordination rolls resolver rejection back atomically',
    identity: 'none',
    email: 'no_match',
    verification: 'verified',
    resolver: 'null',
    execution: 'root_transaction_rollback',
    adapters: POSTGRES_SENSITIVE_ADAPTERS,
    expectations: {
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'rejected' },
        selectedProfile: null,
        resolverCalls: 1,
      }),
    },
  },
  {
    id: 'duckdb-caller-owned-transaction',
    title: 'DuckDB caller-owned transactions fail closed and remain usable',
    identity: 'none',
    email: 'no_match',
    verification: 'verified',
    resolver: 'absent',
    execution: 'duckdb_caller_owned_transaction',
    adapters: DUCKDB_CALLER_TRANSACTION_ADAPTERS,
    expectations: {
      profiles: expectation({
        outcome: 'rejected',
        publicError: { messageIncludes: 'root database' },
        selectedProfile: null,
      }),
      users: expectation({
        outcome: 'rejected',
        publicError: { code: 'transaction_required' },
        selectedProfile: null,
      }),
    },
  },
] as const satisfies readonly OidcProvisioningScenario[];

export type OidcProvisioningDecisionScenario =
  (typeof OIDC_PROVISIONING_DECISION_MATRIX)[number];

export function getOidcProvisioningDecisionScenario(
  id: OidcProvisioningDecisionScenario['id'],
): OidcProvisioningDecisionScenario {
  const scenario = OIDC_PROVISIONING_DECISION_MATRIX.find(
    (candidate) => candidate.id === id,
  );
  if (!scenario) throw new Error(`Unknown OIDC provisioning scenario: ${id}`);
  return scenario;
}

export function getOidcProvisioningPublicErrorCode(
  expectation: OidcProvisioningSurfaceExpectation | undefined,
): Exclude<OidcProvisioningPublicErrorCode, null> {
  const publicError = expectation?.publicError;
  if (!publicError || !('code' in publicError)) {
    throw new Error('The OIDC provisioning scenario has no public error code.');
  }
  return publicError.code;
}
