/**
 * Browser AI Module Svelte Components
 *
 * Optional Svelte UI components for AI capabilities.
 * Auto-registers components with ModuleUIRegistry on import.
 *
 * @packageDocumentation
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
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

// Note: Component prop types (AILoadingOverlayProps, etc.) are available
// via svelte-package build output but cannot be re-exported here because
// tsc --noEmit cannot resolve type exports from .svelte files.

// Auto-register with ModuleUIRegistry
ModuleUIRegistry.registerModule(BROWSER_AI_MODULE_META);
ModuleUIRegistry.register(
  '@happyvertical/smrt-svelte/browser-ai',
  'ai-loading-overlay',
  AILoadingOverlay,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-svelte/browser-ai',
  'capability-gate',
  CapabilityGate,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-svelte/browser-ai',
  'download-progress',
  DownloadProgress,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-svelte/browser-ai',
  'stt-test',
  STTTest,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-svelte/browser-ai',
  'voice-input',
  VoiceInput,
);
