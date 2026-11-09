/**
 * Hosted vault-account admin actions (#4841): replace (supersede), un-replace
 * and provision the replacement of a family's vault account.
 *
 * The relay's admin token can silence or redirect any account, and the local
 * restart calls cannot tell the owner from someone holding an unlocked
 * device, so this layer is the only gate on a takeover of the backup line.
 * Each action therefore, in order:
 *
 * 1. requires the caller to be the tenant OWNER on a first-class session
 *    (`not_owner` otherwise: a member, a device-only session, no session, or
 *    an account of another tenant),
 * 2. requires a step-up: the owner proved a password or passkey on the
 *    hosted account within `stepUpMaxAgeSeconds` (`step_up_required`),
 * 3. records `authorized` in the audit sink, and only then
 * 4. calls the relay, exactly once, and records the outcome.
 *
 * A refusal is audited (`denied`, with the reason code) and throws; the relay
 * is never called. Nothing here reads a request, a cookie or a secret.
 */
import {
  DEFAULT_STEP_UP_MAX_AGE_SECONDS,
  isTenantOwnerSession,
  requireRecentAuthentication,
  type StepUpSession,
} from '@happyvertical/smrt-users/step-up';
import {
  NotOwnerError,
  StepUpRequiredError,
  VaultAccountAdminError,
} from './errors.js';
import type {
  ProvisionRestartAccountInput,
  ProvisionRestartAccountResult,
  SupersedeVaultAccountInput,
  UnsupersedeVaultAccountInput,
  VaultAccountAction,
  VaultAccountAdminDeps,
  VaultAccountAuditEntry,
} from './types.js';

/** The relay's account and device id grammar. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

type Subject = Pick<
  VaultAccountAuditEntry,
  'oldAccountId' | 'newAccountId' | 'deviceId'
>;

function errorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[\w.:-]{1,64}$/.test(code)) return code;
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string') return name.slice(0, 64);
  }
  return 'unknown';
}

class Gate {
  private readonly now: () => Date;

  constructor(
    private readonly deps: VaultAccountAdminDeps,
    private readonly action: VaultAccountAction,
    private readonly session: StepUpSession | null | undefined,
    private readonly subject: Subject,
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  private entry(
    outcome: VaultAccountAuditEntry['outcome'],
    extra: Partial<VaultAccountAuditEntry> = {},
  ): VaultAccountAuditEntry {
    const entry: VaultAccountAuditEntry = {
      at: this.now().toISOString(),
      action: this.action,
      outcome,
      actorUserId: this.session?.user?.id ?? null,
      tenantId: this.session?.tenantId ?? null,
      ...extra,
    };
    for (const [key, value] of Object.entries(this.subject)) {
      if (typeof value === 'string') {
        (entry as unknown as Record<string, unknown>)[key] = value;
      }
    }
    return entry;
  }

  private async deny(
    error: NotOwnerError | StepUpRequiredError,
  ): Promise<never> {
    // A broken sink never turns a refusal into anything else.
    await this.recordQuietly(this.entry('denied', { denial: error.code }));
    throw error;
  }

  /**
   * Run both checks, then the audit-before-act record. Throws
   * {@link NotOwnerError} or {@link StepUpRequiredError}; resolves with the
   * verified tenant id.
   */
  async authorize(
    accounts: readonly string[],
    validate?: () => void | Promise<void>,
  ): Promise<string> {
    const session = this.session;
    const isOwner = this.deps.isOwner ?? isTenantOwnerSession;
    let owner = false;
    try {
      owner = Boolean(session && isOwner(session));
    } catch {
      owner = false;
    }
    if (!session || !owner || !session.tenantId || !session.user?.id) {
      return this.deny(new NotOwnerError());
    }
    const tenantId = session.tenantId;
    const userId = session.user.id;

    // The accounts must be this tenant's: an owner of one tenant never moves
    // another's. Unknown and foreign accounts are refused alike.
    for (const accountId of accounts) {
      let owningTenant: string | null = null;
      if (IDENTIFIER.test(accountId)) {
        try {
          owningTenant = await this.deps.directory.tenantForAccount(accountId);
        } catch {
          owningTenant = null;
        }
      }
      if (owningTenant !== tenantId) return this.deny(new NotOwnerError());
    }

    try {
      requireRecentAuthentication(session, {
        maxAgeSeconds:
          this.deps.stepUpMaxAgeSeconds ?? DEFAULT_STEP_UP_MAX_AGE_SECONDS,
        now: this.now,
        expectedSessionId: session.sessionId,
        expectedUserId: userId,
      });
    } catch {
      return this.deny(new StepUpRequiredError());
    }

    // Malformed input from an authorized caller: refused, not audited as
    // authorized, and still before any relay call.
    await validate?.();

    // Audit before acting: if the record cannot be written, nothing happens.
    try {
      await this.deps.audit.record(this.entry('authorized'));
    } catch {
      throw new VaultAccountAdminError(
        'audit_unavailable',
        'The action could not be recorded, so it was not performed.',
      );
    }
    return tenantId;
  }

  /** Record the relay call's outcome; a sink failure never undoes the call. */
  async finish(
    outcome: 'succeeded' | 'failed',
    extra: Partial<VaultAccountAuditEntry> = {},
  ): Promise<void> {
    await this.recordQuietly(this.entry(outcome, extra));
  }

  private async recordQuietly(entry: VaultAccountAuditEntry): Promise<void> {
    try {
      await this.deps.audit.record(entry);
    } catch {
      // Observability only: never changes what the caller is told or does.
    }
  }

  /** Run the single relay call and audit its outcome. */
  async perform<T extends string | boolean>(
    call: () => Promise<T>,
    update: Partial<VaultAccountAuditEntry> = {},
  ): Promise<T> {
    let result: T;
    try {
      result = await call();
    } catch (error) {
      await this.finish('failed', { ...update, errorCode: errorCode(error) });
      throw error;
    }
    await this.finish('succeeded', { ...update, result: String(result) });
    return result;
  }
}

function invalid(field: string): VaultAccountAdminError {
  return new VaultAccountAdminError(
    'invalid_request',
    `Invalid request: ${field}.`,
  );
}

/**
 * Replace `oldAccount` by `newAccount` (relay admin `PUT
 * .../superseded-by`). The new account must already hold an active device
 * (see {@link provisionRestartAccount}); the relay enforces that, and no
 * chains or loops. Idempotent for the same target.
 */
export async function supersedeVaultAccount(
  input: SupersedeVaultAccountInput,
): Promise<'superseded' | 'unchanged'> {
  const { oldAccount, newAccount } = input;
  const gate = new Gate(input, 'supersede', input.session, {
    oldAccountId: oldAccount,
    newAccountId: newAccount,
  });
  await gate.authorize([oldAccount, newAccount], () => {
    if (oldAccount === newAccount) throw invalid('newAccount');
  });
  return gate.perform(() =>
    input.relay.supersedeAccount(oldAccount, newAccount),
  );
}

/**
 * Undo a supersession (relay admin `DELETE .../superseded-by`), for an
 * operator mistake or a restart that never reached the working device. Returns
 * false when `oldAccount` was not superseded.
 */
export async function unsupersedeVaultAccount(
  input: UnsupersedeVaultAccountInput,
): Promise<boolean> {
  const { oldAccount } = input;
  const gate = new Gate(input, 'unsupersede', input.session, {
    oldAccountId: oldAccount,
  });
  await gate.authorize([oldAccount]);
  return gate.perform(() => input.relay.clearSupersession(oldAccount));
}

/**
 * Step 1 of the restart flow (app-runtime README, "Restarting when the
 * recovery secret is lost"), before the supersede: allocate a fresh vault
 * account id, link it to the caller's tenant (so `backup.vault` resolves for
 * it), and register the working device's relay signing key in it (relay admin
 * `PUT .../devices/:device`). The id is minted per call, so a retry after a
 * crash makes another empty account unless `newAccountId` is pinned.
 */
export async function provisionRestartAccount(
  input: ProvisionRestartAccountInput,
): Promise<ProvisionRestartAccountResult> {
  const { oldAccount, deviceId, devicePublicKey } = input;
  const subject: Subject = { oldAccountId: oldAccount, deviceId };
  const gate = new Gate(
    input,
    'provision_restart_account',
    input.session,
    subject,
  );
  let accountId = '';
  const tenantId = await gate.authorize([oldAccount], async () => {
    if (!IDENTIFIER.test(deviceId)) throw invalid('deviceId');
    if (typeof devicePublicKey !== 'string' || !devicePublicKey) {
      throw invalid('devicePublicKey');
    }
    accountId = await (input.newAccountId ?? (() => crypto.randomUUID()))();
    if (!IDENTIFIER.test(accountId) || accountId === oldAccount) {
      throw invalid('newAccountId');
    }
    subject.newAccountId = accountId;
  });
  const device = await gate.perform(async () => {
    await input.directory.linkAccount(tenantId, accountId);
    const registered = await input.relay.registerDevice(
      accountId,
      deviceId,
      devicePublicKey,
    );
    if (registered === 'conflict') {
      throw new VaultAccountAdminError('device_conflict');
    }
    return registered;
  });
  return { accountId, deviceId, device };
}
