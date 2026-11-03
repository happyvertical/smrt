# Issue 4616 (Class CrunchLabs source) test contract

Risk standard (reads a user's files, new catalog visibility). Design:
[class crunchlabs](../../packages/education/agents/class-crunchlabs.md). All
fixtures are synthetic; no network and no real download in tests.

| behavior | positive | failure | level | command |
|---|---|---|---|---|
| layout and mapping | A-F letters to roles, audience defaults, editable master guardian, unit-wide course members, v2 reader accepts the bundle | ignored files named with a reason, videos never read, several units need a name, empty unit | unit | `pnpm --filter @happyvertical/smrt-education test` (`class-crunchlabs.test.ts`) |
| de-duplication | repeated exports collapse (crc/size), same bytes keep one preferred copy | a changed file is superseded by the newer export | unit | same |
| aggregates, large units | unit-wide "(all lessons)" files left out by default; oversize unit split into valid parts | one lesson or the course members over budget | unit | same |
| lesson pages | page range from the counted mission log, pdf-lib and converter counters | unknown count writes no pages and warns | unit | same |
| video matching | by unit, lesson and step into external references, shared steps told apart | no playlist, no item, ambiguous, item taken, bad video id | unit (fixture playlist) | same |
| catalog provider | Science units with playlist preview, operator-only and "permission pending" by default, public only on the literal switch | other families, default policy, failing source, cursor, bad playlists | unit | same |
| add to a course | operator family imports through the bundle service (roles, audience, pages, videos arrive) | other family and mismatched actor refused before any file is read | integration (SQLite) | same |
| disk reader | zip parts read lazily by central directory, loose folder mixed in | corrupt entry, not a zip, symlink and hidden files skipped | integration (tmp dir) | same |
