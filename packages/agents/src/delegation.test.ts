/**
 * Delegation envelope — the immutable principal + bounded depth carried along an
 * agent-orchestration chain (#1892).
 *
 * Pure value-object logic (no DB): proves the two invariants the orchestration
 * chain relies on — the principal cannot be widened, and delegation depth is
 * bounded.
 */

import { describe, expect, it } from 'vitest';
import {
  assertPrincipalNotWidened,
  DelegationDepthExceededError,
  type DelegationEnvelope,
  deriveDelegationEnvelope,
  MAX_DELEGATION_DEPTH,
  PrincipalWideningError,
  rootDelegationEnvelope,
} from './delegation.js';

describe('rootDelegationEnvelope', () => {
  it('seeds a depth-0 envelope for the orchestrator', () => {
    const root = rootDelegationEnvelope({
      runAsUserId: 'user-1',
      tenantId: 'tenant-1',
      onBehalfOfUserId: 'user-1',
      correlationId: 'corr-1',
      allowedTools: ['agents.invoke'],
    });
    expect(root).toEqual({
      runAsUserId: 'user-1',
      tenantId: 'tenant-1',
      onBehalfOfUserId: 'user-1',
      depth: 0,
      correlationId: 'corr-1',
      allowedTools: ['agents.invoke'],
    });
  });

  it('defaults onBehalfOfUserId to the run-as user and generates a correlation id', () => {
    const root = rootDelegationEnvelope({
      runAsUserId: 'user-1',
      tenantId: null,
    });
    expect(root.onBehalfOfUserId).toBe('user-1');
    expect(root.depth).toBe(0);
    expect(root.correlationId).toBeTruthy();
  });
});

describe('deriveDelegationEnvelope', () => {
  const parent: DelegationEnvelope = {
    runAsUserId: 'origin-user',
    tenantId: 'tenant-1',
    onBehalfOfUserId: 'origin-user',
    depth: 0,
    correlationId: 'corr-parent',
    allowedTools: ['agents.invoke', 'notes.read'],
  };

  it('inherits the parent principal verbatim and increments the depth', () => {
    const child = deriveDelegationEnvelope(parent, {
      correlationId: 'corr-child',
      allowedTools: ['notes.create'],
    });
    // Principal is immutable — copied verbatim.
    expect(child.runAsUserId).toBe('origin-user');
    expect(child.tenantId).toBe('tenant-1');
    expect(child.onBehalfOfUserId).toBe('origin-user');
    // Depth advances by one; correlation + tools are the child's.
    expect(child.depth).toBe(1);
    expect(child.correlationId).toBe('corr-child');
    expect(child.allowedTools).toEqual(['notes.create']);
  });

  it('does not inherit the parent tools implicitly (fail-closed)', () => {
    const child = deriveDelegationEnvelope(parent, { correlationId: 'c' });
    expect(child.allowedTools).toBeUndefined();
  });

  it('bounds delegation depth', () => {
    // Walk the chain up to the ceiling, then one past it.
    let current = parent;
    for (let i = 0; i < MAX_DELEGATION_DEPTH; i += 1) {
      current = deriveDelegationEnvelope(current, { correlationId: `c-${i}` });
    }
    expect(current.depth).toBe(MAX_DELEGATION_DEPTH);
    expect(() =>
      deriveDelegationEnvelope(current, { correlationId: 'too-deep' }),
    ).toThrow(DelegationDepthExceededError);
  });

  it('a worker cannot widen the principal when it requests a different one', () => {
    const workerEnvelope: DelegationEnvelope = { ...parent, depth: 1 };
    expect(() =>
      deriveDelegationEnvelope(workerEnvelope, {
        correlationId: 'c',
        requestedPrincipal: { runAsUserId: 'admin-user' },
      }),
    ).toThrow(PrincipalWideningError);
    expect(() =>
      deriveDelegationEnvelope(workerEnvelope, {
        correlationId: 'c',
        requestedPrincipal: { tenantId: 'other-tenant' },
      }),
    ).toThrow(PrincipalWideningError);
    expect(() =>
      deriveDelegationEnvelope(workerEnvelope, {
        correlationId: 'c',
        requestedPrincipal: { onBehalfOfUserId: 'someone-else' },
      }),
    ).toThrow(PrincipalWideningError);
  });

  it('accepts a requested principal that matches the parent (no widening)', () => {
    const child = deriveDelegationEnvelope(parent, {
      correlationId: 'c',
      requestedPrincipal: {
        runAsUserId: 'origin-user',
        tenantId: 'tenant-1',
        onBehalfOfUserId: 'origin-user',
      },
    });
    expect(child.runAsUserId).toBe('origin-user');
    expect(child.depth).toBe(1);
  });
});

describe('assertPrincipalNotWidened', () => {
  const parent = {
    runAsUserId: 'u',
    tenantId: 't',
    onBehalfOfUserId: 'u',
  };

  it('allows omitted fields (they inherit)', () => {
    expect(() => assertPrincipalNotWidened(parent, {})).not.toThrow();
  });

  it('allows exactly-matching fields', () => {
    expect(() =>
      assertPrincipalNotWidened(parent, {
        runAsUserId: 'u',
        tenantId: 't',
        onBehalfOfUserId: 'u',
      }),
    ).not.toThrow();
  });

  it('rejects any changed principal field', () => {
    expect(() =>
      assertPrincipalNotWidened(parent, { runAsUserId: 'other' }),
    ).toThrow(PrincipalWideningError);
  });
});
