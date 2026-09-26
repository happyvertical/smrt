import type {
  FactClaimSupportCandidate,
  FactClaimSupportStatus,
} from '../../types';

export interface RationaleConstraint {
  kind: 'candidate_scope' | 'grounded' | 'missing_portion' | 'empty_claim';
  example: string;
  requiredTerms: string[];
}

export interface DecisionClaimSupportFixture {
  id:
    | 'direct-support'
    | 'candidate-miss'
    | 'combined-support'
    | 'direct-contradiction'
    | 'conflicting-sources'
    | 'partial-support'
    | 'empty-candidates'
    | 'empty-claim';
  claim: string;
  candidates: FactClaimSupportCandidate[];
  expectedStatus: FactClaimSupportStatus;
  expectedSupportingFactIds: string[];
  expectedSupportingEvidenceIds: string[];
  expectedContradictingFactIds: string[];
  expectedContradictingEvidenceIds: string[];
  rationaleConstraint: RationaleConstraint;
}

export interface InvalidDecisionClaimSupportResponseFixture {
  claim: string;
  candidates: FactClaimSupportCandidate[];
  rawResponse: {
    status: FactClaimSupportStatus;
    supportingFactIds: string[];
    supportingEvidenceIds: string[];
    contradictingFactIds: string[];
    contradictingEvidenceIds: string[];
  };
  expectedNormalizedStatus: 'needs_review';
  expectedErrors: Array<'unknown_fact' | 'evidence_fact_mismatch'>;
}

export const decisionClaimSupportFixtures: DecisionClaimSupportFixture[] = [
  {
    id: 'direct-support',
    claim: 'Council approved Bylaw 10.',
    candidates: [
      {
        id: 'f-approve',
        statement: 'Council approved Bylaw 10.',
        evidence: [{ id: 'e-minutes', quote: 'Bylaw 10 was approved.' }],
      },
    ],
    expectedStatus: 'supported',
    expectedSupportingFactIds: ['f-approve'],
    expectedSupportingEvidenceIds: ['e-minutes'],
    expectedContradictingFactIds: [],
    expectedContradictingEvidenceIds: [],
    rationaleConstraint: {
      kind: 'grounded',
      example: 'The offered minutes state that Council approved Bylaw 10.',
      requiredTerms: ['offered', 'approved'],
    },
  },
  {
    id: 'candidate-miss',
    claim: 'Council approved Bylaw 10.',
    candidates: [
      {
        id: 'f-hearing',
        statement: 'Council held a hearing for Bylaw 10.',
        evidence: [{ id: 'e-hearing', quote: 'Public hearing for Bylaw 10.' }],
      },
    ],
    expectedStatus: 'unsupported',
    expectedSupportingFactIds: [],
    expectedSupportingEvidenceIds: [],
    expectedContradictingFactIds: [],
    expectedContradictingEvidenceIds: [],
    rationaleConstraint: {
      kind: 'candidate_scope',
      example: 'The offered candidates do not support the approval claim.',
      requiredTerms: ['offered', 'do not support'],
    },
  },
  {
    id: 'combined-support',
    claim: 'The bridge reopened on March 1 after inspection.',
    candidates: [
      {
        id: 'f-reopen',
        statement: 'The bridge reopened on March 1.',
        evidence: [{ id: 'e-reopen', quote: 'Bridge reopened March 1.' }],
      },
      {
        id: 'f-inspection',
        statement: 'The bridge passed inspection before reopening.',
        evidence: [{ id: 'e-inspection', quote: 'Inspection passed.' }],
      },
    ],
    expectedStatus: 'supported',
    expectedSupportingFactIds: ['f-reopen', 'f-inspection'],
    expectedSupportingEvidenceIds: ['e-reopen', 'e-inspection'],
    expectedContradictingFactIds: [],
    expectedContradictingEvidenceIds: [],
    rationaleConstraint: {
      kind: 'grounded',
      example:
        'The offered reopening and inspection evidence together support the claim.',
      requiredTerms: ['offered', 'together'],
    },
  },
  {
    id: 'direct-contradiction',
    claim: 'Council rejected Bylaw 10.',
    candidates: [
      {
        id: 'f-approve',
        statement: 'Council approved Bylaw 10.',
        evidence: [{ id: 'e-minutes', quote: 'Bylaw 10 was approved.' }],
      },
    ],
    expectedStatus: 'contradicted',
    expectedSupportingFactIds: [],
    expectedSupportingEvidenceIds: [],
    expectedContradictingFactIds: ['f-approve'],
    expectedContradictingEvidenceIds: ['e-minutes'],
    rationaleConstraint: {
      kind: 'grounded',
      example: 'The offered minutes say the bylaw was approved, not rejected.',
      requiredTerms: ['offered', 'approved'],
    },
  },
  {
    id: 'conflicting-sources',
    claim: 'The bridge reopened March 1.',
    candidates: [
      {
        id: 'f-open',
        statement: 'The bridge reopened March 1.',
        evidence: [{ id: 'e-open', quote: 'Bridge reopened March 1.' }],
      },
      {
        id: 'f-closed',
        statement: 'The bridge remained closed on March 1.',
        evidence: [{ id: 'e-closed', quote: 'Bridge remained closed.' }],
      },
    ],
    expectedStatus: 'needs_review',
    expectedSupportingFactIds: ['f-open'],
    expectedSupportingEvidenceIds: ['e-open'],
    expectedContradictingFactIds: ['f-closed'],
    expectedContradictingEvidenceIds: ['e-closed'],
    rationaleConstraint: {
      kind: 'grounded',
      example:
        'The offered sources conflict about whether the bridge reopened.',
      requiredTerms: ['offered', 'conflict'],
    },
  },
  {
    id: 'partial-support',
    claim: 'Council approved the project on March 1 for $2 million.',
    candidates: [
      {
        id: 'f-approval',
        statement: 'Council approved the project.',
        evidence: [
          { id: 'e-approval', quote: 'Council approved the project.' },
        ],
      },
    ],
    expectedStatus: 'needs_review',
    expectedSupportingFactIds: ['f-approval'],
    expectedSupportingEvidenceIds: ['e-approval'],
    expectedContradictingFactIds: [],
    expectedContradictingEvidenceIds: [],
    rationaleConstraint: {
      kind: 'missing_portion',
      example:
        'The offered evidence supports approval but not the date or amount.',
      requiredTerms: ['offered', 'not the date', 'amount'],
    },
  },
  {
    id: 'empty-candidates',
    claim: 'Council approved Bylaw 10.',
    candidates: [],
    expectedStatus: 'unsupported',
    expectedSupportingFactIds: [],
    expectedSupportingEvidenceIds: [],
    expectedContradictingFactIds: [],
    expectedContradictingEvidenceIds: [],
    rationaleConstraint: {
      kind: 'candidate_scope',
      example: 'No offered candidates were available for comparison.',
      requiredTerms: ['offered candidates', 'available'],
    },
  },
  {
    id: 'empty-claim',
    claim: '   ',
    candidates: [
      {
        id: 'f-approve',
        statement: 'Council approved Bylaw 10.',
        evidence: [{ id: 'e-minutes', quote: 'Bylaw 10 was approved.' }],
      },
    ],
    expectedStatus: 'needs_review',
    expectedSupportingFactIds: [],
    expectedSupportingEvidenceIds: [],
    expectedContradictingFactIds: [],
    expectedContradictingEvidenceIds: [],
    rationaleConstraint: {
      kind: 'empty_claim',
      example: 'No claim text was provided.',
      requiredTerms: ['no claim text', 'provided'],
    },
  },
];

export const invalidDecisionClaimSupportResponseFixture: InvalidDecisionClaimSupportResponseFixture =
  {
    claim: 'Council approved Bylaw 10.',
    candidates: [
      {
        id: 'f-approve',
        statement: 'Council approved Bylaw 10.',
        evidence: [{ id: 'e-minutes', quote: 'Bylaw 10 was approved.' }],
      },
      {
        id: 'f-hearing',
        statement: 'Council held a hearing for Bylaw 10.',
        evidence: [{ id: 'e-hearing', quote: 'Public hearing for Bylaw 10.' }],
      },
    ],
    rawResponse: {
      status: 'supported',
      supportingFactIds: ['f-hearing', 'f-unknown'],
      supportingEvidenceIds: ['e-minutes'],
      contradictingFactIds: [],
      contradictingEvidenceIds: [],
    },
    expectedNormalizedStatus: 'needs_review',
    expectedErrors: ['unknown_fact', 'evidence_fact_mismatch'],
  };
