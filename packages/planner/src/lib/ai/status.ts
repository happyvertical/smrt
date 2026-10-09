import type { SessionStatus } from '../assistant/session.svelte.ts';
import type { VoiceStatus } from '../assistant/voice.svelte.ts';

/**
 * What the three capabilities look like to the visitor, derived from the
 * session states. Pure, so the sidebar icons, the setup page and the tests
 * share one reading.
 *
 * - ready: set up and working right now
 * - available: can be set up (or switched on) here
 * - off: this browser cannot do it
 */
export type CapabilityId = 'think' | 'hear' | 'speak';
export type CapabilityState = 'ready' | 'available' | 'off';

export interface CapabilitySummary {
  id: CapabilityId;
  /** "Think", "Hear", "Speak". */
  name: string;
  state: CapabilityState;
  /** The accessible name and tooltip: "Think: Qwen3 1.7B ready". */
  label: string;
}

export interface CapabilityInput {
  think: {
    status: SessionStatus;
    /** The selected model's short name. */
    model: string;
    /** Loading progress, 0 to 1. */
    progress: number;
    /** A model has been downloaded before. */
    downloaded: boolean;
  };
  hear: {
    status: VoiceStatus;
    /** The browser has a microphone API at all. */
    mic: boolean;
  };
  speak: {
    /** The browser has speech synthesis. */
    supported: boolean;
    readAloud: boolean;
  };
}

export function deriveCapabilities(
  input: CapabilityInput,
): CapabilitySummary[] {
  return [
    thinkSummary(input.think),
    hearSummary(input.hear),
    speakSummary(input.speak),
  ];
}

function thinkSummary(t: CapabilityInput['think']): CapabilitySummary {
  const base = { id: 'think', name: 'Think' } as const;
  if (t.status === 'unsupported') {
    return {
      ...base,
      state: 'off',
      label: 'Think: unavailable, this browser has no WebGPU',
    };
  }
  if (t.status === 'ready') {
    return { ...base, state: 'ready', label: `Think: ${t.model} ready` };
  }
  if (t.status === 'loading') {
    return {
      ...base,
      state: 'available',
      label: `Think: ${t.model} loading, ${Math.round(t.progress * 100)}%`,
    };
  }
  return {
    ...base,
    state: 'available',
    label: t.downloaded
      ? `Think: ${t.model} downloaded, not loaded`
      : 'Think: not set up',
  };
}

function hearSummary(h: CapabilityInput['hear']): CapabilitySummary {
  const base = { id: 'hear', name: 'Hear' } as const;
  if (!h.mic) {
    return {
      ...base,
      state: 'off',
      label: 'Hear: unavailable, this browser has no microphone access',
    };
  }
  if (h.status === 'browser') {
    return {
      ...base,
      state: 'ready',
      label: 'Hear: voice typing ready, using your browser',
    };
  }
  if (h.status === 'ready') {
    return {
      ...base,
      state: 'ready',
      label: 'Hear: voice typing ready, using the downloaded model',
    };
  }
  if (h.status === 'downloading') {
    return {
      ...base,
      state: 'available',
      label: 'Hear: downloading the speech model',
    };
  }
  return { ...base, state: 'available', label: 'Hear: not set up' };
}

function speakSummary(s: CapabilityInput['speak']): CapabilitySummary {
  const base = { id: 'speak', name: 'Speak' } as const;
  if (!s.supported) {
    return {
      ...base,
      state: 'off',
      label: 'Speak: unavailable, this browser has no speech synthesis',
    };
  }
  if (s.readAloud) {
    return {
      ...base,
      state: 'ready',
      label: 'Speak: reading replies aloud with browser voices',
    };
  }
  return { ...base, state: 'available', label: 'Speak: not switched on' };
}

/** What the visitor has set up, for the first-visit decision. */
export interface SetupFacts {
  /** They downloaded a language model before. */
  thinkDownloaded: boolean;
  /** They downloaded the speech model before. */
  hearDownloaded: boolean;
  readAloud: boolean;
  /** They chose "I don't need AI". */
  dismissed: boolean;
  /** They already built something (recipes or features). */
  built: boolean;
}

/**
 * Whether the first thing shown is the AI setup form: only for a visitor who
 * has set nothing up, has not said they do not need AI, and has nothing built.
 */
export function needsFirstRunSetup(facts: SetupFacts): boolean {
  if (facts.dismissed || facts.built) return false;
  return !(facts.thinkDownloaded || facts.hearDownloaded || facts.readAloud);
}
