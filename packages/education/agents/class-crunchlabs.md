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

`addClassCrunchLabsUnit({ service, actor, catalogActor, record, listing, policy,
files, playlists, pageCounter?, receiveMember? })` re-checks
`canAddClassCrunchLabsUnit(actor, policy, listing)`: visibility is derived from the
host's own `listing.publicListing` (operator unless the literal `true`), never from
the record or any caller-supplied visibility or licence; an operator-only listing
is refused to every other family, and the course actor must be the catalog actor, builds the bundle and imports each part. Then store each
part's accepted members and `attachCourse` every part (any order): they merge
into one family course. Courses are `personal-use-copy` (`build.licenseKind`).

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
- Titles (#4642): a material's title is its file name tidied: the letter prefix,
  lesson code (`L02`), unit name, version (`v1.0`, `v.1.1`), `copy` and stray dots
  and underscores are dropped (`A. L01_Teacher Mission Manual_<Unit>_v1.0.pdf` is
  `Teacher Mission Manual`; `... Assessment (Editable)` keeps its qualifier), and a
  trailing ` - detail` becomes `(detail)` (`SQIREL Poster - 8.5x11` is `SQIREL
  Poster (8.5×11)`). Two different files that tidy to one title in the same
  lesson or the course are told apart as `Title (2)`; byte-identical copies are
  already collapsed by de-duplication. A lesson is titled `Lesson N: Name`. The name is, in order: the cover headline of the lesson's
  teacher manual PDF, when the host passes `readFirstPageHeadline({ bytes, kind:
  'pdf' })` (the most prominent, largest-type text on page 1, lines joined by a
  space; this package has no PDF text reader, so the host supplies one, for
  example from pdfjs; all capitals fold to title case, `WEIGHT & MOTION` is
  `Weight & Motion`; a throw or null is ignored); else the activity of the lesson's
  first (lowest step) `StudentHandsOnExploration` video name, in title case with
  small words lower (`L03.6_Video_StudentHandsOnExploration_PlayWithPlungers` is
  `Lesson 3: Play with Plungers`); else `Lesson N`. Video names are read whether or
  not a playlist matched them, both `L01.4_Video_` and `L01.4 Video_` forms, `-NNN`
  download suffixes dropped, and loose lesson videos at the download's root count
  for the unit their name ends with. Titles are manifest data, so a section or lesson title that differs from
  an already attached part of the same unit is `part-conflict` (see the bundle
  import's shared-placement rules, which are deliberately not relaxed): a unit
  imported before this change keeps its `Lesson N` titles, and getting the new
  titles means importing the unit again into a fresh course (a different course
  id, not `courseId` of the old one).
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
- Playlists without step numbers (#4647): the live course playlists title items
  `<Unit>: <name>` in teaching order. Videos that no numbered item names fall back to
  title and kind evidence, never over a numbered match. Playlist items titled
  `Lesson N Recap` are anchors: each pairs with lesson N+1's single `Recap` video
  and they cut the playlist into one segment per lesson (lesson 1 runs from the
  start; the last download lesson runs to the end). Inside a segment a video and
  an item pair when each is the other's single best match (ties pair nothing).
  Evidence is normalized tokens (case, `&` is `and`, simple plurals, the unit
  prefix and `Part N` dropped, `N` kept) for the title, and kind words:
  `Prep`/`MaterialsPrep`, `Exploration`/`StudentHandsOnExploration`,
  `Anchor`/`AnchorCheckIn`, `Explained`/`ForcesExplainer`, `Wrap Up`/`WrapUp`,
  `Recap`, `Check-in`, `Link up`, `Look closer`. Differing numbers (`Part 1` against
  `Sumo Spheres 2`) or an item naming another kind contradict. What is left in a
  segment pairs by order only when the leftover videos and items are equally many,
  the videos sit on distinct steps and nothing contradicts; otherwise they stay
  unmatched. No pair crosses a segment. A playlist with no anchor is not segmented:
  only pairs with title evidence count and nothing is filled by order. Reasons:
  `no_item` (no unnumbered item is left for it, also a whole unit without anchors),
  `ambiguous` (items remain but evidence ties or the leftovers do not pair one to
  one), `unanchored` (its lesson is not bounded by recap anchors in the playlist),
  plus the existing `no_playlist` and `item_taken`.
- De-duplication: repeated exports of one logical path collapse (CRC and size
  when known; the newer export wins, a changed file is `superseded`); the same
  bytes under another name or place keep one copy (the lesson-named file in its
  lesson, posters unit wide, never a `copy`).
- A unit larger than one archive (bundle cap 100 MiB) is split by lesson into
  `build.parts` (default 90 MiB each; the first part carries the course members and
  any lesson that fits beside them, others go to the first part with room; if no
  lesson fits beside the course members the build refuses with `too_large`); `build.bundle`
  and `build.manifest` are the first part. Every part's manifest names the unit
  (`course.key` = `build.unitKey`, `classCrunchLabsUnitKey(unit)`, and `course.title`),
  its `part` (`index`/`count`) and each lesson's unit-wide `order` (the lesson
  number), so `attachCourse` merges the parts in lesson order whatever order they
  arrive in.

- Lesson steps (#4656): the slides are step `launch` (order 0, "Launch"); each
  matched video is a step keyed by its real step code (`6`, `1b`) with the
  video's title as label, ordered numerically (`classCrunchLabsStepOrder`: `1` <
  `1a` < `1b` < `2`; videos sharing a code share the step, offset by 0.001 each);
  the status check assessment (printable PDF and the editable master) is step
  `check` (order 9999, "Status check"). The mission log, handouts, printables, the
  teacher manual and the assessment guidance carry no step: the first three are the
  learner's setup, the others stay guardian material.

The `report` lists lessons, members, parts, pages, matched and unmatched videos,
duplicates, ignored files and warnings. Fixtures in tests are synthetic files
with the same naming; no real download is ever copied into the repository.

Tests: `src/__tests__/class-crunchlabs.test.ts`.
