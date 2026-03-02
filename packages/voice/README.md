# @happyvertical/smrt-voice

Voice profile management for AI-powered voice synthesis and cloning in the SMRT ecosystem. Manages voice profiles, cloning samples, and TTS output with word-level timing for lip-sync.

## Installation

```bash
pnpm add @happyvertical/smrt-voice
```

## Usage

```typescript
import { VoiceProfile, VoiceSample, VoiceOutput } from '@happyvertical/smrt-voice';

// Models are used via SmrtCollection patterns
// VoiceProfile defines a voice with gender, style, and provider settings
// VoiceSample stores audio samples for voice cloning
// VoiceOutput tracks TTS output with word timings
```

## API

### Models

| Export | Description |
|--------|------------|
| `VoiceProfile` | Voice definition with gender, style, provider config, and status |
| `VoiceSample` | Audio sample for voice cloning with quality rating |
| `VoiceOutput` | TTS output with word-level timing data for lip-sync |

### Key Types

| Export | Description |
|--------|------------|
| `VoiceProfileOptions` | Voice profile creation options |
| `VoiceProfileStatus` | Profile lifecycle status |
| `VoiceGender` | Voice gender classification |
| `VoiceSampleOptions` | Sample creation options |
| `SampleQuality` | Sample quality rating |
| `VoiceOutputOptions` | Output creation options |
| `VoiceOutputMetadata` | Output metadata (duration, format, etc.) |
| `WordTiming` | Per-word timing for lip-sync alignment |

## Dependencies

- `@happyvertical/smrt-core` — ORM and code generation
- `@happyvertical/smrt-assets` — base asset management
- `@happyvertical/smrt-config` — configuration loading
- `@happyvertical/smrt-content` — content models
- `@happyvertical/smrt-tenancy` — multi-tenant scoping
