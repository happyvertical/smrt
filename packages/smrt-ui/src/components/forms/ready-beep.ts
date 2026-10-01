/**
 * A short "ready" beep, made with the Web Audio API (no sound files).
 *
 * Browsers only start audio after a user gesture. A long press fires from a
 * timer while the finger is still down, which on touch screens is not a
 * gesture yet, so `playReadyBeep` resolves `false` when the audio could not
 * start; the host plays it again from the release (`pointerup` is a gesture).
 * `primeReadyBeep` creates the audio context early, from a gesture, so later
 * beeps start immediately.
 */

type AudioContextCtor = new () => AudioContext;

let context: AudioContext | null = null;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as typeof window & { webkitAudioContext?: AudioContextCtor };
  return (
    (w.AudioContext as AudioContextCtor | undefined) ??
    w.webkitAudioContext ??
    null
  );
}

function getContext(): AudioContext | null {
  if (context) return context;
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  try {
    context = new Ctor();
  } catch {
    context = null;
  }
  return context;
}

/** Create (or wake) the audio context; call from a user gesture. */
export function primeReadyBeep(): void {
  const ctx = getContext();
  if (ctx && ctx.state === 'suspended') {
    void ctx.resume().catch(() => undefined);
  }
}

export interface ReadyBeepOptions {
  /** Volume, 0–1. Default 0.12. */
  volume?: number;
}

/**
 * Play two quick rising tones (about 0.2s). Resolves `true` when it played,
 * `false` when audio is unavailable or not allowed yet.
 */
export async function playReadyBeep(
  options: ReadyBeepOptions = {},
): Promise<boolean> {
  const ctx = getContext();
  if (!ctx) return false;
  try {
    if (ctx.state === 'suspended') await ctx.resume();
  } catch {
    return false;
  }
  if (ctx.state !== 'running') return false;
  const volume = Math.max(0, Math.min(1, options.volume ?? 0.12));
  const start = ctx.currentTime + 0.01;
  const tones: Array<[frequency: number, at: number]> = [
    [660, 0],
    [990, 0.1],
  ];
  for (const [frequency, at] of tones) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start + at);
    gain.gain.linearRampToValueAtTime(volume, start + at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.09);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start(start + at);
    oscillator.stop(start + at + 0.1);
  }
  return true;
}

/** Tests: forget the shared audio context. */
export function resetReadyBeepForTests(): void {
  context = null;
}
