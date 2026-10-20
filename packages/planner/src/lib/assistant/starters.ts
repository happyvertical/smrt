import type { PlannerReportSource } from '../reports/sources.ts';

/** Examples use only the active plan's declared runtime report sources. */
export function plannerConversationStarters(
  sources: readonly PlannerReportSource[],
) {
  const starters = [
    {
      label: 'Help me plan my app',
      prompt:
        'Help me plan my app. Ask me what my business needs before adding recipes.',
    },
  ];
  const source = sources[0];
  if (!source)
    return [
      ...starters,
      {
        label: 'What should my app track?',
        prompt:
          'Help me work out what my business app should track. Ask about my business first.',
      },
    ];
  starters.push({
    label: `Report on ${source.label}`,
    prompt: `Create a runtime report counting ${source.label} in the sample data.`,
  });
  if (source.dateField)
    starters.push({
      label: `${source.label} by month`,
      prompt: `Create a runtime report counting ${source.label} by month using ${source.dateField} in the sample data.`,
    });
  if (source.amountField)
    starters.push({
      label: `${source.label} totals`,
      prompt: `Create a runtime report showing the total ${source.amountField} for ${source.label} in the sample data.`,
    });
  return starters;
}
