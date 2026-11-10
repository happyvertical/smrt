# Framework family/group session train

Repository happyvertical/smrt, current0.57.41 release line, branch codex/issue-4491-family-invitations. One combined ready PR, one attributed commit per micro-item with Refs#4491 or Refs#4493; PR closes both umbrella issues. Original group PR4480 and its branch remain preserved pending coordinated handoff; source issues4469/4475/4473 and prior review provenance stay referenced, never silently closed or re-claimed.

1. Preserve completed invitation/identity and opaque mailbox-budget contracts from #4491.
2. Merge exact reviewed group head5330d47abab43d58a58a9f97976195b2723a7311 using a real merge, retaining history; resolve education index/workbook overlaps by union with current Plan/intake/workbook-completion APIs, never downgrade current behavior or dependency versions.
3. Add only necessary integration contract corrections under #4493; downstream Hearth#62 integrates visible groups into family#57. Guardian all-current/future family access is explicitly user-confirmed and must never enroll/change child group sharing or grant staff authority.
4. Validate combined Node26/pnpm11.25 source once, including affected SQLite/PostgreSQL group/identity/migration boundaries, public consumer exports and private media/revision concurrency. Reuse unchanged prior group review provenance, but exact combined committed HEAD receives integrated high-risk review.

Risk HIGH: auth/tenancy, identity proof, closed sharing models, private media, consent ceilings and schema/application lifecycle. No merge-to-main, registry release or deployment authorized.

Prior #4491 validation remains evidence for the premerge head1e52b92e5: packageSQLite79, PG56, root build/typecheck/test/lint/format; knowledge graph needs canonical refresh after test-generated local artifacts. SDK enforced-STARTTLS PR1473 separately has clean independent review and Required CI.

Drive-by ledger for combined PR: e4752bb1e2 public SvelteKit cookie/local event typing (ten changed lines); 1e52b92e5 generated registration dependency metadata (six changed lines, assets/content/images; only existing declared smrt-types/smrt-ui dependency metadata). Canonical regeneration reproduced identical hashes; no object/schema/import changes.

## Planned core resolver integration item (#4493)

The packed app's `_resources` and application-runtime config detectors test
ESM import-only users/runtime subpaths through CommonJS require conditions and
incorrectly skip valid routes or runtime configuration. Correct both owning
detectors to resolve the exact ESM import from the consumer package URL, including
hoisted installs. Keep missing/invalid targets,
explicit disablement and handwritten route ownership intact. This is a directly
tracked integration item, not the kernel's ten-line incidental drive-by exception.
No package-export change, route exposure widening or gate bypass is authorized.

| Behavior/invariant | Trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R01 import-only consumer dependency | generate _resources from packed ESM consumer | real import-only users subpath/hoisted package emit route and execute handler; independent import-only application runtime selects runtime config | absent/unexported/missing target skips, disablement and handwritten ts/js preserved | trusted build projectRoot; no runtime actor change | N/A build-time filesystem lookup, no DB/transaction | Node26 ESM/Vite | package exports import condition; no require/default assumed | unit + real filesystem/runtime regression | core resources-route, resources-route-resolution, sveltekit-generator/runtime focused files |

## Model save-option compatibility

The current core guard found six imported group model overrides dropping `SmrtSaveOptions`. Commit92a78ae121 forwards the optional argument through validation to the base save. A real freshly loaded `EducationGroup` with an explicitly stale expected timestamp overwrote the winner before the fix and now rejects it; the winner remains unchanged. Existing group lifecycle, policy and comment tests retain their immutability and version gates. This is an owning #4493 integration correction, not a guard exception.

Runtime artifact validation must follow test execution: tests write ignored manifests with `artifactPurpose:test`, including model-free types/UI packages. Canonical discovery excludes those inputs. Regenerate runtime manifests/knowledge through owning public APIs before the final package sync and graph check; never hand-edit registration strings or recorded hashes. Registration metadata is compared structurally and repeated canonical sync hashes must agree.
