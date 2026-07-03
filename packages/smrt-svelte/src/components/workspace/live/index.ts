/**
 * `@happyvertical/smrt-svelte/workspace/live`
 *
 * Opt-in, transport-light live-data helpers for the AdminShell system scope.
 *
 * This subpath is intentionally separate from the `./workspace` presentation
 * barrel and the `./web` (smrt-web / TanStack) entry. The system scope shows
 * jobs / schedules / dispatch, which live in `_smrt_*` system tables that the
 * core change-feed skips and smrt-web does not expose as collections — so this
 * layer polls an app-provided status endpoint rather than a live collection,
 * and carries no smrt-web dependency.
 *
 * See `src/components/workspace/live/system-feed.recipe.md` for wiring an app
 * jobs-status endpoint (server reads `_smrt_*` via `@happyvertical/smrt-jobs`).
 */

export {
  type SystemFeedController,
  type SystemFeedOptions,
  type SystemFeedStatus,
  type SystemFeedView,
  systemFeed,
} from './system-feed.svelte.js';
