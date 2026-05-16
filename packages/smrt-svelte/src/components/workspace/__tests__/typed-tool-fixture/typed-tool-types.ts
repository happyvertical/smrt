/**
 * Type-only fixtures for the typed tool-component pattern. Lives in a
 * `.ts` file (not `.svelte`) so the types can be imported cleanly from
 * both the component and the registration site without relying on
 * Svelte's `<script context="module">` re-export semantics.
 */

export interface MyData {
  siteSlug: string;
  contentId: string;
}

export interface MyActions {
  triggerSave(): void;
  triggerReview(kind: string): void;
}
