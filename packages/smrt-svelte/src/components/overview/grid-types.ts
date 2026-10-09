import type { Component } from 'svelte';
import type { OverviewController } from './controller.svelte.js';
import type {
  OverviewOptions,
  RegisteredWidget,
  WidgetComponentProps,
} from './types.js';

/** A model the option editor offers for `model` fields. */
export interface OverviewModelChoice {
  value: string;
  label: string;
}

/** Props of `OverviewGrid`. */
export interface OverviewGridProps {
  /** The overview's state, from `createOverview`. */
  controller: OverviewController;
  /**
   * Resolved widget components (see `resolveWidgetComponents`). A type with
   * no entry falls back to the registered `component`, else renders as
   * unavailable.
   */
  components?: ReadonlyMap<string, Component<WidgetComponentProps>>;
  /**
   * Edit mode. Omit to follow the shell's layout editor (the pencil), so a
   * grid inside `AppShell` edits with the rest of the page.
   */
  editing?: boolean;
  /** Accessible name of the grid. */
  label?: string;
  /** Heading level of widget titles (default 2). */
  headingLevel?: 2 | 3 | 4;
  /** Models offered by `model` option fields (else a text box). */
  models?: readonly OverviewModelChoice[];
  /** Host renderer for icon names that are not built in. */
  iconComponent?: Component<{ name: string; size?: number }>;
}

/** An option-level problem shown next to its field. */
export interface OverviewFormIssue {
  key: string;
  code: string;
}

/** Props of `WidgetOptionsForm`. */
export interface WidgetOptionsFormProps {
  /** The widget type being configured. */
  definition: RegisteredWidget;
  /** Current options (an existing widget) or starting values. */
  initial: OverviewOptions;
  models?: readonly OverviewModelChoice[];
  /** Saves; returns issues to show, or `null` when it worked. */
  onsave: (options: OverviewOptions) => OverviewFormIssue[] | null;
  oncancel: () => void;
}
