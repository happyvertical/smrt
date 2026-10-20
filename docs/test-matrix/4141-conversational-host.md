# SMRT #4141 conversational host contract

Named high-risk trigger: trusted host callback can initiate a host-owned external mutation. The generic package executes no domain backend call and never derives authority from model output.

| Behavior/invariant | Reachable trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level/command |
|---|---|---|---|---|---|---|---|---|
| Only current native user send invokes host callback | sendMessage | detached actual user/full thread callback once per request id | seed, restored history, sendHostMessage, model content do not invoke | current native visitor | host callback owns mutation; N/A generic package has no DB | browser TS / no SQL | callback null continues; callback failure stops inference | unit: pnpm --filter @happyvertical/smrt-planner exec vitest run tests/assistant-host-turn.test.ts |
| Reset suppresses late completion | reset while host callback waits | greeting restored, busy false | late host result cannot reappear | current workspace | generation fence; backend rollback N/A owned by host | browser TS / no SQL | already submitted external operation cannot be undone | same unit command |
| Storage is provenance only | injected storage restore | full native thread restored | restoration never executes callback; malformed data ignored | same browser workspace | facade owns Remember/session routing | browser Storage / no SQL | unavailable storage does not make model authority | same unit command |

Current focused executable evidence: `/tmp/conversational-host-test.log`; typecheck `/tmp/conversational-planner-typecheck.log`. Website-specific intent/contact/disclosure/idempotency is tested in the consuming studio, not copied into Planner.

## Live native reset regression

`BrowserAssistant` observes the transport's reset-only `resetRevision` and keys
only `AssistantDock` by it. The dock owns its rendered messages/composer/pending
state; clearing transport history alone does not clear that mounted private UI.
Ordinary message notifications retain the existing dock/composer.

`tests/browser-assistant-reset.dom.test.ts` proves old rendered messages disappear
without page reload, native history becomes the greeting, fresh turns remain in
the new thread, ordinary turns do not remount the composer, and an inference
promise resolving after reset cannot restore its old request/reply. The same
DOM assertion fails with the key removed (base behavior), recorded at
`/tmp/native-reset-base-failure.log`; fixed head and existing host reset tests
pass at `/tmp/native-reset-fix-tests.log` (4 tests).
