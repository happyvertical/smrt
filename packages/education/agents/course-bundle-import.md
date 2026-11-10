# Course bundle import

`CourseBundleImportService` (SMRT #4578, extends `CourseAuthoringService`,
consumed by Hearth #94) imports a course bundle, a zip with an optional manifest
or a plain file set, as bounded evidence, hands its supported members to the
host for ingestion extraction and proposes sections and lessons for review.
Risk is high: untrusted archive parsing and new schema. It reuses the course
authorizer: `importBundle` needs `education.course.author`, `readImport`
`education.course.read-draft`, `proposeStructure` `education.course.generate`
(via `CourseGenerationReviewService`). Operations: `import-course-bundle`,
`read-course-bundle`. Server only (Node `zlib`/`crypto`); no new dependency.

## Flow

1. `importBundle({ ...actor, bundle, limits?, onProgress?, receiveMember? })`
   authorizes **before parsing**, unpacks (stage `unpack`), classifies and lays
   out the structure (`classify`), writes the evidence in one transaction and
   then calls `receiveMember` for each accepted member (`extract`), outside any
   transaction. `bundle` is `{ archive: Uint8Array }` or `{ files: [{ path,
   bytes }] }`. Hostile or damaged input throws `CourseBundleRefusedError`
   (`reason`, optional `entry`) and writes nothing.
2. `receiveMember(member, { replayed })` is the host's ingestion seam: call
   `IngestionService.receive` with `sourceKind: 'course_import'` and the member
   bytes, then queue extraction and `preserveQuestionExtractionAnalysis` as in
   [question extraction](question-extraction.md). Members carry `role`
   (manifest page role), `lessonKey`, `sectionKey`. It runs on a replay too
   (ingestion dedups by content hash), so an interrupted first run resumes. Its
   return values are in `result.receipts`.
3. `proposeStructure({ ...actor, importId, bundle, courseId,
   expectedHeadRevisionId })` (stage `propose`) re-supplies the bundle (bytes
   are never retained), checks it is the imported one, and runs a deterministic
   `CourseMaterialGenerator` (`smrt-bundle-import`) through
   `requestGeneration`/`runGeneration`. The result is an ordinary proposal: a
   new draft revision of additions and fills; conflicts wait for
   `decideProposal`. Nothing is released, assigned or published. The request key
   is `bundle:<courseId>:<bundleIdentity>`, so a retry returns the same job; the
   same key with another head is `CourseRequestKeyConflictError`.
4. `readImport({ ...actor, importId })` returns the recorded evidence.

Progress is an observer callback (`onProgress({ stage, completed, total })`,
stages `unpack`, `classify`, `render`, `extract`, `propose`; each starts at `completed: 0`;
`render` is emitted only when the bundle has Word/PowerPoint members).
Ingestion has no public job-progress seam, so none is invented. A throwing
listener never affects the import.

## Hard bounds (`COURSE_BUNDLE_LIMITS`; a host may only lower them)

| limit | value |
|---|---|
| `maxArchiveBytes` (input) | 100 MiB |
| `maxEntries` | 200 |
| `maxEntryBytes` (inflated) | 50 MiB |
| `maxTotalBytes` (inflated) | 200 MiB |
| `maxCompressionRatio` (members over `ratioFloorBytes` = 64 KiB) | 100 |
| `maxPathBytes` / `maxSegmentBytes` / `maxPathDepth` | 512 / 255 / 8 |
| `maxManifestBytes` | 256 KiB |
| `maxLessons` (the proposal schema's cap) | 50 |
| `maxLessonBodyChars` | 100 000 |
| `maxOfficeMembers` (Word/PowerPoint members rendered per bundle) | 50 |
| `maxRenderedBytes` (PDF accepted back from the converter) | 50 MiB |
| `conversionTimeoutMs` (one Office member) | 60 000 |
| `maxThumbnailBytes` (first-page image accepted back from the converter) | 5 MiB |
| archive nesting | 1: a zip inside a zip is never expanded |

A lesson whose combined text members exceed `maxLessonBodyChars` refuses the
bundle (`lesson_too_large`, `entry` = lesson key) at import; text is never
trimmed or dropped. A plain file set enforces `maxTotalBytes` on its member
bytes exactly as an archive does on inflated bytes.

The reader (`course-bundle-zip.ts`) parses the end record and central directory,
validates every offset and size against the real buffer, inflates with
`maxOutputLength` equal to the declared size (declared sizes are never trusted:
a mismatch either way is `size_mismatch`), checks CRC32 and re-checks the total
on actual output. Stored and deflate only. Refusals (`CourseBundleRefusalReason`)
cover: not a zip, truncated, ambiguous end record (two end records that both fit
the file, for example one forged in a comment), zip64, multi-disk, central
directory not ending at the end record, entries out of range or overlapping,
local header name/method mismatch, encrypted entries (flags 0/6/13, AES method),
symlink and special files (unix mode; DOS reparse flag), unsupported method,
bad CRC, ratio, entry count, totals, duplicate names (case/NFC-insensitive,
backslashes normalised first) and bad paths (`..`, `.`, empty segments, absolute,
drive letter or `:` anywhere, NUL/control/bidi characters, lone surrogates,
too long or deep). An **honestly** oversize member (declared over
`maxEntryBytes`) is not inflated and is recorded `refused / entry_too_large`.

## Members and statuses

By content (never by extension alone): `docx`/`pptx`/`xlsx` (see below), `pdf` (`%PDF-` in the first 1 KiB),
`image` (PNG, JPEG, WebP), `text` (`.txt`/`.md`, strict UTF-8, no control
characters, body-sized), `manifest` (root `manifest.json`), else `unsupported`.
Status: `accepted` (handed to extraction), `duplicate` (same sha256 as an earlier
member in canonical order; recorded once as evidence, `duplicateOfPath`, never
extracted again), `unsupported` (`unsupported_type`, `nested_archive`,
`unreadable_text`), `refused` (`encrypted_pdf`, `entry_too_large`), `metadata`
(the manifest). Nothing is dropped. An encrypted PDF is any PDF with an
`/Encrypt` token anywhere in its bytes (trailer, xref stream): a false positive
on literal text inside an uncompressed stream is refused, never read.

## Word and PowerPoint members (SMRT #4615)

A `.docx`/`.pptx`/`.xlsx` member is an OOXML package only when the name and the
content agree: a zip whose entries include `[Content_Types].xml` and
`word/document.xml` (docx), `ppt/presentation.xml` (pptx) or `xl/workbook.xml`
(xlsx). A workbook (a supply list) is rendered and kept like the others but has
no text reader. Before the bytes go anywhere, the
package itself passes the same bounded zip reader (ratio, overlap, paths, CRC,
100 MiB inflated); a failure is `refused / unsafe_office`, never a refusal of the
whole bundle. Other zips stay `unsupported / nested_archive`.

Two separate things happen to an accepted Office member, both after
authorization and before the evidence is written:

- **Pages**: a `DocumentConverter` (`document-converter.ts`) renders the original
  to PDF. The importer enforces the byte and time limits itself (input
  `maxEntryBytes`, output `maxRenderedBytes`, `conversionTimeoutMs` with an abort
  signal and a hard race, so an adapter that ignores the signal still times out),
  and rejects output that is not a PDF or is encrypted. The converter is told a
  neutral file name (`document.docx`), never the bundle path. Identical documents
  are rendered once.
- **Text**: an injectable `OfficeTextReader` (best effort; a failure or a `null`
  costs the member nothing) returns whole-document text and, for decks, text and
  speaker notes per slide. Office text is handed to the host on the accepted
  member (`officeText`) and is **never** inlined into a proposed lesson body:
  teacher guides and notes carry answers, and audience belongs to manifest v2.

`receiveMember` gets the original `bytes` (store them as the private original
asset: "Open in PowerPoint" for decks) and `rendered` (`{ bytes, sha256, mediaType:
'application/pdf', converterId }`, store as a private asset beside the original:
the pages for "Present"/reading). The member row records `renderedSha256` and
`renderedSizeBytes`; bytes are still not retained here. A converter may also
return a first-page image (`DocumentConversionResult.thumbnail`); the importer
keeps it only when it is a PNG/JPEG/WebP within `maxThumbnailBytes` and hands it
over as `rendered.thumbnail` (`{ bytes, sha256, mediaType }`), else null. An
unusable thumbnail never fails the member. Gotenberg draws none, so it is null.

**Fail closed.** Any converter problem records that member `unsupported` with a
reason and writes the rest of the bundle normally: `converter_unavailable` (none
configured), `converter_failed` (unreachable or 5xx), `converter_timeout`,
`converter_too_large`, `converter_rejected` (HTTP 4xx, not a PDF, encrypted),
`office_limit` (beyond `maxOfficeMembers`, in natural path order). A member that
failed is not a lesson in the proposal, and identical copies of a failed document
fail the same way rather than becoming duplicates of nothing. Outcomes are part
of the append-only evidence, so a replay does not retry a recorded failure (to
retry, change the bundle). A replay does re-render recorded-accepted members so the
host receives the bytes again; if it can no longer render one it throws
`DocumentConversionError` rather than silently dropping an accepted member.

### Host configuration

```ts
const service = new CourseBundleImportService(db, authorizer, {
  converter: new GotenbergDocumentConverter({
    baseUrl: process.env.GOTENBERG_URL, // for example http://gotenberg:3000
    timeoutMs: 60_000,
    maxBytes: 50 * 1024 * 1024,
  }),
  officeTextReader, // optional, see below
});
```

`GotenbergDocumentConverter` posts to `<baseUrl>/forms/libreoffice/convert`, talks
to nothing else, refuses redirects and URLs with credentials, and caps the response
as it streams. Run Gotenberg as an internal-only service with **no outbound
network**, its own size/time limits and no shared volume with the app; this
package assumes untrusted files never run next to the application. Tests use
`FakeDocumentConverter` (records calls; `failWith`, `failWhen`, `delayMs`, `output`).

`OfficeTextReader` reads Office text through the SDK without this package
depending on `@happyvertical/documents`: the host imports `extractOffice`
(released in `@happyvertical/documents` 0.111.4, sdk#1486, Kreuzberg) and passes
it to `createOfficeTextReader(extractOffice)`, which returns whole-document
text for Word and text plus speaker notes per slide for PowerPoint (images are
never requested). An absent engine reads as `null`; a corrupt file rejects and
the importer treats that as "no text". The repository's current `catalog:`
pin is 0.111.3, which predates the Office processors, so the host bumps the SDK
set (and its minimum release age) before it can import `extractOffice`.

## Manifest (`manifest.json`, version 1, closed)

```json
{ "version": 1, "course": { "subject": "Math" },
  "sections": [ { "key": "unit-1", "title": "Unit One",
    "lessons": [ { "key": "sums", "title": "Sums",
      "members": [ { "path": "sheets/sums.pdf", "role": "exercise" } ] } ] } ] }
```
Every object is closed: an unknown key anywhere is `manifest_unknown_key` (with
its path in `entry`); another version is `manifest_version`. Keys match
`[A-Za-z0-9._:-]{1,120}` and are unique; roles are the extraction page roles
(`exercise`, `example`, `instructions`, `cover`, `answer_key`, `mixed`,
`unknown`); a listed path must exist and be listed once. The manifest is a source
fact: roles are `source`, anything the extractor infers stays `inferred`, and a
manifest/extraction disagreement belongs in extraction review, not here. Without
a manifest each accepted member is one lesson, sections come from the top-level
directory and order is natural path order (digit runs compare numerically, no
locale). Manifest order: the manifest, declared members, then the rest by path.
Lesson bodies are the readable text members of a lesson, joined; PDFs and images
are never inlined. Members whose declared role is `answer_key` or `mixed` never
contribute text to a lesson body (they remain recorded evidence members); the
proposal rationale only counts how many were withheld.

## Manifest version 2 (SMRT #4615)

A root `manifest.json` with `"version": 2` is laid out by the `manifest-v2`
reader; version 1 keeps its own reader and page roles. The schema is closed in
the same way: an unknown key anywhere is `manifest_unknown_key` (with its path in
`entry`), another version is `manifest_version`.

```json
{ "version": 2, "course": { "subject": "Science" },
  "courseMembers": [ { "path": "unit/supplies.pdf", "role": "attachment", "title": "Supply list" } ],
  "sections": [ { "key": "unit", "title": "Unit", "lessons": [ {
    "key": "l1", "title": "Lesson 1",
    "members": [ { "path": "l1/log.docx", "role": "learner-pages" },
                 { "path": "l1/deck.pptx", "role": "slides" },
                 { "path": "l1/guidance.pdf", "role": "assessment-guidance" } ],
    "pages":  [ { "member": "l1/log.docx", "from": 1, "to": 4, "label": "Mission log" } ],
    "videos": [ { "reference": "dQw4w9WgXcQ", "title": "Recap", "step": 1 } ] } ] } ] }
```

- **Members** (lesson `members` and root `courseMembers`): `path` (must exist, listed
  once), `role` (required) one of `teacher-guide`, `slides`, `learner-pages`,
  `assessment`, `assessment-guidance`, `handout`, `printable`, `answer-key`,
  `attachment` (`manifest_role` otherwise; a video is a reference, never a file),
  optional `audience`, `title` and (lesson members only) `step`. The audience is the role default
  (`LESSON_ASSET_DEFAULT_AUDIENCE`) unless stated; `answer-key` and
  `assessment-guidance` are always guardian (a learner audience is
  `manifest_audience`). Members not listed stay recorded evidence with no role.
- **Lesson steps** (SMRT #4656): a lesson member or video may declare
  `step: { key, order, label? }` (a closed object; `manifest_invalid` for a key over
  32 characters or outside `A-Za-z0-9._:-`, a non-finite or non-number `order`
  (|order| up to 1,000,000), or an empty label; `manifest_unknown_key` for anything
  else, and a course member cannot carry one). Materials that share a `key` are
  one step; fractions order `1b` after `1`. A video's `step` is still accepted as a
  whole number (its rank); the object form also ranks it by `floor(order)`.
- **Pages**: `{ member, from, to, label? }` ranges over a member of the same lesson
  (PDF, Word or PowerPoint; the rendered PDF for Office). Each page becomes a
  `LessonPage` keyed `p<n>`, labelled `<label> <n>` (default `Page <n>`), ordered by
  declaration. Bad, overlapping or unpageable ranges are `manifest_pages`; at most
  500 pages per lesson.
- **Videos**: `{ reference, title, step, audience? }` where `reference` is a bare id
  or an allowlisted https YouTube URL (`parseYouTubeReference`; anything else is
  `manifest_video`), `step` an integer 0-9999 or a lesson step object (see above). They become `LessonExternalVideo`
  rows; nothing is downloaded.
- **Course members** become `CourseAsset` rows, not tied to any lesson.
- **Unit and parts** (SMRT #4632): `course.key` (a manifest key) names the unit
  and `course.title` its course title; `part: { index, count }` (1-50) marks one
  bundle of a unit split across several, and requires `course.key`
  (`manifest_invalid` otherwise). Sections and lessons may carry a unit-wide
  `order` (0-9999); without one the position in this manifest is used, and
  the order counts as implicit when parts are merged.

Guardian-audience text (teacher guides, guidance, keys) never enters a proposed
lesson body; only learner-audience text members do. Under v2 `role` on the member
evidence row is the material role and `audience` the effective audience (NULL on
rows recorded before v2). The plan carries `materials` (also on
`CourseBundleImportResult.materials`): the resolved materials, pages and videos,
plus `skipped` for declared members that were unsupported, refused or failed
rendering. A duplicate member resolves to the earlier identical member's bytes
(`assetPath`) and one material per (place, role, content).

`receiveMember` also gets `audience` and `courseLevel`, and an optional `title`
(SMRT #4653): the manifest title of the one material the member holds ("Teacher
Mission Manual"), so a host can name the assets it stores. It is absent when the
manifest gave none or the member backs several materials with different titles.
**Material titles**: `attachCourse` records that title on the `lesson_assets` /
`course_assets` row (`title`; null on a lesson row without one, `''` on a course
row), the same for the original and rendered halves of a pair. Lesson and course
material views show the row title and fall back to the stored asset's name when
there is none. A re-attach fills a missing title; a different one is a
`conflict` unless `supersede` restates it. **Lesson steps** (#4656): the declared
step is recorded on the `lesson_assets` row (`step_key`, `step_order`, `step_label`;
both halves of an original/rendered pair share it) and on `lesson_external_videos`
(`step_key`, `step_position`, `step_label`; its existing integer `step_order` stays
the rank, `floor(order)` for an object step). All are additive nullable columns.
A re-attach fills a row's missing step without a conflict; a different step is a
`conflict` unless `supersede` restates it (replays are unchanged). Hosts read it
with `SubmissionService.listLessonSteps` ([lesson materials](lesson-materials.md)).
**Slides** keep the original
deck (hand `bytes` to the host as a private asset: "Open in PowerPoint") and its
rendered pages (`rendered`: "Present").

### Attaching a family course (SMRT #4632)

`attachCourse({ ...actor, importId, bundle, assets, courseId?, title?,
licenseKind? })` (`education.course.author`, operation `attach-course-bundle`) is
the published path from an import to a course: in one transaction it creates (or
finds) the family course, its sections and lessons, and writes the materials as
`applyMaterials` does. `assets` maps member path to `{ original, rendered?,
thumbnail? }` asset ids the host stored from `receiveMember`.

- **Course**: a non-authored family draft (`sourceKey` `course-bundle`,
  `sourceRef` the unit key, `licenseKind` default `personal-use-copy`, title from
  the request, `course.title`, subject or first section). Ids derive from (family,
  unit key), sections and lessons from (course, key), so every part of a unit and
  every retry find the same rows. Lessons keep the manifest key in `externalRef`,
  `order` as `sortOrder` and, on creation, learner-audience text as `body` (after
  review choices). Nothing is released or published.
- **Unit key**: `course.key`, else `bundle:<bundleIdentity>` (a one-part unit).
- **Parts**: one `CourseBundleAttachment` per import (unique per import and per
  (course, part)). Attach parts in any order; the result says `part.attached` and
  `part.complete`. Fails closed and writes nothing: a `courseId` of another unit or
  another part count is `unit-mismatch`; a second import for an attached part is
  `part-conflict`. A replay is `replayed: true` and writes nothing new.
- **Shared sections and lessons**: parts that share a key must agree, and the
  result never depends on arrival order. `CourseBundlePlacement`
  (`course_bundle_placements`) records each key's title and whether its order was
  declared. Another title, two different declared orders, or a declared order
  against an implicit one is `part-conflict` (nothing written). Between implicit
  positions the part with the lowest index decides; a lower part arriving later
  re-sorts the row. An existing row with no placement is `part-conflict`.
- **Concurrency**: every attach transaction takes, in order, the import row lock
  (shared with `chooseMaterialAudience` and `applyMaterials`) and the unit lock: a
  `CourseBundleUnit` row (`course_bundle_units`, one per family and unit key)
  created if absent and then locked before anything that decides the outcome
  (attachments, the course, placements, choices) is read. On PostgreSQL a
  concurrent first create of the same unit waits and adopts the winner's row,
  so two first attaches can never both pass the checks.
- **Zero renderings**: with no converter, Word/PowerPoint members are recorded
  `converter_unavailable` and listed in `skipped`; no rendered or original join,
  page or thumbnail is written for them, and nothing is faked. `retryRendering`
  later, then attach again: the replay adds the newly accepted materials.
- `readImport` reports `attachment` (course, unit key, part) once attached.

### Bringing a unit up to a newer build (SMRT #4645)

`attachCourse({ ..., supersede: true })` is the explicit, opt-in way to replace
the build attached for a part. Without it nothing changes: another import for an
attached part is `part-conflict`, and a placement whose title differs is
`part-conflict`. It uses the same authorization (`education.course.author`),
tenant rules and lock order (import row, then unit row) as any attach.

- **Which build is newer**: manifests carry no build stamp, so "newer" is the
  import record: the importing bundle's `recordedAt` must be strictly later
  than the attached import's. Otherwise `stale-build` (an older or
  same-instant build never overwrites a newer one; re-attaching a superseded
  import is the same). `supersede` with no other build attached for the part is
  an ordinary attach.
- **Identity**: sections and lessons keep their ids (derived from course id +
  key), so enrolments, progress and submissions stay attached. Titles and order
  follow the newer build (`renamed` counts changed titles); a key that a lower
  part decided still must agree (`part-conflict`). Lesson `body` is not
  rewritten. Sections and lessons the newer build no longer lists stay.
- **Part count change** stays `unit-mismatch`, supersede or not.
- **Materials**: the newer build's materials are attached; an existing row
  (same lesson, asset, role) is restated in place (order, title, current again; a
  renamed material shows its new title though it keeps its earlier asset),
  not a `conflict`; its audience stays the family's. Pages are restated and
  never retired (learner work points at page keys).
- **Retirement**: file materials and external videos the replaced build wrote
  that the newer build does not carry get `retiredAt`. Rows are never deleted,
  so work that references them still resolves; learner and catalog material
  lists skip retired rows. `retired` counts them. Which rows belong to the
  replaced build: `sourceImportId` (new on `lesson_assets`, `course_assets`,
  `lesson_external_videos`, written by every attach/apply); rows from before it
  existed (null) are adopted when their lesson is one of the replaced import's
  lessons, and course materials when that import had course members. Rows
  from another part or source are never touched. A material that returns in a
  later build is current again.
- **Audit**: the part's `CourseBundleAttachment` moves to the newer import (the
  one sanctioned attachment change, `supersedeWith`) and an append-only
  `CourseBundleSupersession` row (`course_bundle_supersessions`: course, unit
  key, part, new import, replaced import, actor, time) records which replaced
  which. The replaced import no longer reads as attached.
- **Replay** of the same supersede is `replayed: true` and changes nothing.
- Schema (additive): `retired_at` and `source_import_id` on `lesson_assets`,
  `course_assets`, `lesson_external_videos`; table `course_bundle_supersessions`.

### Audience before and after attach

`chooseMaterialAudience({ ...actor, importId, path | video: { lessonKey, videoId },
audience })` (`education.course.author`, operation `choose-course-bundle-audience`)
records a review choice (`course_bundle_audience_choices`, one per import and
target; a later choice replaces it) within the role's bounds: keys and assessment
guidance never become learner material (`invalid-audience`), and a path must be a
declared v2 material of the import. `readImport` lists `audienceChoices`.
`attachCourse` and `applyMaterials` apply them (a slides choice applies to the
rendered pages; the original deck stays guardian). After attach a choice is
`already-attached`: change the row with `SubmissionService.setMaterialAudience`.
On a re-attach an existing row keeps its audience (the family's choice), except an
original, which is repaired to guardian.

### Applying materials

`applyMaterials({ ...actor, importId, bundle, courseId, lessons, assets })`
(`education.course.author`, operation `apply-course-bundle-materials`) writes the
rows in one transaction. The host has stored each accepted member as a private
asset and created the course's lessons: `lessons` maps manifest lesson key to the
`Lesson` id, `assets` maps member path to `{ original, rendered }` asset ids.
Slides join both the original deck (`rendition: 'original'`) and the rendered PDF
(`rendition: 'rendered'`, `renditionOfAssetId` the original); the original join is always
guardian-only whatever the deck's declared audience (the audience applies to the
rendered PDF; the model refuses a learner original), and a join written earlier with a
wider audience is repaired on re-apply (`repaired`); any other Word/PowerPoint
member joins only its rendered PDF, so a learner is never handed an editable
original. `assets[path].thumbnail` is recorded on the rendered join (or a plain
file's own join); rows written before this release get their rendition and
thumbnail filled in on re-apply (`updated`). `LessonAsset`/`CourseAsset` saves keep their private-asset rule (guardian-
only roles and personal-use-copy courses need private assets). It targets
family-owned courses; an authored course is `authored-course` because authored
material changes through course authoring. Idempotent: an identical row is
`unchanged`, a row with other details (order, title, rendition, a video's title or
step) is `CourseBundleMaterialsError('conflict')`; audience is not compared (see
above). A missing asset or lesson is `asset-missing`/`lesson-missing`, a thumbnail
under another owner than its material `asset-owner`; any error writes nothing. A
member named twice (material and page range) is listed once in `skipped`.

### Retrying a failed rendering

`retryRendering({ ...actor, importId, bundle, paths?, receiveMember? })`
(`education.course.author`, operation `retry-course-bundle-rendering`, needs a
converter) renders the Word/PowerPoint members whose first import recorded a
*transient* failure (`converter_unavailable`, `converter_failed`,
`converter_timeout`; `COURSE_BUNDLE_RETRYABLE_REASONS`). The first import's member
rows are never rewritten. A success appends one `course_bundle_renderings` row
per (import, content hash); every reader (`readImport`, replayed imports,
proposals) overlays it, so the member reads `accepted` (identical copies as
duplicates) with its rendered hash. A failure records nothing, so asking again is
always allowed; a second retry of a repaired member is `unchanged` and renders
nothing. Converter rejections, size limits and the Office member cap are not
retryable: change the bundle. The bundle must be the imported one.

## Readers

`BundleReader { formatId, detect, prepare }` in a `BundleReaderRegistry`;
built-ins are `manifest-v2`, `manifest-v1` and `plain-files`. SCORM and Common Cartridge are
**not implemented** (their manifests describe launch resources and activity
trees that do not map to sections/lessons without design); a host can register
a reader ahead of the built-ins (`register(reader, { first: true })`).

`plain-files` has no manifest to say what a file is for, so each member is a
learner-visible `attachment` on its own lesson (Office files as their rendering,
PDFs and images as supplied; Markdown/text also becomes the lesson body). It
never guesses teacher-only files (smrt#4715).

`attachCourse` gives the course, sections and lessons it creates the
deterministic slugs `bundle-course-<id>`, `bundle-section-<id>` and
`bundle-lesson-<id>` (the id is the `bundleUuid`). Slugs are unique per tenant, so
title-derived ones ("files", "lesson-1") collided on a tenant's second course
(smrt#4716). Rows written earlier keep their slugs; replay finds rows by id.

## Identity and replay

`bundleIdentity` (`cbi1-...`) digests the sorted (path, sha256) pairs, so
re-zipping, reordering and timestamps replay. One `CourseBundleImport` per
(tenant, identity); a concurrent first import replays once on the unique index.

## Models (closed, required tenant, no REST/CLI/MCP/AI, append-only)

`CourseBundleImport` (`course_bundle_imports`: identity, format, reader,
manifest version, counts, actor), `CourseBundleMember` (`course_bundle_members`:
unique tenant/import/path; ordinal, sha256, size, media type, kind, status,
reason, duplicate-of, role, audience, section and lesson key) and
`CourseBundleRendering` (`course_bundle_renderings`: a deliberate retry's success). Hashes and placements only:
bytes stay with the host's ingestion receipts. Rewrites and deletes throw.
`CourseBundleAttachment` (`course_bundle_attachments`) and the mutable
`CourseBundleAudienceChoice` (`course_bundle_audience_choices`) and
`CourseBundleSupersession` (`course_bundle_supersessions`, append-only audit of a
newer build taking a part) and
`CourseBundlePlacement` (`course_bundle_placements`) and `CourseBundleUnit`
(`course_bundle_units`) belong to the attach path. Normal manifest migrations create the tables and add `audience` (NULL
on older rows) and, on `lesson_assets`/`course_assets`, `rendition`,
`rendition_of_asset_id` and `thumbnail_asset_id` (additive; older joins read as a
file as supplied with no thumbnail).

## Not in this release

- Material rows for authored courses: a proposal still carries lesson text only;
  authored course material goes through `CourseMaterialInput` and release. The
  family path is `attachCourse`; `proposeStructure` stays the authored-draft path.
- Ingestion's receipt contract is unchanged: there is no `application/zip` part
  type or `parentEvidenceId` in ingestion. The education side unpacks and the
  host receives members one by one, so archive-to-member lineage lives in
  `course_bundle_members` (and the host's receipts), not in ingestion evidence.
  Changing ingestion's published receipt is a separate design decision.
- A manifest/extraction disagreement is not compared automatically.
- SCORM / Common Cartridge readers; zip64; nested archives; encrypted zips.
