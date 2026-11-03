# Class CrunchLabs source (SMRT #4616)

Class CrunchLabs is a global catalog provider (`class-crunchlabs`) whose units are
listed under Science, with the @ClassCrunchLabs YouTube course playlists as
previews. "Add to a course" reads the family's own download of the unit and runs
the [bundle import](course-bundle-import.md) with a manifest version 2 built from
it. Files come from CrunchLabs' own downloads and YouTube; **nothing is hosted
here** and the listing has no acquirable formats.

## Operator-only until permission, one public switch

`CatalogVisibility` gains `operator`. A `CatalogPolicy` built with
`operatorTenantIds` lets only those families (host configuration, never a
request) see `operator` records; the default policy shows them to nobody, and
`authorize` answers `operator-only`. Materialization refuses them.

`createClassCrunchLabsCatalogAdapter({ playlists, publicListing? })` is a snapshot
`CatalogSyncAdapter` (one terminal page, no cursor). By default
(`CLASS_CRUNCHLABS_PUBLIC_LISTING_DEFAULT = false`) every record is `operator`
visibility with licence state `unknown`, no permitted operations and the text
"free curriculum, permission pending". Only the literal `publicListing: true`,
set by the operator in host configuration, makes records `catalog` visibility
with `verified` evidence permitting `link` only. The switch is part of each
record's revision, so the next sync rewrites the rows when it is flipped.
`classCrunchLabsPreviewEmbedUrl(record)` returns the youtube-nocookie playlist
embed for a listed unit (null for anything else). The playlist data is an
injected `ClassCrunchLabsPlaylistSource`; the adapter never touches the network.

`addClassCrunchLabsUnit({ service, actor, catalogActor, record, policy, files,
playlists, pageCounter?, receiveMember? })` re-checks `canAddClassCrunchLabsUnit`
(an operator-only listing is refused to every other family, and the course actor
must be the catalog actor), builds the bundle and imports each part. Then propose
structure and `applyMaterials` per part as for any bundle. Courses are
`personal-use-copy` (`build.licenseKind`).

## Reading a download

`buildClassCrunchLabsBundle({ files, playlists?, unit?, pageCounter?,
includeUnitWideAggregates?, maxPartBytes? })` takes a `ClassCrunchLabsFileSource`:
`folderClassCrunchLabsSource(dir)` (Node only, from `@happyvertical/smrt-education/node`, never the root: a folder, the Drive zip parts, or both;
zips are read lazily from their central directory, zip64/encrypted/symlinks are
skipped) or `memoryClassCrunchLabsSource(files)`. It never reads video files.

- Layout: `<Unit>_All Unit Wide Materials` and `<Unit>_Lesson <n>`; letters A
  teacher manual, B slides, C student mission log, D status check assessment
  (plus guidance and the editable master), E handouts, F extras, G videos. A
  lettered directory wins over a file's own letter. Several units need `unit`.
- Mapping to manifest v2: A `teacher-guide`, B `slides`, C `learner-pages`, D
  `assessment` / `assessment-guidance`, E `handout`, F `printable`, the unit-wide
  Supply List `attachment`. Audiences are the role defaults (teacher manual and
  guidance guardian, slides guardian, mission log learner); the editable
  assessment master is guardian. Unit-wide files become course members.
- The unit-wide "(all lessons)" combined files repeat the per-lesson files and
  are large, so they are left out unless `includeUnitWideAggregates` (reported as
  `aggregate-of-lessons`); the supply list, posters and other extras are kept.
- Lesson pages: the first mission log of a lesson gets a `Mission log` range
  from `pageCounter` (`createClassCrunchLabsPageCounter({ converter? })` counts
  PDFs with pdf-lib and Word files by rendering them through the converter).
  Without a count the lesson gets no pages and the report says so.
- Videos: names `Lnn.step_Video_Kind_Title` are matched, by unit (playlist
  title), lesson and step (`L03.6` or `Lesson 3 ... Step 6` in the item title),
  to the unit playlist; two videos sharing a step are told apart by the item
  title naming their title or kind, else both stay unmatched (`ambiguous`).
  Matches become `videos` references with a title and a step order (materials
  prep videos are guardian audience); unit-level videos (a teaser) and unmatched
  ones are only reported.
- De-duplication: repeated exports of one logical path collapse (CRC and size
  when known; the newer export wins, a changed file is `superseded`); the same
  bytes under another name or place keep one copy (the lesson-named file in its
  lesson, posters unit wide, never a `copy`).
- A unit larger than one archive (bundle cap 100 MiB) is split by lesson into
  `build.parts` (default 90 MiB each; course members go first); `build.bundle`
  and `build.manifest` are the first part.

The `report` lists lessons, members, parts, pages, matched and unmatched videos,
duplicates, ignored files and warnings. Fixtures in tests are synthetic files
with the same naming; no real download is ever copied into the repository.

Tests: `src/__tests__/class-crunchlabs.test.ts`.
