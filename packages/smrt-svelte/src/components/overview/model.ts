/**
 * The pure overview data model (#3727): parse untrusted JSON, merge a stored
 * override onto the page defaults, derive the sparse override back from an
 * edited document, and sanitize a document against the widget registry.
 *
 * Everything here is total and never throws on bad input: unknown, invalid
 * or disallowed widgets are dropped and reported as {@link OverviewIssue}s,
 * never executed. Svelte-free; runs on the server on save and on load.
 */

import type { WidgetRegistry } from './registry.js';
import { optionsEqual, validateWidgetOptions } from './schema.js';
import {
  OVERVIEW_DEFAULT_MAX_WIDGETS,
  OVERVIEW_ID_PATTERN,
  OVERVIEW_MAX_SPAN,
  OVERVIEW_MIN_SPAN,
  OVERVIEW_PAGE_ID_PATTERN,
  type OverviewDefinition,
  type OverviewDocument,
  type OverviewIssue,
  type OverviewOptions,
  type OverviewOverride,
  type OverviewWidget,
  type OverviewWidgetPatch,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSpan(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= OVERVIEW_MIN_SPAN &&
    value <= OVERVIEW_MAX_SPAN
  );
}

function primitiveOptions(raw: unknown): OverviewOptions | null {
  if (raw === undefined) return {};
  if (!isRecord(raw)) return null;
  const out: OverviewOptions = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      out[key] = value;
    } else {
      return null;
    }
  }
  return out;
}

/** Shape-check one widget; `null` when it is not a widget at all. */
function parseWidget(
  raw: unknown,
  issues: OverviewIssue[],
): OverviewWidget | null {
  const id = isRecord(raw) && typeof raw.id === 'string' ? raw.id : null;
  const type = isRecord(raw) && typeof raw.type === 'string' ? raw.type : null;
  const malformed = (message: string): null => {
    issues.push({ widgetId: id, type, code: 'malformed', message });
    return null;
  };
  if (!isRecord(raw)) return malformed('widget is not an object');
  if (id === null || !OVERVIEW_ID_PATTERN.test(id)) {
    return malformed('widget id is missing or invalid');
  }
  if (type === null) return malformed('widget type is missing');
  if (!isSpan(raw.span)) {
    issues.push({
      widgetId: id,
      type,
      code: 'invalid_span',
      message: 'span must be an integer from 1 to 4',
    });
    return null;
  }
  const options = primitiveOptions(raw.options);
  if (options === null) {
    issues.push({
      widgetId: id,
      type,
      code: 'invalid_options',
      message: 'options must be an object of primitive values',
    });
    return null;
  }
  const widget: OverviewWidget = { id, type, span: raw.span, options };
  if (raw.version !== undefined) {
    if (
      typeof raw.version !== 'number' ||
      !Number.isSafeInteger(raw.version) ||
      raw.version < 1
    ) {
      return malformed('version must be a positive integer');
    }
    widget.version = raw.version;
  }
  return widget;
}

/** Parse untrusted JSON into a document. Malformed widgets are dropped. */
export function parseOverviewDocument(input: unknown): {
  document: OverviewDocument;
  issues: OverviewIssue[];
} {
  const issues: OverviewIssue[] = [];
  const widgets: OverviewWidget[] = [];
  const list =
    isRecord(input) && Array.isArray(input.widgets) ? input.widgets : null;
  if (list === null) {
    if (input !== undefined && input !== null) {
      issues.push({
        widgetId: null,
        type: null,
        code: 'malformed',
        message: 'overview must be an object with a widgets array',
      });
    }
    return { document: { widgets }, issues };
  }
  const seen = new Set<string>();
  for (const raw of list) {
    const widget = parseWidget(raw, issues);
    if (!widget) continue;
    if (seen.has(widget.id)) {
      issues.push({
        widgetId: widget.id,
        type: widget.type,
        code: 'duplicate_id',
        message: 'widget id appears more than once',
      });
      continue;
    }
    seen.add(widget.id);
    widgets.push(widget);
  }
  return { document: { widgets }, issues };
}

/**
 * Parse an untrusted stored override. Never throws; an unknown version, or
 * anything that is not an object, yields `null` (no override).
 */
export function parseOverviewOverride(input: unknown): {
  override: OverviewOverride | null;
  issues: OverviewIssue[];
} {
  const issues: OverviewIssue[] = [];
  if (input === undefined || input === null) return { override: null, issues };
  if (!isRecord(input) || input.version !== 1) {
    issues.push({
      widgetId: null,
      type: null,
      code: 'malformed',
      message: 'override must be an object with version 1',
    });
    return { override: null, issues };
  }
  const override: OverviewOverride = { version: 1 };
  const ids = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const out = value.filter(
      (id): id is string =>
        typeof id === 'string' && OVERVIEW_ID_PATTERN.test(id),
    );
    return [...new Set(out)];
  };
  const order = ids(input.order);
  if (order?.length) override.order = order;
  const removed = ids(input.removed);
  if (removed?.length) override.removed = removed;
  if (Array.isArray(input.added)) {
    const { document } = parseOverviewDocument({ widgets: input.added });
    if (document.widgets.length) override.added = document.widgets;
    const dropped = input.added.length - document.widgets.length;
    if (dropped > 0) {
      issues.push({
        widgetId: null,
        type: null,
        code: 'malformed',
        message: `${dropped} added widget(s) were malformed and dropped`,
      });
    }
  }
  if (isRecord(input.changed)) {
    const changed: Record<string, OverviewWidgetPatch> = {};
    for (const [id, raw] of Object.entries(input.changed)) {
      if (!OVERVIEW_ID_PATTERN.test(id) || !isRecord(raw)) continue;
      const patch: OverviewWidgetPatch = {};
      if (isSpan(raw.span)) patch.span = raw.span;
      const options =
        raw.options === undefined ? undefined : primitiveOptions(raw.options);
      if (options) patch.options = options;
      if (
        typeof raw.version === 'number' &&
        Number.isSafeInteger(raw.version) &&
        raw.version >= 1
      ) {
        patch.version = raw.version;
      }
      if (Object.keys(patch).length) changed[id] = patch;
    }
    if (Object.keys(changed).length) override.changed = changed;
  }
  return { override: isEmptyOverride(override) ? null : override, issues };
}

/** True when an override changes nothing. */
export function isEmptyOverride(override: OverviewOverride | null): boolean {
  return (
    override === null ||
    (!override.order?.length &&
      !override.removed?.length &&
      !override.added?.length &&
      !Object.keys(override.changed ?? {}).length)
  );
}

function cloneWidget(widget: OverviewWidget): OverviewWidget {
  const copy: OverviewWidget = {
    id: widget.id,
    type: widget.type,
    span: widget.span,
    options: { ...widget.options },
  };
  if (widget.version !== undefined) copy.version = widget.version;
  return copy;
}

/**
 * Merge an override onto a base document. Total: ids the base no longer has
 * are ignored, added widgets whose id collides with the base are skipped, and
 * widgets the order does not list keep their slots (listed ids permute among
 * the slots they occupy), so a default shipped later still appears.
 */
export function applyOverviewOverride(
  base: OverviewDocument,
  override: OverviewOverride | null,
): OverviewDocument {
  if (isEmptyOverride(override) || override === null) {
    return { widgets: base.widgets.map(cloneWidget) };
  }
  const removed = new Set(override.removed ?? []);
  const baseIds = new Set(base.widgets.map((widget) => widget.id));
  const widgets: OverviewWidget[] = [];
  for (const widget of base.widgets) {
    if (removed.has(widget.id)) continue;
    const next = cloneWidget(widget);
    const patch = override.changed?.[widget.id];
    if (patch) {
      if (patch.span !== undefined) next.span = patch.span;
      if (patch.options !== undefined) next.options = { ...patch.options };
      if (patch.version !== undefined) next.version = patch.version;
    }
    widgets.push(next);
  }
  for (const widget of override.added ?? []) {
    if (baseIds.has(widget.id)) continue;
    widgets.push(cloneWidget(widget));
  }
  const order = override.order;
  if (order?.length) {
    const byId = new Map(widgets.map((widget) => [widget.id, widget]));
    const listed = order.filter(
      (id, index) => byId.has(id) && order.indexOf(id) === index,
    );
    const listedSet = new Set(listed);
    const queue = listed.map((id) => byId.get(id) as OverviewWidget);
    let cursor = 0;
    return {
      widgets: widgets.map((widget) =>
        listedSet.has(widget.id) ? (queue[cursor++] as OverviewWidget) : widget,
      ),
    };
  }
  return { widgets };
}

/**
 * The sparse override that turns `base` into `next` (the inverse of
 * {@link applyOverviewOverride}); `null` when they are the same. Both
 * documents should already be sanitized so versions compare like for like.
 */
export function diffOverview(
  base: OverviewDocument,
  next: OverviewDocument,
): OverviewOverride | null {
  const baseById = new Map(base.widgets.map((widget) => [widget.id, widget]));
  const nextIds = new Set(next.widgets.map((widget) => widget.id));
  const override: OverviewOverride = { version: 1 };
  const removed = base.widgets
    .filter((widget) => !nextIds.has(widget.id))
    .map((widget) => widget.id);
  if (removed.length) override.removed = removed;
  const added = next.widgets
    .filter((widget) => !baseById.has(widget.id))
    .map(cloneWidget);
  if (added.length) override.added = added;
  const changed: Record<string, OverviewWidgetPatch> = {};
  for (const widget of next.widgets) {
    const original = baseById.get(widget.id);
    if (!original) continue;
    const patch: OverviewWidgetPatch = {};
    if (widget.span !== original.span) patch.span = widget.span;
    const versionChanged = (widget.version ?? 1) !== (original.version ?? 1);
    if (!optionsEqual(widget.options, original.options) || versionChanged) {
      patch.options = { ...widget.options };
      if (widget.version !== undefined) patch.version = widget.version;
    }
    if (Object.keys(patch).length) changed[widget.id] = patch;
  }
  if (Object.keys(changed).length) override.changed = changed;
  const natural = applyOverviewOverride(base, override).widgets.map(
    (w) => w.id,
  );
  const wanted = next.widgets.map((widget) => widget.id);
  if (natural.some((id, index) => id !== wanted[index]))
    override.order = wanted;
  return isEmptyOverride(override) ? null : override;
}

/**
 * The next unused widget id (`w1`, `w2`, ...) given every reserved id.
 *
 * Total for any reserved ids, including hostile stored ones such as
 * `w9007199254740992`: only numeric suffixes that are safe integers below
 * `Number.MAX_SAFE_INTEGER` raise the starting point (beyond it `n + 1` stops
 * changing the number, which would loop forever), and when the high end is
 * exhausted the scan restarts at `w1`. The reserved set is finite, so a free
 * id is found within `size + 1` steps of the restart.
 */
export function nextWidgetId(reserved: Iterable<string>): string {
  const taken = new Set(reserved);
  let n = 1;
  for (const id of taken) {
    const match = /^w(\d+)$/.exec(id);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isSafeInteger(value) && value < Number.MAX_SAFE_INTEGER) {
      n = Math.max(n, value + 1);
    }
  }
  while (n < Number.MAX_SAFE_INTEGER && taken.has(`w${n}`)) n += 1;
  if (!taken.has(`w${n}`)) return `w${n}`;
  // The high end is exhausted: take the first free id counting up from 1.
  for (n = 1; taken.has(`w${n}`); n += 1);
  return `w${n}`;
}

export interface SanitizeOptions {
  registry: WidgetRegistry;
  definition: Pick<
    OverviewDefinition,
    'id' | 'allowed' | 'models' | 'maxWidgets'
  >;
}

/**
 * Sanitize a document against the registry and the page's confined set:
 * drops (and reports) unknown types, types the page does not allow or the
 * widget refuses (`allowedIn`), future versions, failed migrations, invalid
 * options, duplicate ids and widgets over the cap; migrates older option
 * versions; clamps spans to the widget's range. Idempotent. Nothing here
 * calls a widget's `load`.
 */
export function sanitizeOverview(
  document: OverviewDocument,
  { registry, definition }: SanitizeOptions,
): { document: OverviewDocument; issues: OverviewIssue[] } {
  const issues: OverviewIssue[] = [];
  const widgets: OverviewWidget[] = [];
  const seen = new Set<string>();
  const cap = definition.maxWidgets ?? OVERVIEW_DEFAULT_MAX_WIDGETS;
  const drop = (
    widget: OverviewWidget,
    code: OverviewIssue['code'],
    message: string,
    extra: Partial<OverviewIssue> = {},
  ): void => {
    issues.push({
      widgetId: widget.id,
      type: widget.type,
      code,
      message,
      ...extra,
    });
  };
  for (const widget of document.widgets) {
    if (seen.has(widget.id)) {
      drop(widget, 'duplicate_id', 'widget id appears more than once');
      continue;
    }
    seen.add(widget.id);
    const def = registry.get(widget.type);
    if (!def) {
      drop(widget, 'unknown_type', 'widget type is not registered');
      continue;
    }
    if (
      (definition.allowed && !definition.allowed.includes(widget.type)) ||
      (def.allowedIn && !def.allowedIn.includes(definition.id))
    ) {
      drop(
        widget,
        'type_not_allowed',
        'widget type is not allowed in this overview',
      );
      continue;
    }
    if (widgets.length >= cap) {
      drop(widget, 'too_many', `an overview holds at most ${cap} widgets`);
      continue;
    }
    const stored = widget.version ?? 1;
    let raw: Record<string, unknown> = widget.options;
    if (stored > def.version) {
      drop(
        widget,
        'future_version',
        'options were written by a newer widget version',
      );
      continue;
    }
    if (stored < def.version) {
      let migrated: Record<string, unknown> | null = null;
      try {
        migrated = def.migrate
          ? def.migrate({ ...widget.options }, stored)
          : null;
      } catch {
        migrated = null;
      }
      if (!migrated || !isRecord(migrated)) {
        drop(widget, 'migration_failed', `no migration from version ${stored}`);
        continue;
      }
      raw = migrated;
    }
    const checked = validateWidgetOptions(def.options, raw, {
      models: definition.models,
    });
    if (!checked.ok) {
      drop(
        widget,
        'invalid_options',
        'options do not match the widget schema',
        {
          options: checked.issues,
        },
      );
      continue;
    }
    widgets.push({
      id: widget.id,
      type: widget.type,
      span: Math.min(def.maxSpan, Math.max(def.minSpan, widget.span)),
      options: checked.options,
      version: def.version,
    });
  }
  return { document: { widgets }, issues };
}

export interface ResolvedOverview {
  /** The sanitized defaults (the base an override applies to). */
  base: OverviewDocument;
  /** The sanitized document to render. */
  document: OverviewDocument;
  /** The parsed, well-formed override that was applied (or `null`). */
  override: OverviewOverride | null;
  /** Everything dropped or reported along the way. */
  issues: OverviewIssue[];
  /** The subset caused by the override (not by the page's own defaults). */
  overrideIssues: OverviewIssue[];
}

/**
 * Resolve an overview: sanitize the page defaults, parse the stored override
 * (untrusted JSON), merge, and sanitize the result. This is the one call a
 * page's server load makes before loading widget data.
 */
export function resolveOverview(
  definition: OverviewDefinition,
  override: unknown,
  registry: WidgetRegistry,
): ResolvedOverview {
  const defaults = sanitizeOverview(
    { widgets: [...definition.defaults] },
    {
      registry,
      definition,
    },
  );
  const parsed = parseOverviewOverride(override);
  const merged = applyOverviewOverride(defaults.document, parsed.override);
  const final = sanitizeOverview(merged, { registry, definition });
  return {
    base: defaults.document,
    document: final.document,
    override: parsed.override,
    issues: [...defaults.issues, ...parsed.issues, ...final.issues],
    overrideIssues: [...parsed.issues, ...final.issues],
  };
}

export type OverviewOverrideCheck =
  | { ok: true; override: OverviewOverride | null }
  | { ok: false; issues: OverviewIssue[] };

/**
 * Validate an override a client wants to save. Strict where load is lenient:
 * any issue rejects the save. On success the returned override is canonical
 * (re-derived from the sanitized result), so persist that, not the input.
 */
export function checkOverviewOverride(
  definition: OverviewDefinition,
  input: unknown,
  registry: WidgetRegistry,
): OverviewOverrideCheck {
  const resolved = resolveOverview(definition, input, registry);
  if (resolved.overrideIssues.length > 0) {
    return { ok: false, issues: resolved.overrideIssues };
  }
  return { ok: true, override: diffOverview(resolved.base, resolved.document) };
}

/** Validate and freeze a page's overview declaration. */
export function defineOverview(
  definition: OverviewDefinition,
): OverviewDefinition {
  if (!OVERVIEW_PAGE_ID_PATTERN.test(definition.id)) {
    throw new Error(`defineOverview: invalid overview id "${definition.id}"`);
  }
  const ids = new Set<string>();
  for (const widget of definition.defaults) {
    if (!OVERVIEW_ID_PATTERN.test(widget.id) || ids.has(widget.id)) {
      throw new Error(
        `defineOverview: invalid or duplicate widget id "${widget.id}"`,
      );
    }
    ids.add(widget.id);
  }
  return Object.freeze({
    ...definition,
    defaults: Object.freeze([...definition.defaults]),
  });
}
