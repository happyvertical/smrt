/**
 * `@happyvertical/smrt-svelte/web` — Svelte 5 live-query bindings for the
 * `@happyvertical/smrt-web` browser client data runtime (#1761, slice A).
 *
 * Consumers turn a `SmrtWebCollection<T>` into runes-reactive live-query state
 * plus mutation helpers WITHOUT importing TanStack. The client-data engine
 * stays an implementation detail of the runtime + this binding; nothing here
 * re-exports an `@tanstack/*` type.
 *
 * @packageDocumentation
 */

export {
  type LiveCollection,
  type LiveCollectionMutation,
  type LiveCollectionOptions,
  type LiveCollectionStatus,
  liveCollection,
} from './live-collection.svelte.js';
