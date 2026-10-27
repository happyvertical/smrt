# #4428 observed answer regions

Claim6444782449, baseb6e99ea, local publication hold. Standard risk: additive
advisory metadata inside existing source/revision privacy; no authority redesign.
App owner adopts trusted observeAnswerRegions=true with extraction revision
hearth-paper-v5-answer-regions. Root owns provider/original/PG/review/integration.

| Invariant/trigger | Positive | Negative/failure | Actor/executor/runtime | Contract edge/test/validation |
| --- | --- | --- | --- | --- |
| Actual vision observation | opt-in one existing call returns observation text + bounded region catalog | opt-out unchanged, missing/malformed regions preserve valid text, no inferred layout geometry | trusted SDK config; synthetic injected SDK | vision-images test; usage numeric and one-call assertions |
| Display-oriented geometry | EXIF6 uncropped resized image region aligns known synthetic colored area | nonfinite/outside/zero-area/oversize/duplicate regions omitted; PDF omitted | full-frame source image; in-process sharp | observed-regions + vision tests; no live recognition claim |
| Generation references only catalog | exact evidence+region IDs resolve to catalog rect, current question | generated coordinates/missing/foreign source/catalog refs drop only answerRegions | shared authorized snapshot/SQLite+PG | workbook wire bridge tests |
| Durable metadata | immutable AI/guardian copies retain observed provenance, layout independently preserved | malformed region metadata never loses answers/layout; old records absent | existing owning transactional recorder, SQLite+PG | normalizer/workbook workflow tests |
| Correction and privacy | current source region+stable IDs, authorized guardian and exact release | previous capture region rejected; child hidden current/ancestor content remains hidden | existing tenant/current actor+executor+captured release policy | owning workflow privacy/correction tests |

No DDL or new provider requests/model selection. Coordinates are approximate
observations, not verified OCR boxes. Image-only page1 in initial version; PDF and
unknown geometry fall back to existing view. Normalized frame includes the entire
EXIF-oriented image sent to vision; fit-inside scaling preserves correspondence.
Per-source catalog max64, short labels, existing total byte/token/native limits;
assessment placements max200, one per question. Root real alignment acceptance is
required separately; synthetic SDK tests establish framing/transport, not quality.

Integration regression: region catalog discovery treats missing, null, non-string
or non-image MIME hints as unavailable geometry, while preserving authoritative
extraction pins and interpretation queueing. Parameterized bridge test covers all
four fallbacks plus an image catalog positive. Core capture MIME/integrity checks
remain strict; this affects only optional presentation metadata.
