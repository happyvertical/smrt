/**
 * Motion helpers shared by the shell lists. Durations come from the
 * `--smrt-duration-*` theme tokens (never literals) so a theme controls the
 * pace, and everything collapses to zero under `prefers-reduced-motion`.
 */
import { flip } from 'svelte/animate';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const DEFAULT_TOKEN = '--smrt-duration-short4';

/** True when the user asked for reduced motion (false off the browser). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(REDUCED_MOTION).matches
  );
}

/** Parses a CSS `<time>` (`200ms`, `0.2s`) to milliseconds; 0 when unparsable. */
export function parseCssTime(value: string): number {
  const match = /^(-?\d*\.?\d+)(ms|s)$/.exec(value.trim());
  if (!match) return 0;
  const amount = Number(match[1]) * (match[2] === 's' ? 1000 : 1);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/**
 * Reads a duration token (`--smrt-duration-short4`) off `element` (or the
 * document root) and returns it in milliseconds. Returns 0 under reduced
 * motion, off the browser, or when the token is missing, so callers can pass
 * the result straight to a Svelte `duration` option.
 */
export function tokenDuration(name: string, element?: Element | null): number {
  if (prefersReducedMotion()) return 0;
  if (
    typeof document === 'undefined' ||
    typeof getComputedStyle !== 'function'
  ) {
    return 0;
  }
  const target = element ?? document.documentElement;
  return parseCssTime(getComputedStyle(target).getPropertyValue(name));
}

/** `animate:` function: FLIP reorder with a token-driven duration. */
export function flipRow(
  node: Element,
  rects: { from: DOMRect; to: DOMRect },
  params: { token?: string } = {},
) {
  return flip(node, rects, {
    duration: tokenDuration(params.token ?? DEFAULT_TOKEN, node),
  });
}
