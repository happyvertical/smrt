# @happyvertical/smrt-voice

Voice profile management for AI-powered text-to-speech synthesis and voice cloning. Supports voice design via natural language descriptions or audio sample cloning.

## Architecture

```
src/
  index.ts              # Export barrel
  voice-profile.ts      # Voice identity definition
  voice-sample.ts       # Audio samples for cloning
  voice-output.ts       # Generated TTS output (extends Content)
  types/                # Shared types
```

## Key Models

- `VoiceProfile` — Voice identity: name, language, gender, designPrompt OR sampleAssetId, status (pending/processing/ready/failed)
- `VoiceSample` — Audio training data for cloning: voiceProfileId, assetId, duration, transcription, quality (low/medium/high)
- `VoiceOutput` — Generated audio (extends Content): voiceProfileId, wordTimings for lip-sync, metadata (sampleRate, format, channels, provider, model)

## Key Patterns

- **Two creation modes**: Design prompt (describe voice) OR sample-based cloning (provide audio)
- **Word timings**: VoiceOutput includes `WordTiming[]` array for lip-sync alignment (word, start, end)
- **Audio metadata**: Tracks sampleRate, format, channels, bitDepth, fileSize, provider, model, speed, pitch
- **Content inheritance**: VoiceOutput extends Content for content management features
- **Multi-tenancy**: Optional tenant scoping via `@TenantScoped`

## Dependencies

- `@happyvertical/smrt-core`, `@happyvertical/smrt-tenancy`
- `@happyvertical/smrt-content` (Content base for VoiceOutput)
- `@happyvertical/smrt-config`, `@happyvertical/utils`
