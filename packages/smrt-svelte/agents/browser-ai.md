# smrt-svelte/browser-ai

Module semantics for `src/browser-ai/`. Package orientation and cross-module
invariants live in [../AGENTS.md](../AGENTS.md); read that first.

- **On-device speech** (`whisper-local` = alias `whisper-wasm`, and `moonshine`): thin adapters over
  `@happyvertical/speech/local` (`LocalTranscriber`, or its worker host `serveLocalTranscriber`).
  Push-to-talk (record on `start()`, transcribe on `stop()`, one final result) plus `transcribePcm()`
  for smrt-ui's hands-free mode. Default `onnx-community/whisper-tiny.en` q8 (~45 MB, Cache
  Storage); `model: 'moonshine-tiny'` (~32 MB) / `'moonshine-base'` (~67 MB) or any HF id
  (`LOCAL_SPEECH_MODELS`); WebGPU else single-thread WASM (no COOP/COEP needed). The package never
  imports the peers: a host passes `createWorker` (build it from
  `@happyvertical/smrt-svelte/browser-ai/whisper-worker?worker`, alias `speech-worker`, the one module
  that imports `@happyvertical/speech/local` and `@huggingface/transformers` statically) plus
  `loadSpeech: () => import('@happyvertical/speech/local')`, or `loadModule` for the page thread.
  `createLocalSpeechModel()` (alias `createWhisperLocalModel()`) / `adapter.model` is the consent API
  (`estimateSize`, `isCached`, `load({ onProgress, signal })` with `downloading` -> `extracting` ->
  `complete`); share it via `modelHandle`. English-only handling of `language`/`task` lives in the speech
  package. `probeBrowserSpeech()` -> `works | missing | unreliable` (no network, no mic prompt)
  decides whether to offer it. Sources set `stopTimeoutMs` so `Dictation` waits for the transcription.
- **Inference backends (browser-ai)**: two `@happyvertical/smrt-web/ai` `InferenceBackend`s, both
  `kind: 'local'`, both refusing `tool`/`function` messages, non-string content, `tool_calls` and
  `options.tools` with `InferencePathError` (`unsupported_message`) through the SHARED
  `assertTextOnlyTurn`, so a per-call switch between backends never changes what a turn means.
  - `createWebLlmInferenceBackend()` wraps an `LLMAdapter` — `status` derives from the adapter's
  `initState` (plus an explicit in-flight flag, because the adapter only flips to `initializing`
  after its own awaits), `progress` mirrors `DownloadProgressInfo`, and `load()`/`unload()` drive
  `ensureInitialized`/`unloadModel`. It reports `unavailable` without WebGPU so an `auto` path skips
  it. Pass `adapter` to share the app-state-managed warm-cached adapter; construct once, so two
  callers cannot each start an unshared adapter and a second download.
  Its `loadModule` option matters: the default `importOptional()` resolves a VARIABLE specifier,
  which a browser cannot resolve (`TypeError: Failed to resolve module specifier`) — a host that has
  `@mlc-ai/web-llm` must pass `() => import('@mlc-ai/web-llm')` so the bundler rewrites a static one.
  It does NOT forward `signal` (the adapter has no cancellation seam).
  - `createBitGpuInferenceBackend()` wraps `bitgpu` (MIT, optional peer), the engine behind the
    Bonsai WebGPU demo PrismML's own docs list as their in-browser option. `loadBitGpu`/`loadChat`
    are REQUIRED loaders (`() => import('bitgpu')`, `() => import('bitgpu/chat')`) — a static import
    here would fail the build for every consumer without the optional peer, and a bare specifier is
    not resolvable by a browser either. `bitgpu`'s `LoadProgress.phase` maps to `InferenceProgress`
    (`manifest`/`weights` → `downloading`, `pipelines` → `extracting`). Unlike the WebLLM backend it
    **forwards `signal`** — bitgpu aborts a live generation — and it does NOT lazily load: weights
    run to GBs, so a turn before `load()` fails with a named reason. `model` in the per-call options
    is ignored (one engine binds one model), and bitgpu's tools/JSON-schema/think support is
    deliberately left unexposed for now so the text-only invariant holds across backends.
- **`ModelStatusControl.svelte`**: the user-facing model lifecycle surface (state, Load/Unload,
  download progress) driven entirely by a backend's own `status`/`progress`/`subscribe`, so it works
  without a `<Provider>` ancestor. `unavailable` is a first-class state that offers NO load action.
