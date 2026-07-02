/**
 * Svelte 5 binding for smrt-web collections (spike #1756).
 *
 * Re-exports the TanStack Svelte DB live-query hook so demo consumers never
 * import TanStack directly. Production placement for framework bindings is
 * `@happyvertical/smrt-svelte` (see PRD #1755); the spike keeps the binding
 * here so the whole bet lives in one throwaway package.
 *
 * Note: `@tanstack/svelte-db` publishes only a `svelte` export condition, so
 * this subpath resolves exclusively under a Svelte-aware bundler
 * (vite-plugin-svelte). That is fine for the demo binding, but it is a real
 * packaging constraint to weigh in the go/no-go.
 */

export { useLiveQuery } from '@tanstack/svelte-db';
export type {
  UseLiveQueryReturn,
  UseLiveQueryReturnWithCollection,
} from '@tanstack/svelte-db';
