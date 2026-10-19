import { describe, expect, it } from 'vitest';
import { proposalInstructions } from './proposals.js';

describe('proposal instructions', () => {
  it('states every validator-required transport rule without contradicting it', () => {
    expect(proposalInstructions).toContain('all required top-level keys');
    expect(proposalInstructions).toContain('Always include splits');
    expect(proposalInstructions).toContain('must never contain segments');
    expect(proposalInstructions).toContain('exact offered key');
    expect(proposalInstructions).not.toContain('Splits are optional');
  });
});
