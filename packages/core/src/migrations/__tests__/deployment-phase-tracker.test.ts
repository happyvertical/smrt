import type { DatabaseInterface } from '@happyvertical/sql';
import { describe, expect, it, vi } from 'vitest';
import { DeploymentPhaseTracker } from '../deployment-phase-tracker.js';

describe('deployment phase adapter boundary', () => {
  it('fails closed for other dialects even when a session API exists', () => {
    const acquireSession = vi.fn();
    expect(
      () =>
        new DeploymentPhaseTracker({
          url: 'sqlite::memory:',
          acquireSession,
        } as unknown as DatabaseInterface),
    ).toThrow('require PostgreSQL');
    expect(acquireSession).not.toHaveBeenCalled();
  });
  it('fails closed when PostgreSQL cannot pin a connection', () => {
    expect(
      () =>
        new DeploymentPhaseTracker({
          url: 'postgres://localhost/test',
        } as DatabaseInterface),
    ).toThrow('require PostgreSQL');
  });
});
