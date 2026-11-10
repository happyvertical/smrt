# Issue 4615 (manifest version 2) test contract

Risk standard (untrusted manifest, additive schema). Design:
[course bundle import](../../packages/education/agents/course-bundle-import.md#manifest-version-2-smrt-4615).

| behavior | positive | failure | level | command |
|---|---|---|---|---|
| closed schema | v2 layout, v1 unchanged | unknown key at every level (with path), v1 page role or unknown/video role, missing/duplicate/manifest member, duplicate or bad keys | unit | `pnpm --filter @happyvertical/smrt-education test` (`course-bundle-manifest-v2.test.ts`) |
| roles and audience | role defaults, stated override, guardian-only roles | learner audience on answer-key/guidance, unknown audience; guardian text never in a lesson body | unit | same |
| lesson pages | ranges to `p<n>` pages with labels and order | reversed, unlisted, overlapping, over-cap, unpageable (text), non-integer | unit | same |
| course members, videos | `CourseAsset` plan, YouTube ids with title/step | non-allowlisted references, repeated video, missing title, bad step | unit | same |
| hand-off | slides deck original + rendered pages, role/audience/courseLevel on `receiveMember` and the member rows | N/A | integration (SQLite) | `course-bundle-materials.test.ts` |
| apply | course/lesson assets, pages, videos written; slides both files; replay unchanged | conflict, missing asset/lesson, authored course, public asset for guidance, wrong bundle, unauthorized, skipped Office failure; all or nothing | integration | same |
| retry | failed members rendered once, recorded append-only, overlaid on every reader, handed to the host | still down records nothing, rejections not retried, no converter, wrong bundle, unauthorized, duplicates collapse | integration | same |
| Office text reader | slides with notes, flattened Word | no engine -> null, corrupt -> swallowed by the importer | unit/integration | same |
| migration | `audience` column added to deployed members, new table | N/A | integration | `course-bundle-migration.test.ts` |
