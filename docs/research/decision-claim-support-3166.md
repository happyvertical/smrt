# Decision claim-support research (#3166)

## Decision

**No-go for a production replacement until the empirical gate passes.** SMRT's
current optional decision wrapper exposes predicate evaluation only. SDK v0.94.1
also has typed predicate, choice, and score questions; its batched predicate
contract can select multiple offered IDs through a deterministic question-key to
ID mapping after #3159's shared wrapper is merged. None of those question
types writes an audit rationale by itself. No live TypeSafe decision
configuration was available for this research, and no model call, latency,
cost, or quality result was measured. Contract-shaped tests or fixtures would
not establish those outcomes.

This conclusion concerns a replacement of `FactCollection.assessClaimSupport`,
not the existing generative implementation. Existing behavior remains the safe
default until the empirical gate below is met.

## Current public and consumer contract

`FactCollection.assessClaimSupport(claim, candidates, options)` returns:

```ts
{
  status: 'supported' | 'unsupported' | 'contradicted' | 'needs_review';
  matchedFactIds: string[];
  matchedEvidenceIds: string[];
  rationale: string;
  confidence?: number;
}
```

The current prompt is generative, but constrained to supplied candidate facts
and evidence. An empty candidate list returns `unsupported` with a rationale
that no candidates were available. That means only that no offered candidate
supports the claim; it does **not** establish that the claim is universally
false.

Content's fact-audit repair and recheck flows persist `status`, matched IDs,
rationale, and confidence into audit metadata and links. Both filter IDs to the
offered candidate closure. Recheck additionally changes `supported` or
`contradicted` to `needs_review` when no offered fact ID survives. A
status-only result would lose required attribution and could change audit links.
The current consumer maps every matched ID to one relationship based on final
status, so it cannot safely represent mixed evidence without an additive
consumer change.

Relevant baseline sources at `8ddc5463109369c594b69d4adb09d6a255a59a74`:

- `packages/facts/src/facts.ts` — prompt invocation and response parsing.
- `packages/facts/src/types.ts` — public assessment shape.
- `packages/content/src/content.ts` — repair and recheck persistence.
- `packages/facts/src/prompts.ts` — candidate-only assessment instruction.

## Inspected pending decision foundation

The pending #3159 commit `f2ff7129ee9b3b2dc05586e76dbb3fa0cebf4348` makes
the SDK decision request/result types and `executeDecision()` public. Its
protected `SmrtClass.attemptDecision()` accepts caller-curated state and a
batched SDK request, returns `undefined` only when no decision client is
configured, records decision usage, and otherwise propagates capability,
provider, and response errors. `executeDecision()` validates the exact answer
keys, requested choice labels, score rubrics, and probability distributions.

That foundation supports the proposed per-candidate predicate batch once it is
merged. This main-based research PR does not import or execute it. The helper
does not map question keys to domain IDs, derive claim-support status, or
generate a rationale; those remain facts-domain responsibilities and evaluation
targets.

The inspected #3161 compatibility commit
`9ba4c67c68f04f149e5c3d40af6f6969ab0ae41f`, atop that pending foundation, uses
a typed `merge`/`branch` choice only for ambiguous fact reconciliation. It
preserves the legacy text route when no decision client is configured and
branches unless the selected merge probability meets the configured threshold
and exceeds the branch probability. It does not change `assessClaimSupport`,
so this research fixture and its proposed claim-support follow-up remain
separate from reconciliation behavior.

## Proposed additive hybrid contract

If the empirical gate succeeds, introduce a new opt-in assessment path rather
than replacing the method. Preserve existing fields and add role-specific
attribution so callers retain mixed evidence without guessing from `status`.

```ts
interface FactClaimSupportAttribution {
  supportingFactIds: string[];
  supportingEvidenceIds: string[];
  contradictingFactIds: string[];
  contradictingEvidenceIds: string[];
}

interface AdditiveFactClaimSupportAssessment extends FactClaimSupportAssessment {
  attribution?: FactClaimSupportAttribution;
  assessmentScope: 'offered_candidates';
  route?: 'generative' | 'hybrid';
  decision?: {
    kind: 'predicate' | 'choice' | 'score';
    probability?: number;
    choice?: string;
    score?: number;
    confidence?: number;
    provenance?: { provider: string; model: string };
    usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  };
}
```

`matchedFactIds` and `matchedEvidenceIds` remain a stable, deduplicated union
of the role-specific arrays. Existing callers can read their familiar fields.
A production consumer migration must use `attribution` when present,
especially for `needs_review`; it must not create `supports` links for IDs
identified only as contradictory.

The hybrid has two separately validated stages:

1. A bounded decision stage assesses support and contradiction against the
   supplied candidate closure, with explicit uncertainty handling. A batched
   independent predicate per offered fact (and, where necessary, offered
   evidence) selects multiple IDs by mapping only known question keys back to
   their candidates. It can only yield a candidate-scoped result, never a
   universal truth judgment.
2. An attribution stage chooses only supplied fact/evidence IDs and writes a
   candidate-grounded rationale. Predicate selections are closed under the
   offered candidate map; the validator rejects unknown IDs, deduplicates IDs,
   and requires every evidence ID to belong to a returned fact. SDK choices can
   return one named label, while batched predicates provide the multiple-ID
   selection mechanism. The rationale still remains a generative step and the
   mapping, thresholds, and candidate-closure validation require evaluation;
   they cannot be inferred from `evaluate()` or SDK type availability.

Status derivation is deterministic after validated attribution:

| Valid attribution | Result |
| --- | --- |
| At least one supporting ID; no contradicting ID; evidence sufficient | `supported` |
| At least one contradicting ID; no supporting ID; evidence sufficient | `contradicted` |
| Both roles, partial evidence, low-confidence/uncertain decision, or invalid attribution | `needs_review` |
| Candidate closure assessed, no support or contradiction selected | `unsupported` with candidate-scoped rationale |

For a combined-evidence claim, every fact/evidence needed to establish support
belongs in the supporting arrays. A single incomplete component is not enough
to claim `supported`. Contradictory evidence is retained separately even when
the final status is `needs_review`.

Configured provider transport, authentication, and malformed-response errors
must reject or produce an explicitly recorded `needs_review` only at the
existing caller's error boundary. They must never become `unsupported`, a
neutral successful response, or fabricated empty attribution. Prompt overrides,
tenant scope, candidate curation, and existing generative extraction and
publication/governance policy remain unchanged.

## Paired labeled cases

These are fixed design labels for a future reproducible evaluator. They are not
model measurements. Run each through existing generative and proposed hybrid
paths with the same ordered candidate closure, then score status and
role-specific attribution.

The machine-readable counterparts live in
`packages/facts/src/__tests__/fixtures/decision-claim-support-3166.ts`.
`decision-claim-support-research.test.ts` checks normal expected IDs against
the declared candidate closure, exercises each expected rationale example, and
passes a separate malformed raw response through a test-local closure validator.
It does not invoke a model or evaluate model quality.

| Case | Claim and offered candidate evidence | Expected status | Required attribution/rationale assertion |
| --- | --- | --- | --- |
| Direct support | Claim: “Council approved Bylaw 10.” `f-approve` states approval with `e-minutes`. | `supported` | `f-approve` and `e-minutes` are supporting; rationale cites offered evidence. |
| Candidate miss | Claim: “Council approved Bylaw 10.” `f-hearing` only states a hearing occurred. | `unsupported` | No IDs; rationale says offered candidates do not support, never that the claim is false. |
| Combined support | Claim: “The bridge reopened on March 1 after inspection.” `f-reopen`/`e-reopen` covers reopening; `f-inspection`/`e-inspection` covers inspection and date. | `supported` | Both fact/evidence pairs are supporting; omitting either pair is incomplete attribution. |
| Direct contradiction | Claim: “Council rejected Bylaw 10.” `f-approve`/`e-minutes` says it was approved. | `contradicted` | `f-approve` and `e-minutes` are contradicting. |
| Conflicting sources | Claim: “The bridge reopened March 1.” `f-open`/`e-open` supports; `f-closed`/`e-closed` reports it remained closed. | `needs_review` | Both role-specific groups are retained; no consumer flattens them into `supports` links. |
| Partial support | Claim contains approval, date, and dollar amount; evidence proves only approval. | `needs_review` | Supporting IDs are role-specific; rationale identifies missing portions. |
| Invalid selection | A separate malformed raw response includes an unknown fact ID and assigns known evidence to another offered fact. | `needs_review` | The closure validator rejects it before the normalized public result; evaluator diagnostics record the invalid output. |
| Empty candidates | Any non-empty claim with no candidates. | `unsupported` | Empty IDs and candidate-scoped rationale; preserve public baseline. |
| Empty claim | Whitespace-only claim with any candidates. | `needs_review` | Empty IDs and “No claim text was provided.” baseline behavior. |

## Evaluation and go gate

Run an approved non-production evaluation with credentials supplied only at
runtime. Do not print, commit, or retain credentials. The corpus must contain
representative, de-identified candidate closures from fact audit and the paired
cases above, with blinded human labels for status and role-specific attribution.

For each route, record only actual observations:

- status agreement and abstention/`needs_review` rate;
- fact and evidence attribution precision, recall, and exact-set agreement,
  separated by support and contradiction roles;
- rationale grounding against the offered candidate closure;
- request latency, provider-reported usage/cost where available, and fallback
  or error rate; and
- errors and outputs rejected by the candidate-closure validator.

The gate passes only if the hybrid has reviewable measurements for the same
corpus, does not weaken candidate-scoped semantics or attribution fidelity, and
has an approved caller migration for mixed evidence. The merged #3159 foundation must
be used with a facts-domain map that maps every selected question only to an
offered candidate. The report must state corpus scope, exclusions,
provider/model/configuration, and limitations. It
must not generalize a candidate miss into a truth claim or claim cost/quality
improvement from interface shape.

## Follow-up when the gate passes

Open a separate implementation issue. It should add the candidate-key mapping
and closure validator
in `@happyvertical/smrt-facts`, retain generative rationale, migrate the two
content audit consumers to role-specific links, add fixture-driven contract
tests and an environment-gated live evaluator, and update framework/website
documentation. It must preserve the unconfigured generative route and carry the
empirical report as acceptance evidence.

Until then, do not implement a production decision migration under #3166.
