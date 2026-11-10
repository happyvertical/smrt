/**
 * Types for the hosted vault-account admin surface (#4841).
 *
 * Everything the gated actions touch is an injected port, so no HTTP server or
 * real relay is needed to run or test them. `VaultRelay` from
 * `@happyvertical/smrt-vault-relay` satisfies {@link VaultRelayAdminPort}
 * structurally (this package cannot depend on it: the relay depends on this
 * package), and {@link createVaultRelayAdminClient} implements it over the
 * relay's admin HTTP API.
 */
import type { StepUpSession } from '@happyvertical/smrt-users/step-up';

/** The three gated actions. */
export type VaultAccountAction =
  | 'supersede'
  | 'unsupersede'
  | 'provision_restart_account';

/** Why an attempt was refused. The caller sees only the error code. */
export type VaultAccountDenial = 'not_owner' | 'step_up_required';

/**
 * The relay admin operations the actions use: the account-layer hooks of
 * `VaultRelay` (`registerDevice`, `supersedeAccount`, `clearSupersession`).
 */
export interface VaultRelayAdminPort {
  /** Register a device's raw Ed25519 public key (base64url) in an account. */
  registerDevice(
    accountId: string,
    deviceId: string,
    publicKey: string,
  ): Promise<'registered' | 'unchanged' | 'conflict'>;
  /** Replace `accountId` by `supersededBy`. Idempotent for the same target. */
  supersedeAccount(
    accountId: string,
    supersededBy: string,
  ): Promise<'superseded' | 'unchanged'>;
  /** Undo a supersession; false when there was none. */
  clearSupersession(accountId: string): Promise<boolean>;
}

/**
 * The host's account directory: which tenant a vault account belongs to (the
 * same mapping the relay's `tenantForAccount` entitlement lookup reads, so
 * `backup.vault` resolves for a linked account).
 */
export interface VaultAccountDirectory {
  /** The tenant that owns `accountId`, or null when unknown. */
  tenantForAccount(accountId: string): string | null | Promise<string | null>;
  /** Record that `accountId` belongs to `tenantId`. Idempotent. */
  linkAccount(tenantId: string, accountId: string): void | Promise<void>;
}

/**
 * One audit record. Carries ids, codes and times only: never a password, a
 * session id, a token, a key or a recovery secret.
 */
export interface VaultAccountAuditEntry {
  /** ISO time. */
  at: string;
  action: VaultAccountAction;
  /**
   * `denied`: refused before any relay call. `authorized`: both checks
   * passed, written before the relay call. `succeeded` / `failed`: the relay
   * call's outcome.
   */
  outcome: 'denied' | 'authorized' | 'succeeded' | 'failed';
  /** The caller's user id; null when there was no usable session. */
  actorUserId: string | null;
  tenantId: string | null;
  oldAccountId?: string;
  newAccountId?: string;
  deviceId?: string;
  /** Set when `outcome` is `denied`. */
  denial?: VaultAccountDenial;
  /** Set when `outcome` is `failed`: an error name or code, never a message. */
  errorCode?: string;
  /** The relay's result word, when the call returned one. */
  result?: string;
}

export interface VaultAccountAuditSink {
  record(entry: VaultAccountAuditEntry): void | Promise<void>;
}

/** Collaborators and policy shared by every gated action. */
export interface VaultAccountAdminDeps {
  relay: VaultRelayAdminPort;
  directory: VaultAccountDirectory;
  audit: VaultAccountAuditSink;
  /**
   * Longest age of the owner's last authentication, in seconds. Default 300
   * (5 minutes); at most one hour.
   */
  stepUpMaxAgeSeconds?: number;
  /**
   * Replaces the default owner test (`isTenantOwnerSession`) for hosts with a
   * custom owner role. It must still refuse device-only and layered sessions.
   */
  isOwner?: (session: StepUpSession) => boolean;
  /** Clock, injectable for tests. */
  now?: () => Date;
}

export interface SupersedeVaultAccountInput extends VaultAccountAdminDeps {
  /** The caller's session context, from `SessionService.loadSessionContext`. */
  session: StepUpSession | null | undefined;
  oldAccount: string;
  newAccount: string;
}

export interface UnsupersedeVaultAccountInput extends VaultAccountAdminDeps {
  session: StepUpSession | null | undefined;
  oldAccount: string;
}

export interface ProvisionRestartAccountInput extends VaultAccountAdminDeps {
  session: StepUpSession | null | undefined;
  /** The account being replaced; must belong to the caller's tenant. */
  oldAccount: string;
  /** The working device's relay signing key id. */
  deviceId: string;
  /** Its raw Ed25519 public key, base64url. */
  devicePublicKey: string;
  /** Mints the new account id. Default `crypto.randomUUID()`. */
  newAccountId?: () => string | Promise<string>;
}

export interface ProvisionRestartAccountResult {
  /** The new vault account, linked to the caller's tenant. */
  accountId: string;
  deviceId: string;
  /** `registered` the first time, `unchanged` on a retry. */
  device: 'registered' | 'unchanged';
}
