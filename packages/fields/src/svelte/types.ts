/**
 * Shared types for the field-policy Svelte primitives.
 */

/**
 * Props for the PolicyField headless snippet escape hatch — all the data a
 * fully custom renderer needs.
 */
export interface PolicyFieldSnippetProps {
  visible: boolean;
  label: string | null;
  help: string | null;
  defaultValue: unknown;
  required: boolean;
  /** Resolved visibility tier from the policy. */
  tier: 'basic' | 'advanced' | 'hidden';
}
