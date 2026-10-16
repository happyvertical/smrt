/**
 * View transitions: the shell's helpers (`@happyvertical/smrt-svelte/app`,
 * smrt#3858), re-exported so every planner-side caller keeps one import.
 * `runViewTransition` skips the transition under reduced motion and where the
 * browser has none; the hash router in `Planner.svelte` and the static app's
 * `onNavigate` (`createOnNavigateViewTransition`) both go through it.
 */
export {
  createOnNavigateViewTransition,
  type RunViewTransitionOptions as ViewTransitionOptions,
  runViewTransition,
} from '@happyvertical/smrt-svelte/app';

/**
 * True when the visitor's OS or browser asks for reduced motion. The shell
 * keeps its own check private, so the motion tokens read this one.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
