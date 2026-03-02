# @happyvertical/smrt-voice

Voice profile management for AI-powered voice synthesis and cloning in the SMRT ecosystem. Manages voice profiles, cloning samples, and TTS output with word-level timing for lip-sync.

## Installation

```bash
pnpm add @happyvertical/smrt-voice
```

## Usage

```typescript
import { VoiceProfile, VoiceSample, VoiceOutput } from '@happyvertical/smrt-voice';

// Two mutually exclusive creation modes:

// 1. Voice design -- AI generates voice from a natural language prompt
const designed = new VoiceProfile({
  name: 'News Anchor',
  language: 'en-US',
  gender: 'male',
  designPrompt: 'Warm, authoritative male voice with clear enunciation',
  defaultSpeed: 1.0,   // 0.5 - 2.0
  defaultPitch: 0,     // -20 to 20 semitones
});
await designed.save();

// 2. Voice cloning -- replicate voice from audio sample(s)
const cloned = new VoiceProfile({
  name: 'Custom Voice',
  language: 'en-US',
  sampleAssetId: 'asset-123',
});
await cloned.save();

// Add training samples for cloning (minimum 3 seconds, quality != low)
const sample = new VoiceSample({
  voiceProfileId: cloned.id,
  assetId: 'asset-456',
  duration: 5.2,
  transcription: 'Hello, this is a test recording for voice cloning.',
  quality: 'high',
  sampleRate: 48000,
  format: 'wav',
  isPrimary: true,
});
await sample.save();

// TTS output with word-level timing for lip-sync
const output = new VoiceOutput({
  voiceProfileId: designed.id,
  sourceText: 'Welcome to the evening news.',
  audioAssetId: 'asset-789',
  duration: 2.8,
  wordTimings: [
    { word: 'Welcome', start: 0.0, end: 0.4 },
    { word: 'to', start: 0.4, end: 0.5 },
    { word: 'the', start: 0.5, end: 0.6 },
    { word: 'evening', start: 0.6, end: 1.0 },
    { word: 'news', start: 1.0, end: 1.3 },
  ],
});
// Look up which word is being spoken at a given timestamp
output.getWordAtTime(0.7); // { word: 'evening', start: 0.6, end: 1.0 }
```

## API

### Models

| Export | Description |
|--------|------------|
| `VoiceProfile` | Voice identity with two modes: `designPrompt` (AI-generated) or `sampleAssetId` (cloned) |
| `VoiceSample` | Audio training data for voice cloning with quality rating |
| `VoiceOutput` | Generated TTS audio (extends Content) with word-level timing for lip-sync |

### Types

| Export | Description |
|--------|------------|
| `VoiceProfileStatus` | Lifecycle status: `pending`, `processing`, `ready`, `failed` |
| `VoiceGender` | Gender classification: `male`, `female`, `neutral` |
| `SampleQuality` | Audio quality rating: `low`, `medium`, `high` |
| `WordTiming` | Per-word timing entry: `{ word, start, end }` (seconds) |
| `VoiceOutputMetadata` | Audio metadata: sampleRate, format, channels, bitDepth, provider, model |
| `VoiceProfileOptions` | Profile creation options |
| `VoiceSampleOptions` | Sample creation options |
| `VoiceOutputOptions` | Output creation options |

### Key Computed Properties

- `VoiceProfile.isCloned` / `isDesigned` -- which creation mode is active
- `VoiceProfile.isReady` -- status equals `ready`
- `VoiceSample.meetsMinDuration` -- duration >= 3 seconds
- `VoiceSample.isSuitableForCloning` -- meets min duration AND quality != low
- `VoiceOutput.wordCount` / `wordsPerSecond` -- computed from sourceText and duration
- `VoiceOutput.getWordAtTime(seconds)` -- look up word being spoken at a timestamp

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-assets` -- base asset management
- `@happyvertical/smrt-config` -- configuration loading
- `@happyvertical/smrt-content` -- content models (VoiceOutput extends Content)
- `@happyvertical/smrt-tenancy` -- multi-tenant scoping
