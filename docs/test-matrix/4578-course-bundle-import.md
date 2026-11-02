# Issue 4578 design and test contract

Risk high: untrusted archive parsing and two new append-only tables. Named
triggers: hostile input (zip bombs, traversal, symlinks, encryption) and
persistence with replay. Design: [course bundle import](../../packages/education/agents/course-bundle-import.md).
Education-only: ingestion's receipt contract is unchanged (see the doc's "Not in
this release").

| behavior | positive | failure | level | command |
|---|---|---|---|---|
| bounded zip reader | stored/deflate members, sorted, hashed | bomb (ratio), lying sizes either way, truncated, ambiguous/forged end record, overlapping/out-of-range offsets, zip64, multi-disk, bad CRC, bad method, encrypted, symlink/special, duplicate names, too many entries, oversize total/archive | unit | `pnpm --filter @happyvertical/smrt-education test` (`course-bundle.test.ts`) |
| path rules | backslashes normalised | `..`, absolute, drive letter, `:`, NUL/control/bidi, empty/`.` segments, depth, length | unit | same |
| seeded mutation | 1500 mutated archives read or raise the typed error within caps | hang/crash/untyped error | unit | same |
| classification | pdf/image/text by content; duplicates once; natural order | unsupported, nested zip, unreadable text, encrypted PDF, oversize all visible | unit | same |
| manifest | roles, sections, lessons in declared order | unknown key at any level, `__proto__`, version, shape, role, missing/duplicate member, oversize, bad answer key | unit | same |
| import service | evidence, counts, accepted members handed over, no bytes in views | hostile input writes nothing | integration (SQLite) | `course-bundle-service.test.ts` |
| replay and tenancy | re-zipped bundle replays; tenants separate | N/A | integration | same |
| authority | author/read/generate actions; authorize before parsing | reader denied, no session, actor mismatch, cross-tenant read/propose | integration | same |
| progress | `unpack`, `classify`, `extract`, `propose` start at 0 and finish | throwing listener ignored | integration | same |
| proposal | new draft revision, unpublished; retry returns same job | wrong bundle, changed head, reader | integration | same |
| immutability and migration | rewrite/delete rejected; additive migration on populated DB | N/A | integration | `course-bundle-migration.test.ts` |
