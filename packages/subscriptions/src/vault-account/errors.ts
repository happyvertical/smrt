import { StepUpRequiredError } from '@happyvertical/smrt-users/step-up';

export { StepUpRequiredError };

/** Stable machine code of {@link NotOwnerError}. */
export const NOT_OWNER_CODE = 'not_owner';

/**
 * The caller is not the owner of the tenant that holds the account: a member,
 * a device-only or layered session, no session, or another tenant's account.
 * One message and code for all of them, so nothing about the account or the
 * tenant leaks.
 */
export class NotOwnerError extends Error {
  readonly code = NOT_OWNER_CODE;

  constructor(message = 'Only the account owner may do this.') {
    super(message);
    this.name = 'NotOwnerError';
  }
}

/** A refusal after both checks passed (the relay or directory said no). */
export class VaultAccountAdminError extends Error {
  readonly code: string;

  constructor(code: string, message = 'The vault account action failed.') {
    super(message);
    this.name = 'VaultAccountAdminError';
    this.code = code;
  }
}
