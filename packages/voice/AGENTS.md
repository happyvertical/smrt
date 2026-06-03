# @happyvertical/smrt-voice

TTS voice profiles with two creation modes: AI design or audio cloning. Word-level timing output for lip-sync.

## Models

- **VoiceProfile**: two mutually exclusive modes — `designPrompt` (AI-generated from description) XOR `sampleAssetId` (cloned from audio). Status: `pending → processing → ready/failed`. `voiceData` is opaque provider-specific storage. `defaultSpeed` (0.5-2.0), `defaultPitch` (-20 to 20 semitones).
- **VoiceSample**: audio training data. `duration`, `transcription`, `quality` (low/medium/high), `sampleRate`, `format`. Validation: `meetsMinDuration` (≥3 sec), `isSuitableForCloning` (≥3 sec AND quality ≠ low).
- **VoiceOutput** (extends Content): generated TTS audio. `sourceText`, `audioAssetId`, `wordTimings` array `[{word, start, end}]` in seconds for lip-sync. `audioMetadata` (sampleRate, format, channels, bitDepth, provider, model). Computed: `wordCount`, `wordsPerSecond`, `getWordAtTime(seconds)`.

## Gotchas

- **Default provider hardcoded**: 'qwen3-tts' — no provider abstraction layer
- **Sample minimum not enforced in constructor**: 3-sec minimum documented but not validated on create
- **WordTiming from external provider**: framework doesn't generate timings — populated by TTS service
- **Status transitions not enforced**: can manually set status without triggering generation workflow
- **voiceData is opaque**: `{ [key: string]: any }` — provider-specific, no schema
- **Optional tenancy**: tenantId=null for global/default voices
