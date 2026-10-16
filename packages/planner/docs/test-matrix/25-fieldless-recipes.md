# Fieldless feature models (#25)

The producer already emits the webhook task and schema. The catalogue must
retain it without inventing public operations or treating real collections as
models. There is no persistence, authentication, or runtime mutation change.

| Behavior / invariant | Trigger | Positive case | Negative case | Actor / context | Executor / transaction | Runtime / dialect | Contract edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fieldless model remains available to its feature recipe | Extract a package manifest and build the catalogue | A fieldless SmrtObject task survives and its recipe is retained | Its generated routes/tools remain disabled; a collection with an inherited schema is excluded | N/A: build-time metadata only | N/A: no database access | Node 26 generator; SQL N/A because no query occurs | Manifest ancestry/schema; missing optional schema retains legacy field-based detection | Catalogue integration regression | `pnpm exec vitest run tests/extract.test.ts tests/catalog-drop.test.ts` |

The regression fails against the base classifier (task absent) and must pass
with the corrected classifier. Full repository gates run on the committed
head. The committed catalogue stays registry-generated; preview validation
against the coordinated smrt build is evidence, not a committed local overlay.

## Accepted continuation: derived collections

The real combined catalog probe exposed `EmailAccountCollection`, which inherits
`AccountCollection` and a table schema but has no own `extendsTypeArg`. The
classifier must inspect manifest ancestry before accepting schema evidence.

| Behavior / invariant | Trigger | Positive case | Negative case | Actor / context | Executor / transaction | Runtime / dialect | Contract edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Collection ancestry overrides inherited table/field evidence | Extract derived collection metadata from the messages manifest | EmailAccount remains a model; fieldless task regression stays green | EmailAccountCollection and deeper non-suffix MailAccounts are excluded, including qualified ancestor references | N/A: build-time metadata | N/A: no database | Node 26; SQL N/A | Missing own type argument; local and qualified parent names | Integration regression and actual combined manifests | `pnpm exec vitest run tests/extract.test.ts tests/catalog-drop.test.ts`; retained `catalogue-proof.mjs` |
| Ancestry traversal terminates for cyclic input | Manifest parent references the same object | Legacy value model remains available | No infinite loop on malformed cycle | N/A: build-time metadata | N/A: no database | Node 26; SQL N/A | Cyclic optional ancestry | Unit regression | `pnpm exec vitest run tests/extract.test.ts` |

The derived-collection regression fails at the previously reviewed head
`24661e9`. Round 2 reviews the complete delta from that head under review cycle
`6103880017`; it does not restart the full review.
