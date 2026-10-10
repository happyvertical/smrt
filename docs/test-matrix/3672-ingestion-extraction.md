# #3672 extraction behavior contract

Risk: high. Named trigger: the new public `getAnalysisInput` lease/evidence
authorization boundary and fenced payload-free `failAnalysis`; independent review must cover current-grant and snapshot
integrity enforcement as well as extraction adapters.

Runtime: repository Node 26.10.0. Extraction itself has no SQL executor; durable
publication uses `IngestionService` and its transaction/fence. Provider fixtures
are deterministic contract tests, never accuracy measurements. Real SDK tests
are identified separately. No automated action eligibility is emitted.

| Behavior / invariant | Reachable trigger | Positive | Negative / failure | Actor / context | Executor / transaction | Runtime / dialect | External edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Original identity and relationships | Extract retained part | Hash, parent and part preserved | Digest mismatch | Authorized service caller | Read through foundation; no provider SQL | Node; SQLite/PostgreSQL service | Bytes | Integration | `pnpm --filter @happyvertical/smrt-ingestion test` |
| Page and source granularity | PDF, TIFF, image, message | Ordered pages, source text, real TIFF decode | Corrupt/encrypted/unsupported; no fabricated boxes | Host configured provider | N/A: pure extraction | Node | PDF/OCR/sharp | Contract + real local SDK | `pnpm --filter @happyvertical/smrt-ingestion test:providers` |
| Unknown confidence | Unlimited OCR / absent capability | Text retained; confidence null | Synthetic 100 never measured | Same | N/A: pure extraction | Node | Capability discovery | Contract | `pnpm --filter @happyvertical/smrt-ingestion test` |
| Bounded execution | Oversize, timeout, cancellation | Budgeted sequential pages | Terminated worker; partial output retained | Host limits | N/A: worker isolation | Node | Provider/process | Integration | `pnpm --filter @happyvertical/smrt-ingestion test:providers` |
| Open result contracts | Provider output | Text/times and available usage | Missing fields, malformed ranges, unknown finish reason | Same | N/A: pure extraction | Node | Speech/AI/OCR | Contract | `pnpm --filter @happyvertical/smrt-ingestion test` |
| Reprocessing and publication | New config revision / current lease | Immutable provenance and current fenced completion | Revocation/stale completion denied | Actor × tenant × confidential scope | Foundation transaction | SQLite/PostgreSQL | Public service | Integration | `pnpm --filter @happyvertical/smrt-ingestion test`; `pnpm --filter @happyvertical/smrt-ingestion test:postgres` |
| Proposed splits | Validated page groups | Versioned derivative references | Invalid/overlapping/out-of-range groups | Authorized caller | N/A: derived output, not business mutation | Node | None | Contract | `pnpm --filter @happyvertical/smrt-ingestion test` |

Feature implementation: base-regression failure comparison is N/A (no extraction
API exists at base). Fixtures include embedded/scanned/mixed PDF contracts,
multipage/multiple-document scans, TIFF fax, scene, email/attachments, recorded
audio, corrupt and unsupported media. These are extraction boundary examples,
not the ADR held-out routing evaluation corpus. No quality threshold is claimed.

Round-two blocker regressions run on SQLite and PostgreSQL: actual packaged child
and installed Unlimited-OCR HTTP adapter process a two-raster-page PDF; revoking
authority, expiring the lease, or superseding the analysis during page-one OCR
must leave the HTTP request count at one. The old worker produced two requests
in all three cases. Multipart budget tests include individually fitting outputs
whose aggregate exceeds the receipt ceiling, oversized capability metadata, and
ceilings of 1, 128, and 192 bytes. They verify bounded retained work, terminal
`limit` accounting, no provider call for insufficient envelopes, consistent
item/analysis/dispatch projections, and foreign/revoked/stale failure denial.

Round-three regressions seed extra credential fields in structurally typed host
identities, exercise the packaged PDF child, and verify that custom adapter
identity extras never reach persisted output on either database. Missing or
blank required identity fields are rejected. Injected already-partial PDF, TIFF,
and audio results under small publication ceilings retain existing failure
categories and omitted ranges plus exact locations of removed segments. When
diagnostic metadata itself cannot fit, the whole result is explicitly omitted.
