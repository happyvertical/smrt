# Feedback learning contract: frozen shadow cohort

This is an authored deterministic contract experiment for #3676, not a claim
about a model, production accuracy or statistical generalization. The matcher,
paired protocol and expected labels were declared before execution; no fitting or
threshold tuning followed the results. No #3677 evaluation cases were used.

Corpus: `packages/ingestion/src/test-support/feedback-corpus.ts`

SHA-256: `c285ee9d684abd7414c79deefeec5a9a4434edac5bfaedcf402e285ecc29dafd`

## Protocol and observed SQLite/PostgreSQL result

Three training families contain two explicit corrected destination preferences
and one explicit negative route. Four separately authored held-out families use
different wording and different destination record IDs. The fixed generator sees
only current evidence, offered authorized candidates and retrieved examples; it
cannot inspect family names or expected answers. It extracts a destination role
from an eligible example and combines it with the region in the current evidence.
The negative example leads to abstention. Without an example it uses the declared
general destination baseline.

| Held-out family | Baseline | With eligible training feedback | Expected |
|---|---|---|---|
| receipt-summary-v2 | General West | Finance West | Finance West |
| terms-note-v3 | General West | Legal West | Legal West |
| incident-escalation-v2 | General West | Abstain | Abstain |
| observatory-note-v1 | General West | General West | General West |

Baseline target/action accuracy: **1/4**. Treatment: **4/4**. Abstentions: **1/4**
under treatment, **0/4** at baseline. The unrelated control remains unchanged.
All four treatment results retain `automaticActionEligible: false`; no domain
operation executes. Separate executable controls deny incompatible, superseded,
revoked/deleted, wrong-tenant and wrong-confidential-scope examples. Exact repeated
requests are replay/idempotency controls and are not counted as held-out examples.

The held-out test passed through the actual ingestion retrieval/proposal service
on SQLite (`feedback-second.log`, five-case run, 43.42 seconds) and PostgreSQL
(`feedback-all-postgres-checkpoint.log`, 20 passing cases and one separate
retention failure subsequently fixed by its focused regression). Complete final
suite results remain pending; this checkpoint is not release validation.

## Limits, drift and selection bias

The cohort is tiny and deliberately authored to exercise a declared lexical
matching contract. Illustrative 95% Wilson intervals are roughly 5–70% for 1/4
and 51–100% for 4/4; these do not establish generalization or significance.
Training and test categories were chosen by the implementer, so selection bias
is substantial. A changed matcher, provider, prompt, handler or source mix needs
a new versioned evaluation rather than tuning this held-out fixture.

No sampled automatic outcomes exist: the denominator is **0**, reported as
unavailable rather than inferred from approval, completed analysis or successful
execution. The separate downstream-outcome tests preserve failure and unknown
signals. Real-provider shadow evaluation, broader held-out sampling and spend
accounting belong to #3677's canonical evaluation ledger.
