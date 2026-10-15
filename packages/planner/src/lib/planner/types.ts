import type { PlannerAssistant, PlannerInference } from './assistant.ts';
import type { PlannerController, PlannerTabId } from './commands/index.ts';

/** What `onready` hands a host once the planner is mounted. */
export interface PlannerHandle {
  controller: PlannerController;
  /** Present when `inference` was given: a chat transport driven by the controller. */
  assistant?: PlannerAssistant;
}

/** Shared props for the complete Planner and the separately mounted controls. */
export interface PlannerProps {
  /**
   * The commands to drive the planner with and the snapshot to read. Defaults
   * to the app's own. A controller made with `createPlannerController` works
   * too; the planner follows its `focus` tab.
   */
  controller?: PlannerController;
  /**
   * Where the customization controls' own pages are served from (`''`,
   * `'/planner'`). The complete Planner uses fragment paths for its app
   * sections and model pages, so it needs no host router.
   */
  basePath?: string;
  /**
   * A model for the planner's assistant; see `createPlannerAssistant`. The
   * complete `Planner` then shows the assistant icon at the end of its
   * header: it opens the chat dock once a model is ready and the AI models
   * page (`#/ai/`, where a visitor downloads a model or connects their own
   * endpoint) before. Without it the planner has no assistant.
   */
  inference?: PlannerInference;
  /**
   * `PlannerControls` uses `'own'` by default, editing the menu layout on a
   * headless controller. `'shell'` edits the nearest smrt-svelte `AppShell`.
   * The complete `Planner` always uses its own shell for these controls.
   */
  layout?: 'own' | 'shell';
  /**
   * `'self'` (the default) reads the saved cookbook from this browser on mount
   * and saves changes. `'host'` leaves both to the host (the static app's
   * layout does them).
   */
  persistence?: 'self' | 'host';
  /** Show the theme preset and light/dark controls (they need a theme provider). */
  themeControls?: boolean;
  /** Link to the host's Advanced Styles page, when mounting controls alone. */
  advancedStylesHref?: string;
  /**
   * The shell title shown when no cookbook name and no applied library
   * cookbook names the app (the brand label, and the fallback for a section
   * page without a heading). A host that calls the planner something else
   * passes it here. Defaults to `'Planner'`. The complete `Planner` only.
   */
  defaultTitle?: string;
  /** Tabs to show, in order; defaults to all. */
  tabs?: readonly PlannerTabId[];
  /**
   * A host's way back, rendered at the start of the planner's header beside
   * the brand (`{ href: '/', label: 'Back to documentation' }`). Off by
   * default. The complete `Planner` only.
   */
  backLink?: PlannerBackLink;
  /**
   * Called once the planner is mounted, with its controller and (when
   * `inference` was given) the assistant transport, for a host that drives
   * the plan itself.
   */
  onready?: (handle: PlannerHandle) => void;
}

/** A link out of the planner, shown in its header. */
export interface PlannerBackLink {
  href: string;
  label: string;
}
