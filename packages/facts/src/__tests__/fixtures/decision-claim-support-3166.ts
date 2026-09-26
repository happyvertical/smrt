import type {
  FactClaimSupportCandidate,
  FactClaimSupportStatus,
} from '../../types';

export interface DecisionClaimSupportFixture {
  id:
    | 'direct-support'
    | 'candidate-miss'
    | 'combined-support'
    | 'direct-contradiction'
    | 'conflicting-sources'
    | 'partial-support'
    | 'invalid-selection'
    | 'empty-candidates'
    | 'empty-claim';
  claim: string;
  candidates: FactClaimSupportCandidate[];
  expectedStatus: FactClaimSupportStatus;
  expectedSupportingFactIds: string[];
  expectedSupportingEvidenceIds: string[];
  expectedContradictingFactIds: string[];
  expectedContradictingEvidenceIds: string[];
  rationaleConstraint: 'candidate_scope' | 'grounded' | 'missing_portion';
  invalidSelection?: {
    factId?: string;
    evidenceId?: string;
  };
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
    rationaleConstraint: 'grounded',
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
    rationaleConstraint: 'candidate_scope',
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
    rationaleConstraint: 'grounded',
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
    rationaleConstraint: 'grounded',
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
    rationaleConstraint: 'grounded',
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
    rationaleConstraint: 'missing_portion',
  },
  {
    id: 'invalid-selection',
    claim: 'Council approved Bylaw 10.',
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
    rationaleConstraint: 'grounded',
    invalidSelection: { factId: 'f-unknown', evidenceId: 'e-unknown' },
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
    rationaleConstraint: 'candidate_scope',
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
    rationaleConstraint: 'grounded',
  },
];
