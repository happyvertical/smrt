import { expect, it } from 'vitest';
import { plannerConversationStarters } from '../src/lib/assistant/starters.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { plannerReportSources } from '../src/lib/reports/sources.ts';

it('offers an intentional planning start for an empty app', () => {
  const result = plannerConversationStarters([]);
  expect(result.map((value) => value.label)).toEqual([
    'Help me plan my app',
    'What should my app track?',
  ]);
  expect(
    result.every((value) => !value.prompt.includes('runtime report')),
  ).toBe(true);
});
it('uses only real source fields for runtime report questions', () => {
  const sources = plannerReportSources(['commerce.sales'], recipes);
  expect(sources.length).toBeGreaterThan(0);
  const result = plannerConversationStarters(sources);
  expect(result).toContainEqual({
    label: `Report on ${sources[0].label}`,
    prompt: `Create a runtime report counting ${sources[0].label} in the sample data.`,
  });
  expect(result.some((value) => value.label.endsWith('by month'))).toBe(
    !!sources[0].dateField,
  );
  expect(result.some((value) => value.label.endsWith('totals'))).toBe(
    !!sources[0].amountField,
  );
});
