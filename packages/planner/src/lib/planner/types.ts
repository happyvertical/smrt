import type { PlannerAssistant, PlannerInference } from './assistant.ts';
import type { PlannerController, PlannerTabId } from './commands/index.ts';

/** What `onready` hands a host once the planner is mounted. */
export interface PlannerHandle {
  controller: PlannerController;
  /** Present when `inference` was given: a chat transport driven by the controller. */
  assistant?: PlannerAssistant;
}

/** The `Planner` component's props. */
export interface PlannerProps {
  /**
   * The commands to drive the planner with and the snapshot to read. Defaults
   * to the app's own. A controller made with `createPlannerController` works
   * too; the planner follows its `focus` tab.
   */
  controller?: PlannerController;
  /**
   * Where the planner's own pages are served from (`''`, `'/planner'`). Only
   * links to planner pages use it; the component needs no router of its own.
   */
  basePath?: string;
  /** A model for the planner's assistant; see `createPlannerAssistant`. */
  inference?: PlannerInference;
  /**
   * `'own'` (the default) edits the menu layout on a headless controller built
   * from the cookbook. `'shell'` edits the nearest smrt-svelte `AppShell`'s, as
   * the static app does (it also holds panel and slot placements).
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
  /** Tabs to show, in order; defaults to all. */
  tabs?: readonly PlannerTabId[];
  onready?: (handle: PlannerHandle) => void;
}
