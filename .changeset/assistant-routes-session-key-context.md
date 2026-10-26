---
'@happyvertical/smrt-chat': minor
---

`mountAssistantRoutes` gains a `sessionKey` option (default `assistant-dock`, so existing hosts are unchanged; `null` adopts the actor's unkeyed assistant session) so a host can keep listing and continuing assistant threads created before it adopted the routes. Send and resume bodies accept an optional, validated, size-bounded (8 KiB) `context` object, exposed to per-request callbacks as `AssistantRequestContext.requestContext`, and `createAssistantHttpTransport` takes a matching `context` option.
