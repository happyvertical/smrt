/**
 * Browser AI Module UI Slot Declarations
 *
 * This file defines the UI extension points for the browser-ai module.
 * UI components are implemented in the ./svelte subpath.
 */

import type { ModuleUISlot, SmrtModuleMeta } from '@happyvertical/smrt-types';

/**
 * Browser AI module UI slots
 */
export const BROWSER_AI_UI_SLOTS: Record<string, ModuleUISlot> = {
  'ai-loading-overlay': {
    id: 'ai-loading-overlay',
    label: 'AI Loading Overlay',
    description: 'Loading overlay for AI operations',
    icon: 'loader',
    category: 'display',
    order: 1,
    propsInterface: 'AILoadingOverlayProps',
  },
  'capability-gate': {
    id: 'capability-gate',
    label: 'Capability Gate',
    description: 'Conditionally render content based on AI capabilities',
    icon: 'shield',
    category: 'action',
    order: 2,
    propsInterface: 'CapabilityGateProps',
  },
  'download-progress': {
    id: 'download-progress',
    label: 'Download Progress',
    description: 'Progress indicator for model downloads',
    icon: 'download',
    category: 'display',
    order: 3,
    propsInterface: 'DownloadProgressProps',
  },
  'stt-test': {
    id: 'stt-test',
    label: 'STT Test',
    description: 'Speech-to-text testing component',
    icon: 'mic',
    category: 'form',
    order: 4,
    propsInterface: 'STTTestProps',
  },
  'voice-input': {
    id: 'voice-input',
    label: 'Voice Input',
    description: 'Voice input component with STT',
    icon: 'mic',
    category: 'form',
    order: 5,
    propsInterface: 'VoiceInputProps',
  },
};

/**
 * Browser AI module metadata
 */
export const BROWSER_AI_MODULE_META: SmrtModuleMeta = {
  name: '@happyvertical/browser-ai',
  displayName: 'Browser AI',
  description: 'Browser AI capabilities: STT, TTS, LLM with adapter pattern',
  uiSlots: BROWSER_AI_UI_SLOTS,
  models: [],
  collections: [],
};
