# M4 test design — #3210

Risk: high; named trigger: cross-host message and mounted interaction security boundary.
New feature: base-regression comparison N/A (no bridge at base). All data synthetic.
Browser has no persistence/authorization engine: executor/transaction N/A throughout;
server retains authorization and transaction ownership for forwarded operations.
Supported runtime is standards-based browser; Chromium is the executable reference
gate, not evidence of an external host product.

| Behavior/invariant | Reachable trigger | Positive | Negative/failure | Actor/context | External contract edge | Level / command |
|---|---|---|---|---|---|---|
| Initialization | Mount iframe | Pinned version, identity, capabilities and required context | Wrong version, malformed/missing cap/context | Bound host window/origin | Apps initialize; schema/prose discrepancy | Unit + Chromium / test, test:e2e |
| Message confinement | postMessage | Bound window, exact origin | Sibling, wrong/null origin, malformed/oversize/deep payload, wrong/duplicate ID | Host vs hostile sender | JSON-RPC and resource bounds | Unit + Chromium / test, test:e2e |
| Tool routing | callTool | Correlated text/structured result | Missing cap, malformed result, upstream error, cancellation | Host forwards; server authorizes | tools/call | Unit + Chromium / test, test:e2e |
| Optional features | Link/message/context/display | Supported modality/mode | Missing/unknown cap, rejection, unsafe URL | Embedded client | Content arrays/modality caps from pinned schema | Unit / test |
| Lifetime | Dispose/teardown/remount | Listeners removed, pending rejected | Late data, duplicate terminal event, timeout/abort | Mounted owner | Teardown and cancellation | Unit + Chromium / test, test:e2e |
| Registry reuse | Local intent | Surface intent, stage proposal | Disposed binding, no direct apply/remote closures | Agent proposal vs trusted human | Public intent compiler | Browser / test:e2e |
| Reference fallback | List/detail render | Text/structured data, review link | No tools/link caps, tool error | Synthetic viewer | No final approval/submission | Chromium / test:e2e |
| CSP/budget | Resource rendering | Inline bundle below 100KiB | Network/external assets blocked | Sandboxed browser | M3 metadata/deterministic HTML | Chromium / test:e2e |
| Package boundary | Published imports | Browser entry, explicit Svelte subpath | No server/Svelte deps in bridge | Package consumer | Packed exports | build, typecheck, verify:pack |

## M3 integration completion

| Behavior/invariant | Reachable trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime | Contract edge | Level / command |
|---|---|---|---|---|---|---|---|---|
| Resource transport | Load reference iframe | M3 prepared/read resource digest/MIME/CSP preserved | Revoked resource/tool policy denies; budget fails | Synthetic server principal vs unprivileged caller | N/A, read-only workflows | Node host + Chromium view | M3 prepare/readResource + callTool | Browser / test:e2e |
| Readable navigation | 320/390px and keyboard | Wrapping URL, no horizontal overflow, tab/enter list-detail-review | Focus clipping/offscreen targets | Keyboard/mobile reader | N/A | Chromium | Reference UI | Browser / test:e2e |
| Stale call isolation | Two overlapping detail calls | Latest result rendered | Delayed superseded result ignored | Same mounted client | N/A, read-only | Chromium | request correlation + abort | Browser / test:e2e |
| Reconnect isolation | Dispose/remount new client | New handshake and calls succeed | Old response ID cannot settle new request | New view lifetime | N/A | Chromium | initialize + random ID generation | Browser / test:e2e |
| Extension observation | Handshake/context notification | Bounded raw context/capabilities, snapshot isolation | Oversize/cycle/prototype/accessor, post-disposal updates, no capability elevation | Configured host vs extension consumer | N/A | Browser + unit fixture | Generic snapshot; extension owns field schemas | Unit / test |

## Optional extension transport seam (pre-review M6 integration)

This extends #3210 before independent review. Extension method/schema ownership
stays in opt-in adapter packages; the bridge owns one transport and local lifecycle.
No wire version is invented for capabilities without one. An explicitly declared
version selector must match. The already negotiated Apps protocol is always required.

| Behavior/invariant | Reachable trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime | Contract edge | Level / command |
|---|---|---|---|---|---|---|---|---|
| Extension registration | Initialized bridge registers declaration | Plain-object capability path, explicit copied method/notification allowlists, optional matching version | Missing/malformed cap, unknown version, reserved methods, duplicate/colliding registration, mutated declaration | Trusted app declaration + bound host | N/A; transport only | Browser + unit | Optional extension capability negotiation | test |
| Guarded requests | Registered handle requests listed method | Correlated bounded plain JSON response; extension metadata on native text methods | Unlisted method, role/modality/base-capability bypass, malformed payload/response/upstream error | Registered owner | N/A; server retains authority | Browser + unit | Existing JSON-RPC transport | test + test:e2e |
| Notifications/lifetime | Bound host sends listed notification | Isolated params, matching active listeners | Unknown name, wrong window/origin, oversized/cyclic/prototype/accessor, host request pretending to notify, after unsubscribe/dispose/remount | Bound host vs hostile message; mounted owner | N/A | Browser + unit | Notification dispatch and lifecycle cancellation | test + test:e2e |

## Accepted round-1 review regressions

| Behavior/invariant | Reachable trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime | Contract edge | Level / command |
|---|---|---|---|---|---|---|---|---|
| Review destination follows validated current detail | Select second opportunity, then receive stale first response | Both displayed URL and host open-link use second id | Stale response cannot retarget review | Human reader + bound synthetic host | N/A read-only viewer | Chromium | ui/open-link | test:e2e; baseline red before fix |
| Arrays remain bounded plain JSON | Structured-cloned context/extension notification with named array property | Dense bounded data arrays accepted | Named oversized property, sparse/accessor indices, custom iterator rejected without execution; prior context unchanged | Bound host + registered observer | N/A transport | Browser wire clone + Node unit | structured clone / JSON boundary | test; baseline red before fix |
