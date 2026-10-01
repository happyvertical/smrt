---
'@happyvertical/smrt-web': minor
---

`installWebMcpPageToolRegistry()` records every `registerTool` call on a
recording `document.modelContext` (forwarding to the native one), so an in-page
assistant can list and run the same tools an outside agent sees. Registrars
stamp their resolved effect under `WEBMCP_TOOL_EFFECT`. Proposal tools are
branded by their execute function, and only branded tools auto-run in the
assistant dock.
