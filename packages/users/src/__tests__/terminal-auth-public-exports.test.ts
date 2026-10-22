import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PASSKEY_MANAGE_PERMISSION,
  DEFAULT_PASSWORD_MANAGE_PERMISSION,
  DeviceCredentialService,
  LoginAttemptLimiter,
  PASSKEY_LOGIN_KIND,
  PASSWORD_LOGIN_KIND,
  PasskeyCredentialService,
  PasswordCredentialService,
  UsersCliAuthApproveLimit,
  UsersCliAuthApproveLimitCollection,
  UsersLoginAttempt,
  UsersLoginAttemptCollection,
  UsersLoginAuditEvent,
  UsersLoginAuditEventCollection,
  UsersPasskeyChallenge,
  UsersPasskeyChallengeCollection,
  UsersPasskeyCredential,
  UsersPasskeyCredentialCollection,
  UsersPasswordCredential,
  UsersPasswordCredentialCollection,
  UsersPinCredential,
  UsersPinCredentialCollection,
} from '../index.js';

describe('terminal auth public exports', () => {
  it('exports every approval-limit class advertised by the package manifest', () => {
    // Deprecated since #3273 but still part of the manifest and schema.
    expect(UsersCliAuthApproveLimit).toBeTypeOf('function');
    expect(UsersCliAuthApproveLimitCollection).toBeTypeOf('function');
  });

  it('exports the login limiter, audit, and PIN classes (#3273, #3276)', () => {
    expect(LoginAttemptLimiter).toBeTypeOf('function');
    expect(UsersLoginAttempt).toBeTypeOf('function');
    expect(UsersLoginAttemptCollection).toBeTypeOf('function');
    expect(UsersLoginAuditEvent).toBeTypeOf('function');
    expect(UsersLoginAuditEventCollection).toBeTypeOf('function');
    expect(DeviceCredentialService).toBeTypeOf('function');
    expect(UsersPinCredential).toBeTypeOf('function');
    expect(UsersPinCredentialCollection).toBeTypeOf('function');
  });

  it('exports the password credential classes and constants (#3274)', async () => {
    expect(PasswordCredentialService).toBeTypeOf('function');
    expect(UsersPasswordCredential).toBeTypeOf('function');
    expect(UsersPasswordCredentialCollection).toBeTypeOf('function');
    expect(DEFAULT_PASSWORD_MANAGE_PERMISSION).toBe('users.password.manage');
    expect(PASSWORD_LOGIN_KIND).toBe('password');
    const sveltekit = await import('../sveltekit/index.js');
    expect(sveltekit.createPasswordCredentialHandlers).toBeTypeOf('function');
  });

  it('exports the passkey credential classes and constants (#3275)', async () => {
    expect(PasskeyCredentialService).toBeTypeOf('function');
    expect(UsersPasskeyCredential).toBeTypeOf('function');
    expect(UsersPasskeyCredentialCollection).toBeTypeOf('function');
    expect(UsersPasskeyChallenge).toBeTypeOf('function');
    expect(UsersPasskeyChallengeCollection).toBeTypeOf('function');
    expect(DEFAULT_PASSKEY_MANAGE_PERMISSION).toBe('users.passkey.manage');
    expect(PASSKEY_LOGIN_KIND).toBe('passkey');
    const sveltekit = await import('../sveltekit/index.js');
    expect(sveltekit.createPasskeyCredentialHandlers).toBeTypeOf('function');
  });
});
