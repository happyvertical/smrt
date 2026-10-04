import { describe, expect, it } from 'vitest';

import {
  DeviceCredentialService,
  LoginAttemptLimiter,
  UsersCliAuthApproveLimit,
  UsersCliAuthApproveLimitCollection,
  UsersLoginAttempt,
  UsersLoginAttemptCollection,
  UsersLoginAuditEvent,
  UsersLoginAuditEventCollection,
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
});
