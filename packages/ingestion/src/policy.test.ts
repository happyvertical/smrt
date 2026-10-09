import { describe, expect, it } from 'vitest';
import { resolveIntakePolicy } from './policy.js';

describe('trusted ingestion policy', () => {
  it('intersects ceilings, minimizes budgets and preserves every review requirement', () => {
    const policy = resolveIntakePolicy([
      {
        version: 'app',
        handlers: ['a', 'b'],
        operations: ['create'],
        reviewers: ['owner', 'delegate'],
        access: ['private'],
        maxAttempts: 3,
        maxSteps: 5,
        minimumCertainty: 0.8,
      },
      {
        version: 'tenant',
        handlers: ['a', 'forged'],
        maxAttempts: 2,
        minimumCertainty: 0.9,
        requireReview: true,
      },
      {
        version: 'source',
        handlers: ['a', 'b'],
        reviewers: ['delegate'],
        maxAttempts: 5,
      },
      { version: 'request', maxSteps: 2, requireReview: false },
    ]);
    expect(policy).toMatchObject({
      handlers: ['a'],
      operations: ['create'],
      reviewers: ['delegate'],
      access: ['private'],
      maxAttempts: 2,
      maxSteps: 2,
      minimumCertainty: 0.9,
      requireReview: true,
      automaticHandlers: [],
    });
  });
  it('denies disabled layers and requires explicit automation opt-in at every authority layer', () => {
    const automation = {
      handlers: ['draft'],
      evaluationVersion: 'evaluated-v1',
      consequential: true,
    };
    expect(
      resolveIntakePolicy([
        { version: 'app', automation },
        { version: 'tenant', automation },
        { version: 'source' },
      ]).automaticHandlers,
    ).toEqual([]);
    expect(
      resolveIntakePolicy([
        { version: 'app', automation },
        { version: 'tenant', automation, enabled: false },
        { version: 'source', automation },
      ]).enabled,
    ).toBe(false);
    expect(
      resolveIntakePolicy([
        { version: 'app', automation },
        { version: 'tenant', automation },
        {
          version: 'source',
          automation: { ...automation, consequential: false },
        },
      ]),
    ).toMatchObject({
      automaticHandlers: ['draft'],
      consequentialAutomation: false,
    });
  });
  it('rejects missing policy identity, unbounded budgets and malformed confidence', () => {
    for (const bad of [
      { version: '' },
      { version: 'bad', maxAttempts: 0 },
      { version: 'bad', maxBytes: Infinity },
      { version: 'bad', minimumCertainty: NaN },
    ]) {
      expect(() =>
        resolveIntakePolicy([{ version: 'app' }, { version: 'tenant' }, bad]),
      ).toThrow();
    }
    expect(() => resolveIntakePolicy([{ version: 'app' }])).toThrow();
  });
});
