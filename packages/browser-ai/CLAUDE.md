# @happyvertical/browser-ai

Framework-agnostic browser AI capabilities - STT, TTS, LLM with adapter pattern.

## Svelte Components

This package includes Svelte 5 UI components for AI capabilities.

### Installation

```bash
npm install @happyvertical/browser-ai
```

### Usage

```typescript
import {
  AILoadingOverlay,
  CapabilityGate,
  DownloadProgress,
  STTTest,
  VoiceInput,
} from '@happyvertical/browser-ai/svelte';
```

### Components

- **AILoadingOverlay** - Loading overlay for AI operations
- **CapabilityGate** - Conditionally render content based on AI capabilities
- **DownloadProgress** - Progress indicator for model downloads
- **STTTest** - Speech-to-text testing component
- **VoiceInput** - Voice input component with STT

### Types

```typescript
import type {
  AILoadingOverlayProps,
  CapabilityGateProps,
  DownloadProgressProps,
  STTTestProps,
  VoiceInputProps,
} from '@happyvertical/browser-ai/svelte';
```

### Auto-registration

Importing from `/svelte` auto-registers components with `ModuleUIRegistry`:

```typescript
import '@happyvertical/browser-ai/svelte'; // Auto-registers all components

// Later, retrieve from registry
const Component = ModuleUIRegistry.get('@happyvertical/browser-ai', 'voice-input');
```
