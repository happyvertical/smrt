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
