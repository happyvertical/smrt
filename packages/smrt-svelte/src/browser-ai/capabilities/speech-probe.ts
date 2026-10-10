/**
 * Should a host offer local (downloadable) speech recognition?
 *
 * The browser's own speech recognition (`SpeechRecognition`) is a thin
 * client for a vendor speech service, so "the API exists" does not mean it
 * works. This looks only at what the browser exposes: it makes no network
 * request and never opens the microphone (so there is no permission prompt).
 *
 * - `'works'`: Chrome-family browsers with the API (Chrome, Edge, Safari).
 * - `'missing'`: no `SpeechRecognition` at all (Firefox).
 * - `'unreliable'`: the API is there but has no speech service behind it:
 *   Brave (it ends instantly or fails with `network`), or an embedded
 *   Chromium (Electron) with no vendor speech key.
 *
 * Anything but `'works'` is a reason to offer the local model. A recogniser
 * that still turns out to end instantly is caught later by smrt-ui's
 * dictation state machine, which reports it as an error.
 */
export type BrowserSpeechSupport = 'works' | 'missing' | 'unreliable';

/** The browser objects the probe reads; injectable for tests. */
export interface BrowserSpeechProbeEnv {
  window?: Record<string, unknown>;
  navigator?: { userAgent?: string; brave?: unknown };
}

export async function probeBrowserSpeech(
  env: BrowserSpeechProbeEnv = {},
): Promise<BrowserSpeechSupport> {
  const win =
    env.window ??
    (typeof window !== 'undefined'
      ? (window as unknown as Record<string, unknown>)
      : undefined);
  const nav =
    env.navigator ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  if (!win) return 'missing';
  if (!('SpeechRecognition' in win) && !('webkitSpeechRecognition' in win)) {
    return 'missing';
  }
  // Brave defines `navigator.brave`; its recogniser has no service behind it.
  if (nav && 'brave' in nav && nav.brave) return 'unreliable';
  // Electron ships the API without the vendor speech key.
  if (/\bElectron\//.test(nav?.userAgent ?? '')) return 'unreliable';
  return 'works';
}
