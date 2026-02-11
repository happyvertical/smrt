# @happyvertical/browser-ai

Browser-side AI utilities for speech-to-text (STT) and text-to-speech (TTS) with multiple adapter backends. Designed for client-side use in web applications.

## Architecture

```
src/
  index.ts              # Export barrel
  core/
    types.ts            # BaseBrowserAIOptions, InitState, OnProgress
  adapters/
    stt/
      types.ts          # STTAdapter interface, STTResult, STTCapabilities
      browser-speech.ts # Browser Web Speech API adapter
      whisper-wasm.ts   # Whisper WASM adapter (whisper.cpp via WebAssembly)
      whisper-cpp.ts    # Whisper.cpp adapter (@remotion/whisper-web)
    tts/
      types.ts          # TTSAdapter interface
      browser-speech.ts # Browser SpeechSynthesis API adapter
```

## Key Exports

- `STTAdapter` — Speech-to-text interface with start/stop/onResult
- `TTSAdapter` — Text-to-speech interface
- `BrowserSpeechSTT` — Native Web Speech API (no download required)
- `WhisperWasmSTT` — Whisper via WASM (offline, model download required)
- `WhisperCppSTT` — Whisper.cpp via @remotion/whisper-web (highest accuracy)

## Key Patterns

- **Two-phase initialization**: Create adapter, then call `ensureInitialized()` (downloads models if needed)
- **Adapter pattern**: All STT/TTS backends implement common interfaces
- **Progress callbacks**: `OnProgress` for model download tracking
- **Browser-only**: No Node.js dependencies, designed for client-side bundles

## Dependencies

- `@remotion/whisper-web` (optional peer dependency for whisper-cpp)
