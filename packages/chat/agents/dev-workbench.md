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
