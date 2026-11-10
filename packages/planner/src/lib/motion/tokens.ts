/**
 * smrt-ui's motion tokens, read for the Svelte transitions and animations
 * (`animate:flip`) that take a number of milliseconds rather than CSS.
 *
 * CSS-side usages should write the token directly with a fallback, e.g.
 * `var(--smrt-duration-short3, 150ms)`; this is only for the JS side. Reduced
 * motion collapses every duration to 0 so the animation is skipped outright.
 */
import { prefersReducedMotion } from './view-transition.ts';

export type MotionDurationToken =
  | 'instant'
  | 'short1'
  | 'short2'
  | 'short3'
  | 'short4'
  | 'medium1'
  | 'medium2'
  | 'medium3'
  | 'medium4'
  | 'long1'
  | 'long2'
  | 'long3'
  | 'long4';

const cache = new Map<string, number>();

/**
 * `--smrt-duration-<token>` in milliseconds, else `fallback` where the theme
 * CSS is not loaded (tests, SSR) or the token is missing from this release.
 */
export function motionDuration(
  token: MotionDurationToken,
  fallback: number,
): number {
  if (prefersReducedMotion()) return 0;
  if (typeof document === 'undefined') return fallback;
  const cached = cache.get(token);
  if (cached !== undefined) return cached;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(`--smrt-duration-${token}`)
    .trim();
  const match = /^([\d.]+)(ms|s)$/.exec(raw);
  const value = match
    ? Number(match[1]) * (match[2] === 's' ? 1000 : 1)
    : fallback;
  cache.set(token, value);
  return value;
}
