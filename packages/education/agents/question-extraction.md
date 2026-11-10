# Question extraction from scans and imported courses

`QuestionExtractionService` (SMRT #4517, extends `QuestionAuthoringService`,
consumed by Hearth #80 and #94) turns ingestion proposals into structured,
versioned question records. Risk is high: new schema, a public contract and
idempotent writes. It reuses the course authorizer: preserve and apply need
`education.course.author`; `readExtraction`, `findExtraction` and
`resolveWorksheet` need `education.course.read-draft`. Operations:
`preserve-question-extraction`, `apply-question-extraction`,
`read-question-extraction`, `read-worksheet`.

## Flow

1. Receive the scan or course file through ingestion and extract it (OCR or
   vision, with `observeAnswerRegions` for image region catalogs).
2. Offer `educationQuestionExtractionHandler({ extractions, request })` (from
   `@happyvertical/smrt-education/ingestion`) in the execution catalog and
   generate proposals. Its closed `QUESTION_EXTRACTION_ARGS_SCHEMA` is the
   extracted question set. Keep `requireReview: true` on every policy layer.
   Size the policy `maxBytes` and proposal output limits for whole worksheets:
   up to 200 questions, 400 student-work entries and 1000 pages.
3. `preserveQuestionExtractionAnalysis({ ingestion, extractions, request,
   itemId, expectedWorksheetVersionId?, worksheets? })` reads the completed
   proposal, validates it against retained evidence, matches it and records a
   `QuestionExtractionRecord`. It returns `QuestionExtractionView` for
   extraction review. Not ready, no proposal or competing proposals throw
   `QuestionExtractionPendingError` (`reason`); invalid output throws
   `QuestionExtractionValidationError`. No question records are written.
4. The reviewer previews and decides through ingestion. The handler apply
   calls `applyExtraction` on the ingestion transaction and returns the
   per-question outcomes (`ExtractedQuestionResult[]`, also on `view.applied`).

Hosts without an ingestion proposal (for example a trusted bundle importer)
call `preserveExtraction` directly with their own grounding and extractor
identity, then `applyExtraction`.

## Extraction contract

- Every retained source, and each page the provider reported, has a `pages`
  entry with a role (`exercise`, `example`, `instructions`, `cover`,
  `answer_key`, `mixed`, `unknown`) and readability. A missing page is invalid,
  so unreadable or unsupported content is marked, never dropped. Items that
  cannot be read keep their key and numbering with `status` `unreadable` or
  `unsupported` and a null prompt; other gaps go in `omissions`.
- What ingestion itself did not extract stays visible. A retained original with
  no result, and pages that ingestion omitted or failed, are kept in the
  grounding: the extractor may cite them, and any it does not cover are added as
  `unreadable` pages with a `not_extracted` omission. Truncation and
  `source_incomplete` warnings are carried to `extraction.sourceWarnings` and
  the handler preview. More than 1000 pages is refused, never trimmed.
- Questions hold printed text only. Learner handwriting goes in `studentWork`
  (null `observed` when illegible) and never becomes question content.
- Anchors cite an original `evidenceId`, a physical page the provider
  reported (null when unknown) and a `regionId` from that evidence's
  `observedRegions` catalog. The rect comes from the catalog only; an unknown
  region is invalid. Coordinates are never accepted from the extractor.
- `origin: 'source' | 'inferred'` marks response type, keys, rubrics and points.
  On apply, printed facts get `extracted` provenance and inferred facts get
  `inferred`. An empty key is invalid; a missing key stays null.
- Diagram and media references are kept on the link with their anchor. They
  are not question `media`, which must name a tenant asset.

## Matching

`matchExtractedQuestions(extraction, worksheets, { expectedWorksheetVersionId })`
is pure. A match needs a worksheet identity (the `wsv1-` id generated printables
print in their footer, or a host-supplied expectation), plus the printed
position (`1`, `1.`, `Q1`) of an item on that worksheet. Every claimant of a
position counts, including one that fails a layout check. Section label, a
source-printed response type, and choice and subpart counts must agree. Prompt
text is never used. A printed id that disagrees with the expectation, any layout
conflict, or two items claiming one position is `ambiguous` and stays
unattached. Examples are never matched. `resolveWorksheet` finds a worksheet by
id through `generated_printables`; host-supplied worksheets must be this
tenant's revisions. Student work gets a `questionRevisionId` only when its
question matched. Recording attempts and grades stays with the workbook and
response services.

## Idempotency

`sourceIdentity` is a digest of the source kind and the sorted retained evidence
hashes, never text. Preserve is idempotent per (tenant, intake item, analysis
attempt). A different payload for the same attempt throws
`CourseRequestKeyConflictError`. The payload includes the grounding, the
extractor identity and the expected and supplied worksheets. Apply writes questions through `createQuestion`
with request key `qx:<sourceIdentity>:<questionKey>`, so re-ingesting the same
bytes replays the same questions (`replayed`). Identical prompts under different
keys stay separate records. If the same source is extracted again with different
content, the outcome is `source_changed`: nothing is overwritten. A new scan has
new bytes, so it is a new source, and it links to known questions only by
matching. A repeated apply replays the stored `ExtractedQuestionLink` rows.

Outcomes: `created`, `replayed`, `matched` (these carry a revision),
`needs_review` (ambiguous), `source_changed`, `invalid_content` (fails question
validation), `unreadable`, `unsupported`, `not_an_exercise`.

## Models (closed, required tenant, no REST/CLI/MCP/AI, append-only)

`QuestionExtractionRecord` (`question_extractions`: unique tenant/item/attempt,
indexed source identity, extractor identity, validated extraction and match JSON,
proposal digest) and `ExtractedQuestionLink` (`extracted_question_links`: unique
tenant/extraction/key; outcome, question and revision ids, anchors and media).
Both ship through normal manifest migrations. The originals stay in ingestion
and are never copied. Imported material keeps its course licence; extraction
does not change sharing.

Zip and manifest bundles are handled before extraction by
[CourseBundleImportService](course-bundle-import.md) (SMRT #4578).

Not in this release: automatic new
revisions on `source_changed`, and media assets for extracted diagrams.
