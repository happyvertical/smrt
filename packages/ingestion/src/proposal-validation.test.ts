import { describe, expect, it } from 'vitest';
import type { GenerationLimits } from './proposal-contracts.js';
import {
  PROPOSAL_REASON_LIMIT,
  ProposalValidationError,
  validateSuggestions,
} from './proposal-validation.js';

const limits: GenerationLimits = {
  maxHandlers: 5,
  maxCandidates: 5,
  maxSuggestions: 5,
  maxInputBytes: 10000,
  maxOutputBytes: 10000,
  maxQueryLength: 1000,
  timeoutMs: 1000,
};
function failure(raw: unknown): ProposalValidationError {
  try {
    validateSuggestions(raw, [], [], limits, 1);
  } catch (error) {
    if (error instanceof ProposalValidationError) return error;
    throw error;
  }
  throw new Error('Expected validation to fail');
}

describe('proposal validator reasons', () => {
  it('names schema violations by path and keyword without quoting values (#4207)', () => {
    const reply = JSON.parse(
      '{"outcome":"accept","suggestions":[{"handlerId":"h","handlerVersion":"1","args":{},"explanation":"x"}]}',
    );
    const error = failure(reply);
    expect(error.message).toBe('Invalid generated proposals');
    expect(error.reason).toContain(
      '/outcome enum (allowedValues=proposals|unknown|ambiguous|no_action|needs_review)',
    );
    for (const property of ['evidence', 'alternatives', 'missingFields'])
      expect(error.reason).toContain(
        `/suggestions/0 required (missingProperty=${property})`,
      );
    expect(error.reason).toContain('/ required (missingProperty=splits)');
    expect(error.reason).not.toContain('accept');
    expect(error.reason).not.toMatch(/"x"|explanation=|"h"/);
    expect(error.reason.length).toBeLessThanOrEqual(PROPOSAL_REASON_LIMIT);
  });
  it('describes a string location and extra keys without document text', () => {
    const error = failure({
      outcome: 'proposals',
      suggestions: [
        {
          handlerId: 'h',
          handlerVersion: '1',
          args: {},
          evidence: [{ evidenceId: 'e', location: 'page 3 of the invoice' }],
          alternatives: [],
          missingFields: [],
          explanation: 'Vendor ACME invoice 1234',
          'vendor name': 'ACME',
        },
      ],
      splits: [],
    });
    expect(error.reason).toContain('/suggestions/0/evidence/0/location type');
    expect(error.reason).toContain('additionalProperty=?');
    expect(error.reason).not.toMatch(/ACME|invoice/);
  });
  it('bounds the recorded reason', () => {
    const error = failure({
      outcome: 'proposals',
      suggestions: Array.from({ length: 5 }, () => ({ bogus: true })),
      splits: [],
    });
    expect(error.reason).toMatch(/\+\d+ more$/);
    expect(error.reason.length).toBeLessThanOrEqual(PROPOSAL_REASON_LIMIT);
  });
  it('reports internal checks by path only', () => {
    const error = failure({
      outcome: 'proposals',
      suggestions: [
        {
          handlerId: 'h',
          handlerVersion: '1',
          args: { secret: 'document text' },
          evidence: [{ evidenceId: 'e', location: { kind: 'source' } }],
          alternatives: [],
          missingFields: [],
          explanation: 'x',
        },
      ],
      splits: [],
    });
    expect(error.reason).toBe('Unoffered handler: /suggestions/0');
  });
});
