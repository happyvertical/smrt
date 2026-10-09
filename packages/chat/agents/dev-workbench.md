# Chat dev workbench: browser inference and draft form

Reference for the `pnpm --dir packages/chat dev` workbench root route
(`src/routes/+page.svelte`). Linked from [../AGENTS.md](../AGENTS.md).

## Browser inference path

The root route drives the **browser inference path**
(`@happyvertical/smrt-web/ai`) end to end, which is what the workbench exists to
exercise now: THREE backends — `createBitGpuInferenceBackend()` (Bonsai 1.7B,
~237 MB, the dev-loop default), `createWebLlmInferenceBackend()`, and
`createRouteInferenceBackend()` over `/api/dev-chat-stream` — composed by
`createInferencePath({ backends: [bitgpu, local, route] })`. The local backends
are listed first, so `auto` prefers one whenever it is READY; the route backend is
always ready, so `auto` always has somewhere to land. The status panel's Inference
selector pins `auto` / `bitgpu` / `local` / `route`, it renders a
`ModelStatusControl` per local backend, and the reply is rendered as it streams.
`/api/dev-chat` is retained as the non-streaming reference endpoint; the workbench
no longer calls it.

Four dev-config facts this depends on:

- The workbench injects `loadModule: () => import('@mlc-ai/web-llm')` and, for
  bitgpu, `loadBitGpu`/`loadChat` as `() => import('bitgpu')` /
  `() => import('bitgpu/chat')`. A browser resolves only STATIC specifiers — the
  adapters' own optional-import helpers use variable ones — so without these the
  optional peers fail to load and (for WebLLM) the error misreports the package as
  "not installed".
- bitgpu's per-model `manifest.json` + `.aux.bin` come from its repo via jsDelivr;
  the Bonsai GGUF streams from the Hub; the tokenizer comes from
  `onnx-community/Bonsai-1.7B-ONNX` because `prism-ml/Bonsai-1.7B-gguf` ships no
  `tokenizer.json`.
- `workspace-aliases.js` must list every deep `@happyvertical/smrt-ui/*` subpath
  a consumer reaches. A string alias is a PREFIX match, so the bare
  `@happyvertical/smrt-ui` entry rewrites any unlisted subpath under it into a
  bogus path under `src/index.ts`. That includes STYLESHEETS:
  `@happyvertical/smrt-ui/themes/styles/all.css` needs its own entry or the app
  renders with no theme variables at all.
- The workbench imports `@happyvertical/smrt-ui/themes/styles/{all,fonts}.css`.
  `ThemeProvider` for a BUILT-IN preset only sets `data-theme` /
  `data-color-scheme` on its wrapper — it deliberately emits no inline variables,
  because built-ins ship their palette as static CSS. Without the import the
  attributes are present, `--smrt-color-*` resolves to nothing, and every themed
  surface paints transparent (which reads as "dark mode is broken" in a dark
  scheme). `smrt-workbench/host` is the reference for this.

## Agent-addressable draft form

The workbench also carries an **agent-addressable draft form**: an `Input` inside
a `Form`, bound by `useViewIntent` to the intent declared in
`src/routes/chat-dev.intents.ts` (#2588). It is the end-to-end demonstration of the
control-interaction stack — an agent stages, a human applies. Four things about it
are non-obvious and cost time to find:

- **No `<Provider>` here, so both seams must be explicit.** `useViewIntent` is a
  documented silent no-op without a Provider ancestor, so the binding passes
  `controlRegistry` directly; and `effects: ['read', 'write']` supplies the
  exposure policy, because the default is read-only and would exclude a `stage`.
- **`inputSchema` on the declaration is REQUIRED for the tool to be callable.**
  `compileViewIntentToolSpec` passes it through verbatim, but
  `buildControlCommand` throws `IntentArgumentError('value')` for a `stage` with
  no `value`. Without it the tool registers, advertises
  `{"type":"object","properties":{}}`, and fails at call time with Chrome's
  `UnknownError: Failed to parse input arguments`.
- **`document.modelContext.executeTool(tool, args)` takes the tool OBJECT from
  `getTools()` and the arguments as a JSON STRING** — an object as the second
  argument fails the same way.
- **Apply needs a genuinely trusted gesture.** The registry refuses a
  programmatic `element.click()` (`event.isTrusted === false`) for `apply`, which
  is the stage→apply consent split doing its job. Verification must use a real
  input event, not `evaluate(() => button.click())`.

## Voice and local character persistence

The root workbench also has a dev-only voice conversation mode. It reads voice
gateway connection details through `/api/dev-voice/config`, streams browser mic
audio to `WS /ws/voice` as PCM16 mono, appends gateway transcripts/responses to
the chat, and plays returned TTS audio. Exposing
`SMRT_CHAT_DEV_VOICE_GATEWAY_TOKEN` to the browser requires
`SMRT_CHAT_DEV_VOICE_GATEWAY_EXPOSE_TOKEN=true`; keep that local-only.

### Local character persistence

`/api/dev-character-persistence` is an opt-in loopback-only demo bridge for
the photographic character workbench. It is disabled unless
`SMRT_CHAT_DEV_CHARACTER_PERSISTENCE=true`; it accepts neither actor, tenant,
nor profile ids from the browser. Its server configuration names one
pre-provisioned profile and tenant plus a temporary SQLite database and asset
directory, all under the operating system temporary directory. First run
`DATABASE_URL=<the same SQLite path> pnpm smrt db:migrate`, then run
`pnpm exec tsx src/scripts/provision-dev-character-persistence.ts` with the
`SMRT_CHAT_DEV_CHARACTER_*` variables set. The route never creates schema.
Use fresh UUIDs for `SMRT_CHAT_DEV_CHARACTER_PROFILE_ID` and
`SMRT_CHAT_DEV_CHARACTER_TENANT_ID`; keep the database and asset directory in
the OS temporary directory, for example `/tmp/smrt-character-setup/` on Linux
or the path reported by `node -p "require('node:os').tmpdir()"` on macOS.

This is not production authentication. A production host must provide its
authenticated principal, tenant, and authorization policy to
`PhotoCutoutProfileStore`; it must not copy this fixed local identity pattern.

### Character conversation lifecycle

The Character conversation tab refreshes the persisted rig each time it becomes
active, retaining its AssistantDock controller and history. Leaving the tab stops
microphone input and reply playback; listening mode requires an explicit restart.
An outstanding turn keeps both the listening input and full dock composer busy
across mode changes and restarts until it settles. Both inputs share the retained
controller’s pending-send state; microphone Stop remains reachable. Polling
retains active sends until their transport completes, even when older history
contains the same message text.
Late persistence loads and cancelled speech responses cannot replace the current
rig or audio. Spoken captions begin only when SDK playback actually starts.

The development transport sends at most 24 context messages within a 16 KiB UTF-8
JSON body, dropping oldest context first. Failed turns are not committed to its
history, so retrying does not duplicate them. Draft proposals use one shared
200-character limit in the model tool, route, preview, and execution boundary.
