import type { OverviewWidget } from './types.js';

/** One section blueprint shared by cookbook apps and Planner's static pages. */
export function sectionOverviewDefaults(options: {
  lead?: { id: string; name: string; plural: string };
  dataWidgets?: boolean;
  page?: OverviewWidget;
  override?: unknown;
}): OverviewWidget[] {
  if (options.dataWidgets && options.page) return [options.page];
  const widgets: OverviewWidget[] = [
    { id: 'shortcuts', type: 'shortcuts', span: 4, options: {} },
  ];
  if (options.dataWidgets && options.lead) {
    const lead = options.lead;
    const raw = options.override;
    const stored =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : undefined;
    const changed = stored?.changed;
    // Sparse overrides never save unchanged defaults. Retain the original
    // count definition only for an explicit legacy edit; normal validation
    // still applies its span/options/version patch. Removal always wins.
    if (
      changed &&
      typeof changed === 'object' &&
      !Array.isArray(changed) &&
      Object.hasOwn(changed, 'count') &&
      !(Array.isArray(stored?.removed) && stored.removed.includes('count'))
    ) {
      widgets.push({
        id: 'count',
        type: 'metric',
        span: 1,
        options: { title: lead.plural, model: lead.id, measure: 'count' },
      });
    }
    widgets.push({
      id: 'latest',
      type: 'records',
      span: 4,
      options: {
        title: `${lead.name} records`,
        model: lead.id,
        limit: 5,
        summaries: false,
      },
    });
  }
  return widgets;
}
