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
stages `unpack`, `classify`, `extract`, `propose`; each starts at `completed: 0`).
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
| archive nesting | 1: a zip inside a zip is never expanded |

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

By content (never by extension alone): `pdf` (`%PDF-` in the first 1 KiB),
`image` (PNG, JPEG, WebP), `text` (`.txt`/`.md`, strict UTF-8, no control
characters, body-sized), `manifest` (root `manifest.json`), else `unsupported`.
Status: `accepted` (handed to extraction), `duplicate` (same sha256 as an earlier
member in canonical order; recorded once as evidence, `duplicateOfPath`, never
extracted again), `unsupported` (`unsupported_type`, `nested_archive`,
`unreadable_text`), `refused` (`encrypted_pdf`, `entry_too_large`), `metadata`
(the manifest). Nothing is dropped. An encrypted PDF is any PDF with an
`/Encrypt` token anywhere in its bytes (trailer, xref stream): a false positive
on literal text inside an uncompressed stream is refused, never read.

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
are never inlined.

## Readers

`BundleReader { formatId, detect, prepare }` in a `BundleReaderRegistry`;
built-ins are `manifest-v1` and `plain-files`. SCORM and Common Cartridge are
**not implemented** (their manifests describe launch resources and activity
trees that do not map to sections/lessons without design); a host can register
a reader ahead of the built-ins (`register(reader, { first: true })`).

## Identity and replay

`bundleIdentity` (`cbi1-...`) digests the sorted (path, sha256) pairs, so
re-zipping, reordering and timestamps replay. One `CourseBundleImport` per
(tenant, identity); a concurrent first import replays once on the unique index.

## Models (closed, required tenant, no REST/CLI/MCP/AI, append-only)

`CourseBundleImport` (`course_bundle_imports`: identity, format, reader,
manifest version, counts, actor) and `CourseBundleMember` (`course_bundle_members`:
unique tenant/import/path; ordinal, sha256, size, media type, kind, status,
reason, duplicate-of, role, section and lesson key). Hashes and placements only:
bytes stay with the host's ingestion receipts. Rewrites and deletes throw.
Normal manifest migrations create both tables.

## Not in this release

- Ingestion's receipt contract is unchanged: there is no `application/zip` part
  type or `parentEvidenceId` in ingestion. The education side unpacks and the
  host receives members one by one, so archive-to-member lineage lives in
  `course_bundle_members` (and the host's receipts), not in ingestion evidence.
  Changing ingestion's published receipt is a separate design decision.
- A manifest/extraction disagreement is not compared automatically.
- SCORM / Common Cartridge readers; zip64; nested archives; encrypted zips.
