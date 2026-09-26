import { describe, expect, it } from 'vitest';
import { decisionClaimSupportFixtures } from './fixtures/decision-claim-support-3166';

describe('decision claim-support research fixtures (#3166)', () => {
  it('keeps expected attribution inside each offered candidate closure', () => {
    for (const fixture of decisionClaimSupportFixtures) {
      const factIds = new Set(
        fixture.candidates
          .map((candidate) => candidate.id)
          .filter((id): id is string => typeof id === 'string'),
      );
      const evidenceToFactId = new Map<string, string>();

      for (const candidate of fixture.candidates) {
        if (!candidate.id) {
          continue;
        }
        for (const evidence of candidate.evidence || []) {
          if (evidence.id) {
            evidenceToFactId.set(evidence.id, candidate.id);
          }
        }
      }

      const supportingFactIds = new Set(fixture.expectedSupportingFactIds);
      const contradictingFactIds = new Set(
        fixture.expectedContradictingFactIds,
      );

      for (const factId of [
        ...fixture.expectedSupportingFactIds,
        ...fixture.expectedContradictingFactIds,
      ]) {
        expect(factIds, fixture.id).toContain(factId);
      }

      for (const evidenceId of fixture.expectedSupportingEvidenceIds) {
        expect(supportingFactIds, fixture.id).toContain(
          evidenceToFactId.get(evidenceId),
        );
      }

      for (const evidenceId of fixture.expectedContradictingEvidenceIds) {
        expect(contradictingFactIds, fixture.id).toContain(
          evidenceToFactId.get(evidenceId),
        );
      }
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
        expect(fixture.rationaleConstraint, fixture.id).toBe('candidate_scope');
      }
    }
  });
});
