# Framework family/group session train

Repository happyvertical/smrt, current0.57.41 release line, branch codex/issue-4491-family-invitations. One combined ready PR, one attributed commit per micro-item with Refs#4491 or Refs#4493; PR closes both umbrella issues. Original group PR4480 and its branch remain preserved pending coordinated handoff; source issues4469/4475/4473 and prior review provenance stay referenced, never silently closed or re-claimed.

1. Preserve completed invitation/identity and opaque mailbox-budget contracts from #4491.
2. Merge exact reviewed group head5330d47abab43d58a58a9f97976195b2723a7311 using a real merge, retaining history; resolve education index/workbook overlaps by union with current Plan/intake/workbook-completion APIs, never downgrade current behavior or dependency versions.
3. Add only necessary integration contract corrections under #4493; downstream Hearth#62 integrates visible groups into family#57. Guardian all-current/future family access is explicitly user-confirmed and must never enroll/change child group sharing or grant staff authority.
4. Validate combined Node26/pnpm11.25 source once, including affected SQLite/PostgreSQL group/identity/migration boundaries, public consumer exports and private media/revision concurrency. Reuse unchanged prior group review provenance, but exact combined committed HEAD receives integrated high-risk review.

Risk HIGH: auth/tenancy, identity proof, closed sharing models, private media, consent ceilings and schema/application lifecycle. No merge-to-main, registry release or deployment authorized.

Prior #4491 validation remains evidence for the premerge head1e52b92e5: packageSQLite79, PG56, root build/typecheck/test/lint/format; knowledge graph needs canonical refresh after test-generated local artifacts. SDK enforced-STARTTLS PR1473 separately has clean independent review and Required CI.

Drive-by ledger for combined PR: e4752bb1e2 public SvelteKit cookie/local event typing (ten changed lines); 1e52b92e5 generated registration dependency metadata (six changed lines, assets/content/images; only existing declared smrt-types/smrt-ui dependency metadata). Canonical regeneration reproduced identical hashes; no object/schema/import changes.
