/**
 * STAND-IN for the types of `RelationInput` (happyvertical/smrt#3600) in
 * `@happyvertical/smrt-svelte/forms`. Same shapes as the issue; swap the
 * import for the published ones when it lands.
 */

/** One search hit: the id to store, the text to show, and a second line. */
export interface RelationOption {
  id: string;
  label: string;
  detail?: string;
}

/** A search against the data the caller owns; the picker never reaches for it. */
export type RelationSearch = (query: string) => Promise<RelationOption[]>;

/** The label of the current value, so an id is never shown. */
export type RelationResolve = (
  id: string,
) => Promise<{ id: string; label: string } | null>;
