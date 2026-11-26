# Bounded HTTP Request & Node Server Helpers (`./http`)

`@happyvertical/smrt-core/http` exports standalone Web Standard `Request` / Node.js `http.IncomingMessage` transport guards (#5674):

- `readBoundedBody(request, maxBytes?)`: enforces declared `Content-Length` before reading and cancels streaming `ReadableStream` bodies immediately when accumulated chunks exceed `maxBytes` (`HttpPayloadTooLargeError`, HTTP 413).
- `parseJsonRequestBody(request, maxBytes?)` and `parseOptionalJsonRequestBody(request, maxBytes?)`: require `application/json` media type and valid UTF-8 JSON (`HttpBadRequestError`, HTTP 400).
- `extractClientIp(request, socketRemoteAddress?, trustProxyHops?)` and `normalizeIpAddress(raw)`: strip `::ffff:` IPv4-mapped IPv6 prefixes and count `trustProxyHops` right-to-left in `X-Forwarded-For` so leftmost client-supplied entries cannot spoof identity.
- `BoundedSlidingWindowRateLimiter` and `HttpTooManyRequestsError`: LRU-bounded sliding window returning `retryAfterSeconds` (>= 1) for HTTP 429 responses, with `refundOne` for transient backend failures. Opt-in `denyWhenFull: true` denies an unknown key (check returns `retryAfterSeconds`, record is a no-op) when the key table is full of live keys instead of LRU-evicting; expired keys are pruned first.
- `createNodeHttpHandler(handle, options?)` and `writeWebResponseToNode(res, response)`: adapt buffered Web `Request`/`Response` handlers to `node:http` (not for SSE or unbounded response streams) with pre-buffering request stream size enforcement, right-to-left `trustProxyHops` `X-Forwarded-Proto` reconstruction, and multi-header `Set-Cookie` preservation.
