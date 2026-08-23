import { describe, expect, it } from 'vitest';

import {
  UsersCliAuthApproveLimit,
  UsersCliAuthApproveLimitCollection,
} from '../index.js';

describe('terminal auth public exports', () => {
  it('exports every approval-limit class advertised by the package manifest', () => {
    expect(UsersCliAuthApproveLimit).toBeTypeOf('function');
    expect(UsersCliAuthApproveLimitCollection).toBeTypeOf('function');
  });
});
