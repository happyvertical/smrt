# #4405 bounded vision images

Claim/cycle: 6430699669. Base: 949d9ed91e2949aa6d2e68620c51a6d787328d7c.
Local-only train; no publication. Root owns containers, model calls, real-photo
retries and final quality/review gates. Worker uses synthetic images only.

## Contract and risks

Vision preparation retains the entire frame, auto-orients EXIF, never upscales,
and fits within 2048 pixels. Opaque images use JPEG quality 85, then 80 only if
needed; transparent images retain alpha in PNG. Encoded derivatives must fit
512 KiB; otherwise return `limit` before a provider call. Optional trusted limits
may tighten these defaults, never expand them. Raw input byte/pixel/native-memory,
process deadline and live authorization limits remain in force. OCR and PDF OCR
retain their original full-resolution PNG/coordinate contract.

Downsampling/lossy encoding can lose small text detail. Geometry and contrast
checks do not establish remote handwriting recognition quality. The provider must
report unreadable text honestly; retained originals remain available for review.
Derivative metadata records the versioned policy, source/output dimensions,
format, quality and encoded byte count without replacing original evidence.

## Tests and evidence

- Synthetic 4000x3000 EXIF6 JPEG: inspect actual chat data URL, portrait orientation,
  full-frame colored landmarks/text strokes, JPEG MIME/dimensions/byte cap,
  immutable original bytes/hash/evidence and source location.
- Transparent image: preserve alpha and declared PNG MIME, no white flattening.
- Oversize/unreadable: original pixel ceiling and corrupt data fail without chat;
  too-small encoded budget fails explicitly instead of further shrinking content.
- OCR: full source dimensions/PNG remain unchanged, including forced PDF OCR.
- Configuration: default safe; invalid/expanded limits rejected; child adapter
  forwards optional trusted limits. Provenance contains no provider credentials.
- Root acceptance: retry both saved uploads, compare visible work to provisional
  marking/feedback, retained originals/history and guardian publication boundary.

Record red/green commands, exits and artifact hashes under external issue evidence.

## Worker validation

- Base plus initial regression file: `vitest run src/vision-images.test.ts`
  exited 1 (4 failed, 2 passed): existing PNG transport/orientation, missing
  provenance, missing byte-cap failure and absent trusted-bound validation.
- Final focused command: `pnpm --filter @happyvertical/smrt-ingestion exec vitest
  run src/vision-images.test.ts src/extraction.test.ts
  src/extraction.providers.test.ts src/extraction-service.test.ts`: 51 passed,
  exit 0. Includes packaged SDK local HTTP transport and SQLite publication.
- Source/test TypeScript, package build/browser import gate, scoped Biome and
  knowledge graph generation: exit 0. No containers or paid model calls.
- Detailed command/exit artifacts: external session `evidence/4405` directory.
  Root owns integrated gates, independent review and both retained-photo retries;
  worker tests do not claim real handwriting/assessment quality.
