---
'@happyvertical/smrt-chat': minor
---

Earlier QA-branch additions and fixes in smrt-chat:

- Streamed assistant turns (`runAssistantTurn`, `createAssistantTurnResponse`
  as SSE) that suspend on browser tool calls into a single-use, expiring
  continuation store and resume with the browser's results; the wire contract
  ships as `@happyvertical/smrt-chat/assistant-turn`. The tool loop offers
  browser-executed `clientTools` (validated against a server allow-list),
  cancellation, `initialSteps`, `onStep` and `onUsage`. Each streamed step runs
  in the caller's async (tenant) context, and continuation writes re-read the
  session first.
- `AssistantDock` runs the page's WebMCP tools (reads run, consent-gated writes
  run, other writes wait for Allow, destructive always waits), previews
  data-surface actions for confirmation, and shows streamed status with Stop.
- **Security:** a turn sends a generic error and code to the browser, never
  raw error messages (`AssistantTurnUserError` codes excepted; details go to a
  server-side `onError`). Generated `AgentSession` reads never return
  `sessionContext` (the in-flight transcript). Tool errors are classified:
  401/403 → not permitted, 400/404/409/422 and validation errors →
  invalid request with an actionable message, 429 and the rest → execution
  error.
- Touch targets: the composer's attach button and the narrow dock's
  Conversations toggle are 44px; message text is 16px on phones.
