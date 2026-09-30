# @happyvertical/smrt-mcp-apps

Framework-neutral, browser-only **view-side** bridge for portable MCP Apps.
It is not a server adapter, host/sandbox implementation, authorization layer or
WebMCP tool registrar. Importing it does not require a browser until construction.

## Usage

```ts
import { McpAppBridge } from '@happyvertical/smrt-mcp-apps';

const bridge = new McpAppBridge({
  hostWindow: window.parent,
  hostOrigin: 'https://trusted-host.example',
  appInfo: { name: 'Opportunity viewer', version: '1.0.0' },
});
await bridge.connect();
if (bridge.snapshot.hostCapabilities.serverTools) {
  const result = await bridge.callTool('opportunity_list', {});
  // Render text with textContent and validate domain-shaped structuredContent.
}
// Owning component unmount:
bridge.dispose();
```

Supply the immediate parent window and its exact origin from trusted deployment
configuration. Do not learn them from the first message, URL query, untrusted
referrer or tool arguments. The same window and origin remain bound for the
instance lifetime. HTTPS is required except explicit loopback HTTP development.
Opaque (`null`) parent origins and wildcard targets are intentionally unsupported;
a host with an opaque immediate sandbox proxy needs a reviewed transport design.
The view itself may have an opaque origin. Host authentication stays outside it.

## Supported contract

Pinned upstream revision: `82221c0c8ce7661efa6771c9d461511b1650495f`.
The [runtime schema](https://github.com/modelcontextprotocol/ext-apps/blob/82221c0c8ce7661efa6771c9d461511b1650495f/src/generated/schema.ts)
is authoritative for implemented fields; its
[protocol constant](https://github.com/modelcontextprotocol/ext-apps/blob/82221c0c8ce7661efa6771c9d461511b1650495f/src/spec.types.ts)
is `2026-01-26`, independent of server MCP `2026-07-28`.
The same revision's
[prose examples](https://github.com/modelcontextprotocol/ext-apps/blob/82221c0c8ce7661efa6771c9d461511b1650495f/specification/2026-01-26/apps.mdx)
differ: `ui/message` shows singleton content and omits message/context modality
capabilities, whereas the runtime schema uses a content array, capability modality
objects, required `hostContext`, optional tool-input arguments and optional
cancellation reason. Contract tests pin these runtime shapes explicitly.

Implemented methods: initialize/initialized, server `tools/call`, `ui/open-link`,
text `ui/message`, text/structured `ui/update-model-context`, display-mode requests,
size notifications, ping and resource teardown. Tool input/result/cancellation
and host-context notifications are accepted only after initialization. Exactly one
complete initial input and terminal result/cancellation are accepted; late or
out-of-order updates are ignored. Partial input is ignored. No app-tools capability
is advertised; inbound `tools/call` receives method-not-found. Resource proxying, sampling and downloads have no built-in typed adapter; an
opt-in extension adapter may register a bounded contract below. Binary content
in built-in tool results and executable host CSS remain unsupported.
Unknown capabilities never grant a supported feature. Unsupported tool content
modalities reject explicitly. Text and structured results remain available without
interactive capabilities; consumers must retain a normal app/review URL fallback.

Host context exposes only theme, display mode(s), platform, locale and timezone.
Unknown context fields are ignored by the typed projection; executable CSS/tool
definitions are never applied. `snapshot.rawHostContext` and
`snapshot.rawHostCapabilities` retain bounded JSON for opt-in extension adapters.
Context notifications merge into the raw context; capabilities remain fixed at
handshake. Every snapshot/observer receives an isolated clone. Extension adapters
must validate their own fields and treat raw data as untrusted; raw capabilities
cannot enable typed methods or bypass their gates. There is no global arbitrary RPC method. Optional adapters must explicitly
register the capability-gated contract described below. Unknown supported-field enum values fail closed. A missing display-mode
list permits only inline. Host rejection (`isError: true`) and RPC errors propagate.

Payload limits: 24 nested levels, 4096 array items, 1024 object keys, conservative
128 KiB character/node budget; text blocks 32 KiB, 128 blocks; 32 pending requests;
15-second default timeout (configurable 1–120000 ms). Cycles/non-JSON/accessors and
prototype keys are rejected. Requests use per-instance random correlated IDs.
Timeout, abort and disposal reject pending calls and send best-effort cancellation.
Disposal removes the listener, aborts `signal`, and clears observers. Cancellation
is not a rollback guarantee: server workflows retain idempotency/transaction rules.

## Svelte and mounted interactions

Explicitly import `useMcpApp` and `useMcpAppIntent` from
`@happyvertical/smrt-svelte/mcp-apps`. `useMcpApp(() => options)` constructs only on
mount and disposes on unmount; its state contains `bridge`, `snapshot` and `error`.
Use `bridge.signal` or an owned abort signal for associated asynchronous work.

`useMcpAppIntent(intent, binding)` binds an existing public view-intent declaration
to a mounted ControlInteractionRegistry or DataSurfaceRegistry. It uses the public
`compileViewIntentToolSpec` implementation and requires no `document.modelContext`.
It is a component-local callable, never forwarded or advertised as a remote tool.
Control proposals remain agent-sourced; existing trusted human staged review owns
application of values. The component owns registry registrations and their cleanup.
No new REST engine, browser permission engine or final-submission API is introduced.

## Validation

After `pnpm install` and documented dependency builds:

- `pnpm --filter @happyvertical/smrt-mcp-apps build`
- `pnpm --filter @happyvertical/smrt-mcp-apps typecheck`
- `pnpm --filter @happyvertical/smrt-mcp-apps test`
- `pnpm --filter @happyvertical/smrt-mcp-apps test:e2e`
- `pnpm --filter @happyvertical/smrt-mcp-apps verify:pack`
- `pnpm --filter @happyvertical/smrt-svelte check`
- `pnpm --filter @happyvertical/smrt-svelte exec playwright test -c e2e/playwright.config.ts mcp-apps.spec.ts`

The Chromium host fixture bundles an Iolaus-shaped synthetic list/detail viewer,
prepares and reads it through the public M3 resource APIs, and routes host-proxied
calls through `createMcpAppServer` with a server-owned synthetic principal.
It checks resource digest/MIME/CSP metadata and revoked-resource/tool denial,
raw generated HTML below 100 KiB, and hash-only script/style CSP with no external
network/assets. Browser gates cover hostile messages, capability absence,
repeated teardown/reconnect, late superseded results, and keyboard navigation at
320/390px without horizontal overflow. The visible review URL wraps and remains
copyable even where sandbox policy blocks opening a new window. The Svelte browser fixture uses real public registries and a genuine
Playwright click to apply a staged proposal; fabricated approval is denied.
These fixtures prove synthetic browser behavior only. No actual OpenAI or other
external host compatibility is claimed. M3 resource metadata still requires the
host to enforce CSP and sandbox permissions; the browser bridge cannot enforce a
host's policy on its behalf. The reference view only opens a human-review URL and
contains no candidate records or transmission/approval operation.


## Optional extension contracts

`bridge.registerExtension(definition)` returns a `McpAppExtension` only after the
Apps handshake completes and the declaration's capability path selects a plain
object in the initialized host capabilities. Declarations are trusted local code;
never derive capability paths or method lists from host/model input. For example:

```ts
const resources = bridge.registerExtension({
  id: 'example.resources',
  capability: { path: ['experimental', 'example/resources'] },
  methods: ['resources/read', 'resources/subscribe', 'resources/unsubscribe'],
  notifications: ['notifications/resources/updated'],
});
const unsubscribe = resources.subscribe((method, params) => {
  // Adapter validates its exact URI/schema/ownership before acting.
});
const result = await resources.request('resources/read', { uri: 'test://fixture' });
// Validate the extension's exact result schema before consuming it.
unsubscribe();
resources.dispose();
```

If a wire capability declares a version, specify
`capability.version: { key: 'version', supported: ['1'] }`; mismatches reject.
Omit this field for capabilities without wire versions rather than inventing one.
The bridge copies declarations and permits at most 16 registrations, 16 request
methods and 16 notification names per registration, and 32 listeners per handle.
Duplicate IDs/method ownership, unlisted requests, reserved lifecycle/tool methods
and malformed JSON reject. Unknown notifications are ignored; host requests never
invoke notification callbacks. Every observer receives isolated bounded data.

Native `ui/message` and `ui/update-model-context` are narrow allowlist exceptions
for extension metadata: the core capability and text/structured modality gates,
user role, text-content shape/limits and failure-result checks still apply in
addition to the extension capability. No image modality or tool-call bypass is
introduced. Extension adapters own semantic metadata/result validation and any
additional application authorization, not this transport API.

The handle shares the existing bound host/origin, JSON budget, 32-pending limit,
correlated IDs and timeout behavior. `signal` aborts on handle or bridge disposal;
pending work rejects and later notifications/results cannot revive the handle.
A new registration has a new lifetime. Adapters should request remote unsubscribe
before disposal when practical; teardown aborts immediately and does not wait for
a host acknowledgement. This is cancellation, not a server rollback guarantee.
