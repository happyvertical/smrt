/**
 * The cookbook's `overviews` field: one sparse smrt-svelte `OverviewOverride`
 * per overview id. A stored override is untrusted data. Each one is checked
 * with `checkOverviewOverride` against its page's definition; what fails (an
 * unknown or disallowed widget type, options outside the widget's schema, an
 * unknown overview id, a malformed entry) is dropped and reported, never
 * rendered or loaded, and only the canonical override is kept.
 */
import {
  checkOverviewOverride,
  type OverviewIssue,
  type OverviewOverride,
  parseOverviewOverride,
} from '@happyvertical/smrt-svelte/overview';
import type { ShellLayout } from '@happyvertical/smrt-svelte/workspace/layout';
import { isOverviewId, sectionOverview } from './definitions.ts';
import { overviewRegistry } from './registry.ts';

export type CookbookOverviews = Record<string, OverviewOverride>;

export interface ParsedOverviews {
  /** Canonical, non-empty overrides by overview id, keys sorted. */
  overviews: CookbookOverviews;
  /** One sentence per dropped override or widget. */
  dropped: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function describe(id: string, issue: OverviewIssue): string {
  const what = issue.widgetId
    ? `widget ${issue.widgetId}${issue.type ? ` (${issue.type})` : ''}`
    : 'an entry';
  const options = issue.options?.length
    ? `: ${issue.options.map((o) => `${o.key} ${o.code}`).join(', ')}`
    : '';
  return `Overview ${id}: ${what} was dropped (${issue.code}${options}).`;
}

/**
 * The override without the parts an issue names: an added widget or a change
 * to a default widget with that id. The rest of the visitor's edits survive.
 */
function without(
  override: OverviewOverride,
  ids: ReadonlySet<string>,
): OverviewOverride {
  const next: OverviewOverride = { ...override };
  if (override.added) {
    next.added = override.added.filter((widget) => !ids.has(widget.id));
  }
  if (override.changed) {
    next.changed = Object.fromEntries(
      Object.entries(override.changed).filter(([id]) => !ids.has(id)),
    );
  }
  return next;
}

/**
 * Check one stored override. `checkOverviewOverride` is strict (any issue
 * rejects); when it rejects, the offending widgets are taken out and the rest
 * checked again, so one bad widget does not cost the visitor the others.
 */
export function checkStoredOverride(
  id: string,
  raw: unknown,
): { override: OverviewOverride | null; issues: OverviewIssue[] } {
  const definition = sectionOverview(id);
  if (!definition) {
    return {
      override: null,
      issues: [
        {
          widgetId: null,
          type: null,
          code: 'malformed',
          message: 'not an overview id',
        },
      ],
    };
  }
  const first = checkOverviewOverride(definition, raw, overviewRegistry);
  if (first.ok) return { override: first.override, issues: [] };
  const parsed = parseOverviewOverride(raw);
  const bad = new Set(
    first.issues.flatMap((issue) => (issue.widgetId ? [issue.widgetId] : [])),
  );
  if (!parsed.override) return { override: null, issues: first.issues };
  const second = checkOverviewOverride(
    definition,
    without(parsed.override, bad),
    overviewRegistry,
  );
  return second.ok
    ? { override: second.override, issues: first.issues }
    : { override: null, issues: [...first.issues, ...second.issues] };
}

/**
 * Read a cookbook's `overviews` value. `null` when it is not an object (the
 * caller rejects the file, as for any malformed field); otherwise every entry
 * is checked and what fails is dropped and reported.
 */
export function parseOverviews(
  input: unknown,
  layout: ShellLayout | undefined,
): ParsedOverviews | null {
  if (!isObject(input)) return null;
  const entries: [string, OverviewOverride][] = [];
  const dropped: string[] = [];
  for (const id of Object.keys(input).sort()) {
    if (!isOverviewId(id, layout)) {
      dropped.push(`Overview ${id} is not a page in this app and was dropped.`);
      continue;
    }
    const { override, issues } = checkStoredOverride(id, input[id]);
    for (const issue of issues) dropped.push(describe(id, issue));
    if (override) entries.push([id, override]);
  }
  // fromEntries defines own keys, so a "__proto__" id cannot touch the prototype.
  return { overviews: Object.fromEntries(entries), dropped };
}
