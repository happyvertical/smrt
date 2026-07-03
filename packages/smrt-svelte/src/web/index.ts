/**
 * `@happyvertical/smrt-svelte/web` — Svelte 5 live-query bindings for the
 * `@happyvertical/smrt-web` browser client data runtime (#1761, slice A).
 *
 * Consumers turn a `SmrtWebCollection<T>` into runes-reactive live-query state
 * plus mutation helpers WITHOUT importing TanStack. The client-data engine
 * stays an implementation detail of the runtime + this binding; nothing here
 * re-exports an `@tanstack/*` type.
 *
 * The {@link activityFeed} adapter (#1779) is layered on {@link liveCollection}
 * to bridge a live collection into the AdminShell activity registry. It lives
 * behind this opt-in `/web` entry — NOT under `components/workspace/` — so the
 * AdminShell core stays transport-agnostic and TanStack-free (epic #1766).
 *
 * @packageDocumentation
 */

export {
  type ActivityFeedHandle,
  type ActivityFeedMap,
  type ActivityFeedOptions,
  activityFeed,
  type ShellActivityInput,
} from './activity-feed.svelte.js';
export {
  type LiveCollection,
  type LiveCollectionMutation,
  type LiveCollectionOptions,
  type LiveCollectionStatus,
  liveCollection,
} from './live-collection.svelte.js';
