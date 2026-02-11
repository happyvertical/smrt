/**
 * Browser AI Module Svelte Components
 *
 * Optional Svelte UI components for AI capabilities.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-svelte/registry';
import { BROWSER_AI_MODULE_META } from '../ui.js';

// Import components
import AILoadingOverlay from './components/AILoadingOverlay.svelte';
import CapabilityGate from './components/CapabilityGate.svelte';
import DownloadProgress from './components/DownloadProgress.svelte';
import STTTest from './components/STTTest.svelte';
import VoiceInput from './components/VoiceInput.svelte';

// Export components
export {
  AILoadingOverlay,
  CapabilityGate,
  DownloadProgress,
  STTTest,
  VoiceInput,
};

// Export component prop types
export type { Props as AILoadingOverlayProps } from './components/AILoadingOverlay.svelte';
export type { Props as CapabilityGateProps } from './components/CapabilityGate.svelte';
export type { Props as DownloadProgressProps } from './components/DownloadProgress.svelte';
export type { Props as STTTestProps } from './components/STTTest.svelte';
export type { Props as VoiceInputProps } from './components/VoiceInput.svelte';

// Auto-register with ModuleUIRegistry
ModuleUIRegistry.registerModule(BROWSER_AI_MODULE_META);
ModuleUIRegistry.register(
  '@happyvertical/browser-ai',
  'ai-loading-overlay',
  AILoadingOverlay,
);
ModuleUIRegistry.register(
  '@happyvertical/browser-ai',
  'capability-gate',
  CapabilityGate,
);
ModuleUIRegistry.register(
  '@happyvertical/browser-ai',
  'download-progress',
  DownloadProgress,
);
ModuleUIRegistry.register('@happyvertical/browser-ai', 'stt-test', STTTest);
ModuleUIRegistry.register(
  '@happyvertical/browser-ai',
  'voice-input',
  VoiceInput,
);
