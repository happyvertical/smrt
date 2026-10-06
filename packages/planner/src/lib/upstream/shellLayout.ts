/**
 * STAND-IN for happyvertical/smrt#3603 (user-customizable shell layout).
 *
 * A local copy of the serializable `ShellLayout` delta the issue specifies, so
 * the app blueprint can carry a typed `layout` field now. Nothing reads it
 * until `AppShell` accepts `layout` / `onlayoutchange` and `ShellLayoutEditor`
 * ships; then import the type from `@happyvertical/smrt-svelte`, delete this
 * file and wire the blueprint's `layout` through (smrt-planner#15).
 */
export type PanelEdge = 'top' | 'left' | 'right' | 'bottom';

export interface ShellLayout {
  version: 1;
  /** Navigation section ids, in order. */
  sectionOrder?: string[];
  /** Item ids per section id, in order. */
  itemOrder?: Record<string, string[]>;
  /** Section and item ids that are hidden. */
  hidden?: string[];
  /** Item id -> the section id it was moved to. */
  moved?: Record<string, string>;
  panels?: Partial<
    Record<PanelEdge, { visible?: boolean; initial?: 'collapsed' | 'expanded' }>
  >;
}
