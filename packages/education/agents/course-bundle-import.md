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
`renderedSizeBytes`; bytes are still not retained here.

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
  optional `audience` and `title`. The audience is the role default
  (`LESSON_ASSET_DEFAULT_AUDIENCE`) unless stated; `answer-key` and
  `assessment-guidance` are always guardian (a learner audience is
  `manifest_audience`). Members not listed stay recorded evidence with no role.
- **Pages**: `{ member, from, to, label? }` ranges over a member of the same lesson
  (PDF, Word or PowerPoint; the rendered PDF for Office). Each page becomes a
  `LessonPage` keyed `p<n>`, labelled `<label> <n>` (default `Page <n>`), ordered by
  declaration. Bad, overlapping or unpageable ranges are `manifest_pages`; at most
  500 pages per lesson.
- **Videos**: `{ reference, title, step, audience? }` where `reference` is a bare id
  or an allowlisted https YouTube URL (`parseYouTubeReference`; anything else is
  `manifest_video`), `step` an integer 0-9999. They become `LessonExternalVideo`
  rows; nothing is downloaded.
- **Course members** become `CourseAsset` rows, not tied to any lesson.

Guardian-audience text (teacher guides, guidance, keys) never enters a proposed
lesson body; only learner-audience text members do. Under v2 `role` on the member
evidence row is the material role and `audience` the effective audience (NULL on
rows recorded before v2). The plan carries `materials` (also on
`CourseBundleImportResult.materials`): the resolved materials, pages and videos,
plus `skipped` for declared members that were unsupported, refused or failed
rendering. A duplicate member resolves to the earlier identical member's bytes
(`assetPath`) and one material per (place, role, content).

`receiveMember` also gets `audience` and `courseLevel`. **Slides** keep the original
deck (hand `bytes` to the host as a private asset: "Open in PowerPoint") and its
rendered pages (`rendered`: "Present").

### Applying materials

`applyMaterials({ ...actor, importId, bundle, courseId, lessons, assets })`
(`education.course.author`, operation `apply-course-bundle-materials`) writes the
rows in one transaction. The host has stored each accepted member as a private
asset and created the course's lessons: `lessons` maps manifest lesson key to the
`Lesson` id, `assets` maps member path to `{ original, rendered }` asset ids.
Slides join both the original deck and the rendered PDF; any other Word/PowerPoint
member joins only its rendered PDF, so a learner is never handed an editable
original. `LessonAsset`/`CourseAsset` saves keep their private-asset rule (guardian-
only roles and personal-use-copy courses need private assets). It targets
family-owned courses; an authored course is `authored-course` because authored
material changes through course authoring. Idempotent: an identical row is
`unchanged`, a row with other details is `CourseBundleMaterialsError('conflict')`,
a missing asset or lesson is `asset-missing`/`lesson-missing`; any error writes
nothing.

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
Normal manifest migrations create the tables and add `audience` (NULL on older rows).

## Not in this release

- Material rows for authored courses: a proposal still carries lesson text only;
  authored course material goes through `CourseMaterialInput` and release.
- Ingestion's receipt contract is unchanged: there is no `application/zip` part
  type or `parentEvidenceId` in ingestion. The education side unpacks and the
  host receives members one by one, so archive-to-member lineage lives in
  `course_bundle_members` (and the host's receipts), not in ingestion evidence.
  Changing ingestion's published receipt is a separate design decision.
- A manifest/extraction disagreement is not compared automatically.
- SCORM / Common Cartridge readers; zip64; nested archives; encrypted zips.
