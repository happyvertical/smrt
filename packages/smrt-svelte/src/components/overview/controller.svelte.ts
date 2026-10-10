/**
 * The overview controller (#3727): the host-owned, reactive state of one
 * customizable overview. It follows the `ShellLayout` controller pattern:
 * persistence belongs to the host, which stores the sparse override and
 * feeds it back (`override`), and is told about every edit (`onchange`);
 * with no `override` getter the controller keeps the value in memory.
 *
 * Every user operation (and, later, every assistant operation) is a method
 * here. They validate through the same pure model the server uses, so a
 * client edit can never produce a document the server would reject.
 */
import { untrack } from 'svelte';
import {
  diffOverview,
  isEmptyOverride,
  nextWidgetId,
  parseOverviewOverride,
  resolveOverview,
  sanitizeOverview,
} from './model.js';
import { defaultWidgetRegistry, type WidgetRegistry } from './registry.js';
import { defaultWidgetOptions, validateWidgetOptions } from './schema.js';
import type {
  LoadedOverview,
  LoadedWidgetErrorCode,
  OverviewDefinition,
  OverviewDocument,
  OverviewIssue,
  OverviewOptions,
  OverviewOverride,
  OverviewWidget,
  RegisteredWidget,
  WidgetOptionIssue,
  WidgetStatus,
} from './types.js';

/** Where one widget's data stands. */
export interface OverviewWidgetEntry {
  status: WidgetStatus;
  data?: unknown;
  error?: LoadedWidgetErrorCode;
}

export type OverviewOpResult =
  | { ok: true; id: string }
  | {
      ok: false;
      reason:
        | 'not_allowed'
        | 'unknown_widget'
        | 'unknown_type'
        | 'invalid_options'
        | 'limit'
        | 'unchanged';
      issues?: WidgetOptionIssue[];
    };

export interface OverviewControllerOptions {
  definition: OverviewDefinition;
  /** Defaults to the shared registry. */
  registry?: WidgetRegistry;
  /**
   * The stored override (untrusted JSON; `null` for none). When given the host
   * is the single source of truth and must feed edits back through it.
   */
  override?: () => unknown;
  /** Receives the canonical override after each edit; `null` = defaults. */
  onchange?: (override: OverviewOverride | null) => void | Promise<void>;
  /** Whether the viewer may customize (default true). Hosts derive it from roles. */
  canCustomize?: () => boolean;
  /** Data the page's server load already produced; seeds the entries. */
  loaded?: LoadedOverview | (() => LoadedOverview | undefined);
  /**
   * Loads one widget's data after an add or an options change. The host runs
   * the widget's `load` where its data lives: a remote function or endpoint in
   * production, the in-browser source in the planner. Must return JSON data.
   */
  loadWidget?: (
    widget: OverviewWidget,
    signal: AbortSignal,
  ) => Promise<unknown>;
}

function optionsKey(widget: OverviewWidget): string {
  return JSON.stringify([widget.type, widget.version ?? 1, widget.options]);
}

interface KeyedEntry extends OverviewWidgetEntry {
  key: string;
}

export class OverviewController {
  readonly #options: OverviewControllerOptions;
  readonly #registry: WidgetRegistry;
  #local = $state.raw<unknown>(null);
  #entries = $state.raw<Record<string, KeyedEntry>>({});
  readonly #pending = new Map<string, AbortController>();
  /**
   * Overrides handed to `onchange` that a host-owned getter has not fed back
   * yet, oldest first, and what the getter answered before the oldest of
   * them (`prior`). Hosts acknowledge in order.
   */
  #outstanding: {
    prior: OverviewOverride | null;
    values: Array<OverviewOverride | null>;
  } | null = null;
  readonly #resolved = $derived.by(() => {
    const resolved = resolveOverview(
      this.#options.definition,
      this.#options.override ? this.#options.override() : this.#local,
      this.#registry,
    );
    // Every host feed-back passes here (the grid reads `document`), so a
    // pending edit is retired as soon as the getter moves off its prior
    // value, even if nothing reads `committedOverride` in between.
    this.#retire(diffOverview(resolved.base, resolved.document));
    return resolved;
  });

  constructor(options: OverviewControllerOptions) {
    this.#options = options;
    this.#registry = options.registry ?? defaultWidgetRegistry;
    const loaded =
      typeof options.loaded === 'function' ? options.loaded() : options.loaded;
    if (loaded) this.#seed(loaded);
  }

  #seed(loaded: LoadedOverview): void {
    const entries: Record<string, KeyedEntry> = {};
    for (const widget of loaded.widgets) {
      entries[widget.id] = {
        key: optionsKey(widget),
        status: widget.status,
        data: widget.data,
        error: widget.error?.code,
      };
    }
    this.#entries = entries;
  }

  get definition(): OverviewDefinition {
    return this.#options.definition;
  }

  get registry(): WidgetRegistry {
    return this.#registry;
  }

  /** The sanitized document to render. */
  get document(): OverviewDocument {
    return this.#resolved.document;
  }

  /** The sanitized defaults. */
  get base(): OverviewDocument {
    return this.#resolved.base;
  }

  /** The canonical override currently applied; `null` when on defaults. */
  get override(): OverviewOverride | null {
    return diffOverview(this.#resolved.base, this.#resolved.document);
  }

  /**
   * The override this controller last committed: {@link override}, or, while
   * a host-owned getter still answers the value from before the last edit
   * (the host has not fed it back yet), the value handed to `onchange`. An
   * Undo compares against this so a pending save is not mistaken for a
   * change made elsewhere.
   */
  get committedOverride(): OverviewOverride | null {
    const current = this.override;
    this.#retire(current);
    const outstanding = this.#outstanding;
    return outstanding
      ? (outstanding.values.at(-1) as OverviewOverride | null)
      : current;
  }

  /**
   * Acknowledge what the host getter now answers. Still the value from before
   * the oldest outstanding emission: nothing was fed back yet. Equal to an
   * outstanding emission: that one and every older one are acknowledged (in
   * order), and the getter's value becomes the prior of the rest. Anything
   * else is a change made elsewhere: the queue is dropped, so the mask only
   * ever covers this controller's own unacknowledged saves.
   */
  #retire(current: OverviewOverride | null): void {
    const outstanding = this.#outstanding;
    if (!outstanding || sameJson(current, outstanding.prior)) return;
    const index = outstanding.values.findIndex((value) =>
      sameJson(value, current),
    );
    if (index < 0 || index === outstanding.values.length - 1) {
      this.#outstanding = null;
      return;
    }
    this.#outstanding = {
      prior: current,
      values: outstanding.values.slice(index + 1),
    };
  }

  /** Hand a canonical override to the host, queueing it until fed back. */
  #emit(override: OverviewOverride | null): void {
    if (this.#options.override) {
      const current = this.override;
      this.#retire(current);
      const outstanding = this.#outstanding;
      this.#outstanding = outstanding
        ? {
            prior: outstanding.prior,
            values: [...outstanding.values, override],
          }
        : { prior: current, values: [override] };
    } else {
      this.#local = override;
    }
    void this.#options.onchange?.(override);
  }

  /** What was dropped or reported while resolving. */
  get issues(): readonly OverviewIssue[] {
    return this.#resolved.issues;
  }

  /** True when the viewer has changed anything from the defaults. */
  get customized(): boolean {
    return !isEmptyOverride(this.override);
  }

  get canCustomize(): boolean {
    return this.#options.canCustomize ? this.#options.canCustomize() : true;
  }

  /** Whether another widget fits under the cap. */
  get full(): boolean {
    const cap = this.#options.definition.maxWidgets ?? 24;
    return this.document.widgets.length >= cap;
  }

  /** Registered widget types this overview allows, in registration order. */
  get addable(): RegisteredWidget[] {
    const { allowed, id } = this.#options.definition;
    return this.#registry
      .list()
      .filter(
        (def) =>
          (!allowed || allowed.includes(def.type)) &&
          (!def.allowedIn || def.allowedIn.includes(id)),
      );
  }

  /** Data state of a widget (loading while a load is outstanding). */
  entry(widget: OverviewWidget): OverviewWidgetEntry {
    const entry = this.#entries[widget.id];
    if (entry && entry.key === optionsKey(widget)) return entry;
    return { status: this.#options.loadWidget ? 'loading' : 'ready' };
  }

  #models(): readonly string[] | undefined {
    return this.#options.definition.models;
  }

  #gate(): OverviewOpResult | null {
    return this.canCustomize ? null : { ok: false, reason: 'not_allowed' };
  }

  #commit(next: OverviewDocument, id: string): OverviewOpResult {
    const sanitized = sanitizeOverview(next, {
      registry: this.#registry,
      definition: this.#options.definition,
    });
    const override = diffOverview(this.#resolved.base, sanitized.document);
    if (sameJson(override, this.committedOverride)) {
      return { ok: false, reason: 'unchanged' };
    }
    this.#emit(override);
    // The derived document reflects a host-owned override only after the host
    // feeds it back, so sync against what was just committed.
    this.#syncWidgets(sanitized.document.widgets);
    return { ok: true, id };
  }

  #reserved(): string[] {
    const override = this.override;
    return [
      ...this.#resolved.base.widgets.map((widget) => widget.id),
      ...this.document.widgets.map((widget) => widget.id),
      ...(override?.removed ?? []),
      ...(override?.added ?? []).map((widget) => widget.id),
    ];
  }

  /** Add a widget of `type` at the end, with the given (or default) options. */
  add(type: string, options: OverviewOptions = {}): OverviewOpResult {
    const denied = this.#gate();
    if (denied) return denied;
    const def = this.addable.find((candidate) => candidate.type === type);
    if (!def) return { ok: false, reason: 'unknown_type' };
    if (this.full) return { ok: false, reason: 'limit' };
    const checked = validateWidgetOptions(
      def.options,
      { ...defaultWidgetOptions(def.options), ...options },
      { models: this.#models() },
    );
    if (!checked.ok) {
      return { ok: false, reason: 'invalid_options', issues: checked.issues };
    }
    const id = nextWidgetId(this.#reserved());
    return this.#commit(
      {
        widgets: [
          ...this.document.widgets,
          {
            id,
            type,
            span: def.defaultSpan,
            options: checked.options,
            version: def.version,
          },
        ],
      },
      id,
    );
  }

  #find(id: string): OverviewWidget | undefined {
    return this.document.widgets.find((widget) => widget.id === id);
  }

  remove(id: string): OverviewOpResult {
    const denied = this.#gate();
    if (denied) return denied;
    if (!this.#find(id)) return { ok: false, reason: 'unknown_widget' };
    return this.#commit(
      { widgets: this.document.widgets.filter((widget) => widget.id !== id) },
      id,
    );
  }

  /** Move a widget so it sits at `toIndex` once it is taken out of the list. */
  move(id: string, toIndex: number): OverviewOpResult {
    const denied = this.#gate();
    if (denied) return denied;
    const widget = this.#find(id);
    if (!widget) return { ok: false, reason: 'unknown_widget' };
    const rest = this.document.widgets.filter((entry) => entry.id !== id);
    const index = Math.max(0, Math.min(toIndex, rest.length));
    rest.splice(index, 0, widget);
    return this.#commit({ widgets: rest }, id);
  }

  /** Set a widget's column span (clamped to the widget's range). */
  resize(id: string, span: number): OverviewOpResult {
    const denied = this.#gate();
    if (denied) return denied;
    const widget = this.#find(id);
    if (!widget) return { ok: false, reason: 'unknown_widget' };
    return this.#commit(
      {
        widgets: this.document.widgets.map((entry) =>
          entry.id === id ? { ...entry, span: Math.round(span) } : entry,
        ),
      },
      id,
    );
  }

  /** Replace a widget's options after validating them against its schema. */
  setOptions(id: string, options: OverviewOptions): OverviewOpResult {
    const denied = this.#gate();
    if (denied) return denied;
    const widget = this.#find(id);
    const def = widget ? this.#registry.get(widget.type) : undefined;
    if (!widget || !def) return { ok: false, reason: 'unknown_widget' };
    const checked = validateWidgetOptions(def.options, options, {
      models: this.#models(),
    });
    if (!checked.ok) {
      return { ok: false, reason: 'invalid_options', issues: checked.issues };
    }
    return this.#commit(
      {
        widgets: this.document.widgets.map((entry) =>
          entry.id === id
            ? { ...entry, options: checked.options, version: def.version }
            : entry,
        ),
      },
      id,
    );
  }

  /** Put one widget back to its default (or remove it when it is not one). */
  resetWidget(id: string): OverviewOpResult {
    const denied = this.#gate();
    if (denied) return denied;
    const original = this.#resolved.base.widgets.find(
      (widget) => widget.id === id,
    );
    if (!original) return this.remove(id);
    return this.#commit(
      {
        widgets: this.document.widgets.some((widget) => widget.id === id)
          ? this.document.widgets.map((widget) =>
              widget.id === id ? { ...original } : widget,
            )
          : [...this.document.widgets, { ...original }],
      },
      id,
    );
  }

  /** Drop every customization; the overview returns to its defaults. */
  reset(): OverviewOpResult {
    const denied = this.#gate();
    if (denied) return denied;
    if (isEmptyOverride(this.committedOverride)) {
      return { ok: false, reason: 'unchanged' };
    }
    this.#emit(null);
    this.#syncWidgets(this.#resolved.base.widgets);
    return { ok: true, id: '' };
  }

  /**
   * Replace the override wholesale (an assistant's Undo restores the previous
   * value). The value is parsed and sanitized like any stored override.
   */
  restore(override: unknown): OverviewOpResult {
    const denied = this.#gate();
    if (denied) return denied;
    const { override: parsed } = parseOverviewOverride(override);
    const next = resolveOverview(
      this.#options.definition,
      parsed,
      this.#registry,
    );
    const canonical = diffOverview(next.base, next.document);
    if (sameJson(canonical, this.committedOverride)) {
      return { ok: false, reason: 'unchanged' };
    }
    this.#emit(canonical);
    this.#syncWidgets(next.document.widgets);
    return { ok: true, id: '' };
  }

  /** Re-run a widget's load (after an error). */
  reload(id: string): void {
    const widget = this.#find(id);
    if (!widget) return;
    this.#request(widget);
  }

  /**
   * Request data for every widget the entries do not cover. Call from an
   * effect when the document can change outside the controller (a host-owned
   * override). Never called during server render.
   */
  sync(): void {
    this.#syncWidgets(this.document.widgets);
  }

  #syncWidgets(widgets: readonly OverviewWidget[]): void {
    untrack(() => {
      const live = new Set(widgets.map((widget) => widget.id));
      const kept: Record<string, KeyedEntry> = {};
      for (const [id, entry] of Object.entries(this.#entries)) {
        if (live.has(id)) kept[id] = entry;
      }
      for (const [id, controller] of this.#pending) {
        if (!live.has(id)) {
          controller.abort();
          this.#pending.delete(id);
        }
      }
      this.#entries = kept;
      if (!this.#options.loadWidget) return;
      for (const widget of widgets) {
        const entry = this.#entries[widget.id];
        if (!entry || entry.key !== optionsKey(widget)) this.#request(widget);
      }
    });
  }

  #request(widget: OverviewWidget): void {
    const load = this.#options.loadWidget;
    if (!load) return;
    const key = optionsKey(widget);
    this.#pending.get(widget.id)?.abort();
    const controller = new AbortController();
    this.#pending.set(widget.id, controller);
    this.#entries = {
      ...this.#entries,
      [widget.id]: { key, status: 'loading' },
    };
    const settle = (entry: OverviewWidgetEntry): void => {
      if (controller.signal.aborted) return;
      if (this.#pending.get(widget.id) === controller) {
        this.#pending.delete(widget.id);
      }
      if (this.#entries[widget.id]?.key !== key) return;
      this.#entries = { ...this.#entries, [widget.id]: { key, ...entry } };
    };
    Promise.resolve()
      .then(() =>
        controller.signal.aborted ? undefined : load(widget, controller.signal),
      )
      .then(
        (data) => settle({ status: 'ready', data }),
        () => settle({ status: 'error', error: 'load_failed' }),
      );
  }

  /** Abort outstanding loads (call when the owning component is destroyed). */
  destroy(): void {
    for (const controller of this.#pending.values()) controller.abort();
    this.#pending.clear();
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Create a controller; call during component initialization. */
export function createOverview(
  options: OverviewControllerOptions,
): OverviewController {
  return new OverviewController(options);
}
