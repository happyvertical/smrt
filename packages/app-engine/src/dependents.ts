import type { GeneratedExpression } from '@happyvertical/smrt-core';
import type { AppDefinition } from './definition.ts';

/** Walk the SDK's expression data; never interpret or render SQL here. */
export function rewriteExpression(
  expression: GeneratedExpression,
  from: string,
  to: string,
): GeneratedExpression {
  return JSON.parse(JSON.stringify(expression), (key, value) =>
    key === 'col' && value === from ? to : value,
  );
}

export function fieldDependents(
  def: AppDefinition,
  model: string,
  field: string,
): string[] {
  const calculated = Object.entries(def.models[model].fields)
    .filter(
      ([, fd]) =>
        fd.calculated &&
        JSON.stringify(fd.calculated).includes(
          `"col":${JSON.stringify(field)}`,
        ),
    )
    .map(([name]) => `calculated field ${model}.${name}`);
  return [
    ...calculated,
    ...Object.entries(def.reports ?? {})
      .filter(
        ([, r]) =>
          r.spec.source === model &&
          [...r.spec.dimensions, ...r.spec.measures, ...r.spec.filters].some(
            (f) => f.field === field,
          ),
      )
      .map(([name]) => `report ${name}`),
  ];
}

export function rewriteReports(
  def: AppDefinition,
  model: string,
  from: string,
  to: string,
) {
  for (const report of Object.values(def.reports ?? {})) {
    if (report.spec.source !== model) continue;
    for (const node of [
      ...report.spec.dimensions,
      ...report.spec.measures,
      ...report.spec.filters,
    ])
      if (node.field === from) node.field = to;
  }
}
