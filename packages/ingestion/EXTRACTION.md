# Extraction adapters

`@happyvertical/smrt-ingestion/server` exports `createSDKExtractionAdapter`,
`extractAnalysis`, extraction types, and `proposeDocumentSplits`. Root and DTO
exports remain browser-safe. No extraction result authorizes a business action.

Hosts construct the SDK adapter with explicit provider/model/version identities
(`unknown` for unavailable model/version), credential-bearing SDK options, and
`nativeMemoryIsolation: 'host-enforced'`. This last setting is an assertion by
trusted deployment configuration, never a source/body/client option. Deploy the
provider child under an OS/container native-memory ceiling. Node's heap limit
cannot bound native allocations, and PDF's renderer has no pre-render pixel
limit. Without that host guarantee, adapter construction refuses to run. A
configured provider must be pinned, not `auto`; OCR fallback is disabled so
capability provenance cannot silently change. Identity objects are projected onto
exactly `provider`, `model`, and `version`, each a required nonblank string. Extra
host fields never enter capability or segment identities, including through
trusted custom adapter results at the publication boundary.

The adapter forks one disposable Node process per retained part. Deadline or
cancellation kills it (and its process group on POSIX); provider stdout/stderr
are discarded. Calls are sequential and bounded by input bytes, page count,
image decode pixels, serialized output, vision tokens, elapsed time and Node
heap. Native memory remains the host boundary described above. Remote compute
already accepted by a provider may continue/bill after the local process dies.
Do not interpret a local cancellation as remote billing cancellation.

Persist `{extraction: {configurationRevision, limits}}` using `service.analyze`,
then claim its lease. Call `extractAnalysis(service, lease, adapter, options)`
with exactly that revision and limits. The service reloads the immutable input
snapshot and rechecks current processing authority before each provider and
before publication. The production child requests a parent-side authorization
handshake before each PDF/OCR/vision/speech operation, including calls on later
pages. Denial kills the child; already transmitted material cannot be recalled.
Custom trusted adapters must await `request.beforeProviderCall` before every
provider invocation. Bytes are read through the service's integrity-checked
reader; revoked, expired, foreign-scope, forged and stale leases fail closed.
A retry keeps the same analysis input revision; changed provider/model/options
must use a new configuration revision and `analyze` request key. Credentials are
never placed in persisted configuration or provider identity.

Results retain the original evidence ID/hash/part/parent references. Ordered
segments form whole-document context; extraction does not split originals into
business records. Valid UTF-8 JSON, text and HTML remain literal source text (render HTML
only through an application sanitizer). JSON syntax is validated without rewriting
its source text; malformed JSON or UTF-8 fails extraction. PDF text is extracted one page at a
time, falling back to actual rendered-page OCR for empty pages. Embedded text
is not evidence that every visual element was understood. TIFF is actually
decoded page-by-page with sharp to PNG; each result cites its original TIFF page.
Animated non-TIFF images are unsupported. Ordinary image OCR and scene vision
are separately configured. Speech uses source-level text unless actual segment
timestamps are returned; absent speech confidence calibration is unknown.

Confidence and boxes are explicitly null unless an OCR provider advertises and
returns them. Unlimited-OCR's synthetic common confidence is always discarded,
even if an injected capability claims otherwise. Measured OCR values retain an
unknown calibration label; they are not routing certainty or approval. Boxes
are in decoded image pixels, attached only to that actual page/source. No tables
are invented: the current PDF/OCR text APIs do not supply a table contract.

The persisted receipt's `maxOutputBytes`, exposed by `getAnalysisInput`, bounds
the complete serialized analysis envelope across all parts, including provenance,
capabilities, usage, and failure metadata. Extraction reserves room for a `limit`
outcome and retains fitting earlier parts/segments when the aggregate is too
large. Top-level `truncated` and `omittedEvidenceCount` identify publication
omissions; per-result omissions retain every discarded segment's exact page or
time location. Existing errors and omitted ranges survive trimming unchanged.
If those diagnostic records cannot fit, the entire result is omitted rather than
publishing an incomplete account of its known failures. If the ceiling
cannot fit the minimum result envelope, no provider runs: `failAnalysis` records
only a fixed safe category and terminal lifecycle state, with no provider output
or output digest. That service-owned failure accounting is outside the provider
payload budget; `completeAnalysis` never accepts an oversized result.

Partial page results survive later failures or process timeout. Warnings and
omitted page/source references remain inspectable. `unsupported_type` covers
video, unconfigured media and encrypted PDF; corrupt decoder failures without a
safe typed SDK category are `unavailable`, never raw exception strings. A host
can repair/reconfigure and create a fresh analysis without rewriting originals.
`proposeDocumentSplits` produces a hashed, versioned, non-executable grouping of
observed pages; overlap, unordered groups and nonexistent pages are rejected.

## Evidence and limitations

`pnpm --filter @happyvertical/smrt-ingestion test:providers` runs actual local PDF
SDK extraction, actual sharp multipage TIFF decoding, and packaged process/HTTP
adapter lifecycle tests. The local speech server tests adapter transport and
termination, not transcription quality. The tiny TIFF fixture proves IFD/page
mapping, not fax OCR accuracy. `extraction.test.ts` injects deterministic SDK
boundaries for mixed/scanned PDF, Unlimited-OCR, camera observations, message
attachments, audio timestamps and malformed/partial output. These fixtures are
not real remote-provider integrations and are not the ADR evaluation corpus.

No live Unlimited-OCR, speech recognition or vision quality run is claimed.
No recorded-human-audio recognition accuracy, real camera-scene quality,
calibrated confidence, table extraction, or automatic-action acceptance is
established by these tests. Deployment owners must run the intended provider,
model and representative retained corpus before making those claims. The
[behavior matrix](../../docs/test-matrix/3672-ingestion-extraction.md) records the
release commands and authority obligations.

The versioned on-disk corpus manifest records exact hashes for valid embedded,
raster and mixed PDFs, two-page TIFF, a synthetic camera-format JPEG, a valid
PCM WAV recording of a generated tone, email text, corrupt PDF and unsupported
video. The tone is not human speech; the illustrated scene is not a photograph.
Real local HTTP fixture runs execute Unlimited-OCR's installed SDK and speech
transport against deterministic responses/timeouts. They verify adapters, not
remote models. Unlimited-OCR 0.61.6 rejects valid encoded images smaller than
100 bytes; ingestion reports `unavailable` without altering them. This owning
SDK defect is tracked in [happyvertical/ocr#143](https://github.com/happyvertical/ocr/issues/143).

Each capability record explicitly reports `truncation` and `usage` as `unknown`
or `reported`. Unlimited-OCR's current SDK discards upstream `finish_reason`
and token usage, so both are `unknown` even for nonempty output. Downstream
rules must not interpret `status: 'complete'` or `truncated: false` as proof of
untruncated OCR: they describe completed input processing and *detected*
truncation only. The adapter never bypasses the SDK to recover hidden fields.
The missing SDK metadata is tracked in [happyvertical/ocr#144](https://github.com/happyvertical/ocr/issues/144).
AI vision retains reported truncation when supplied by its SDK. Missing provider
cost is unknown, not zero; no cost estimate is invented.
