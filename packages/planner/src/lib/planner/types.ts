import type { AssistantMessage } from '@happyvertical/smrt-chat/svelte';
import type {
  BrowserAssistantTransport,
  PlannerConversationSeed,
  PlannerHostTurnHandler,
} from '../assistant/transport.ts';
import type { PlannerAssistant, PlannerInference } from './assistant.ts';
import type {
  ExportData,
  PlannerController,
  PlannerTabId,
} from './commands/index.ts';
import type { PlannerGuideHandle } from './guide.ts';

export type PlannerProjectPersistence =
  typeof import('./workspace.svelte.ts').workspacePersistence;

/** What `onready` hands a host once the planner is mounted. */
export interface PlannerHandle {
  /** Host draft storage follows this workspace’s remember/session policy. */
  workspaceStorage?: Storage;
  controller: PlannerController;
  guide?: PlannerGuideHandle;
  /** Present when `inference` was given: a chat transport driven by the controller. */
  assistant?: PlannerAssistant;
  /** Complete Planner only: the same transport used by its visible native dock. */
  nativeAssistant?: BrowserAssistantTransport;
  /** Complete Planner only: open/focus the ready native dock; false if unavailable. */
  openAssistant?: () => Promise<boolean>;
}

/** Detached, complete document and native thread captured together at action time. */
export interface PlannerExportContext {
  export: ExportData;
  revision: number;
  conversation: AssistantMessage[];
}

export interface PlannerExportAction {
  label: string;
  run(context: PlannerExportContext): void | Promise<void>;
}

/** Shared props for the complete Planner and the separately mounted controls. */
export interface PlannerProps {
  /** Suppress the empty cookbook chooser while a trusted host conceives the app. */
  entryMode?: 'browse' | 'planning';
  /** Trusted host receives only current native user sends, never model output. */
  conversationalAction?: PlannerHostTurnHandler;
  onreset?: () => void;
  resetDisabledReason?: string;
  /**
   * The commands to drive the planner with and the snapshot to read. Defaults
   * to the app's own. A controller made with `createPlannerController` works
   * too; the planner follows its `focus` tab.
   */
  controller?: PlannerController;
  /** Complete Planner only: visible native export label; blank/omitted keeps the icon-only default. */
  exportLabel?: string;
  /** Complete Planner only: primary header action with the same export capture. */
  headerAction?: PlannerExportAction;
  /** Optional first primary Export action; native download remains available. */
  exportAction?: PlannerExportAction;
  /** Complete Planner only: plain earlier turns, seeded before native sends. */
  initialConversation?: PlannerConversationSeed;
  /** Complete Planner only: offer library cookbooks in native chat (default true). */
  cookbookOffers?: boolean;
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
  /** Host-owned storage UI capability. Supply only from the owner that actually
   * saves the current cookbook; self mode uses the canonical facade by default. */
  projectPersistence?: PlannerProjectPersistence | null;
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
