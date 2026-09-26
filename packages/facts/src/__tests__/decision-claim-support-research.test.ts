import { describe, expect, it } from 'vitest';
import {
  type DecisionClaimSupportFixture,
  decisionClaimSupportFixtures,
  invalidDecisionClaimSupportResponseFixture,
} from './fixtures/decision-claim-support-3166';

type SelectionError =
  | 'unknown_fact'
  | 'unknown_evidence'
  | 'evidence_fact_mismatch';

interface CandidateClosure {
  factIds: Set<string>;
  evidenceToFactId: Map<string, string>;
}

function candidateClosure(
  fixture: Pick<DecisionClaimSupportFixture, 'candidates'>,
): CandidateClosure {
  const factIds = new Set<string>();
  const evidenceToFactId = new Map<string, string>();

  for (const candidate of fixture.candidates) {
    if (!candidate.id) {
      continue;
    }
    factIds.add(candidate.id);
    for (const evidence of candidate.evidence || []) {
      if (evidence.id) {
        evidenceToFactId.set(evidence.id, candidate.id);
      }
    }
  }

  return { factIds, evidenceToFactId };
}

function validateSelection(
  closure: CandidateClosure,
  selection: {
    supportingFactIds: string[];
    supportingEvidenceIds: string[];
    contradictingFactIds: string[];
    contradictingEvidenceIds: string[];
  },
): SelectionError[] {
  const errors = new Set<SelectionError>();

  const selections = [
    {
      factIds: selection.supportingFactIds,
      evidenceIds: selection.supportingEvidenceIds,
    },
    {
      factIds: selection.contradictingFactIds,
      evidenceIds: selection.contradictingEvidenceIds,
    },
  ];

  for (const { evidenceIds, factIds } of selections) {
    const factIdSet = new Set(factIds);

    for (const factId of factIds) {
      if (!closure.factIds.has(factId)) {
        errors.add('unknown_fact');
      }
    }

    for (const evidenceId of evidenceIds) {
      const ownerFactId = closure.evidenceToFactId.get(evidenceId);
      if (!ownerFactId) {
        errors.add('unknown_evidence');
      } else if (!factIdSet.has(ownerFactId)) {
        errors.add('evidence_fact_mismatch');
      }
    }
  }

  return [...errors];
}

function normalizedStatus(
  rawStatus: DecisionClaimSupportFixture['expectedStatus'],
  errors: SelectionError[],
): DecisionClaimSupportFixture['expectedStatus'] {
  return errors.length > 0 ? 'needs_review' : rawStatus;
}

describe('decision claim-support research fixtures (#3166)', () => {
  it('keeps expected attribution inside each offered candidate closure', () => {
    for (const fixture of decisionClaimSupportFixtures) {
      const closure = candidateClosure(fixture);
      const errors = validateSelection(closure, {
        supportingFactIds: fixture.expectedSupportingFactIds,
        supportingEvidenceIds: fixture.expectedSupportingEvidenceIds,
        contradictingFactIds: fixture.expectedContradictingFactIds,
        contradictingEvidenceIds: fixture.expectedContradictingEvidenceIds,
      });

      expect(errors, fixture.id).toEqual([]);
    }
  });

  it('keeps status labels consistent with role-specific attribution', () => {
    for (const fixture of decisionClaimSupportFixtures) {
      const hasSupport =
        fixture.expectedSupportingFactIds.length > 0 ||
        fixture.expectedSupportingEvidenceIds.length > 0;
      const hasContradiction =
        fixture.expectedContradictingFactIds.length > 0 ||
        fixture.expectedContradictingEvidenceIds.length > 0;

      if (fixture.expectedStatus === 'supported') {
        expect(hasSupport, fixture.id).toBe(true);
        expect(hasContradiction, fixture.id).toBe(false);
      }
      if (fixture.expectedStatus === 'contradicted') {
        expect(hasSupport, fixture.id).toBe(false);
        expect(hasContradiction, fixture.id).toBe(true);
      }
      if (fixture.expectedStatus === 'unsupported') {
        expect(hasSupport, fixture.id).toBe(false);
        expect(hasContradiction, fixture.id).toBe(false);
        expect(fixture.rationaleConstraint.kind, fixture.id).toBe(
          'candidate_scope',
        );
      }
    }
  });

  it('exercises each declared rationale constraint with its fixture example', () => {
    const encounteredKinds = new Set<string>();

    for (const fixture of decisionClaimSupportFixtures) {
      const { example, kind, requiredTerms } = fixture.rationaleConstraint;
      encounteredKinds.add(kind);

      expect(example.trim(), fixture.id).not.toBe('');
      expect(requiredTerms.length, fixture.id).toBeGreaterThan(0);
      for (const term of requiredTerms) {
        expect(example.toLowerCase(), fixture.id).toContain(term.toLowerCase());
      }
    }

    expect(encounteredKinds).toEqual(
      new Set([
        'candidate_scope',
        'grounded',
        'missing_portion',
        'empty_claim',
      ]),
    );
  });

  it('normalizes malformed raw attribution to needs_review', () => {
    const fixture = invalidDecisionClaimSupportResponseFixture;
    const errors = validateSelection(
      candidateClosure(fixture),
      fixture.rawResponse,
    );

    expect(errors).toEqual(expect.arrayContaining(fixture.expectedErrors));
    expect(normalizedStatus(fixture.rawResponse.status, errors)).toBe(
      fixture.expectedNormalizedStatus,
    );
  });
});
