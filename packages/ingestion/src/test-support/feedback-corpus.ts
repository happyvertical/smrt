/** Frozen learning-contract corpus. No live-model or #3677 benchmark claim. */
export const feedbackTraining = [
  {
    family: 'purchase-request-v1',
    text: 'Invoice supplier expense east',
    destination: 'Finance East',
    judgment: 'correct',
  },
  {
    family: 'counsel-memo-v1',
    text: 'Contract legal agreement east',
    destination: 'Legal East',
    judgment: 'correct',
  },
  {
    family: 'service-status-v1',
    text: 'Outage support incident east',
    destination: 'General East',
    judgment: 'incorrect',
  },
] as const;
export const feedbackHeldOut = [
  {
    family: 'receipt-summary-v2',
    text: 'Supplier invoice receipt west',
    expected: 'Finance West',
  },
  {
    family: 'terms-note-v3',
    text: 'Legal contract terms west',
    expected: 'Legal West',
  },
  {
    family: 'incident-escalation-v2',
    text: 'Support outage escalation west',
    expected: null,
  },
  {
    family: 'observatory-note-v1',
    text: 'Galaxy telescope orbit west',
    expected: 'General West',
  },
] as const;
