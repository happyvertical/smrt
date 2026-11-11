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
  return Object.entries(def.models[model].fields)
    .filter(
      ([, fd]) =>
        fd.calculated &&
        JSON.stringify(fd.calculated).includes(
          `"col":${JSON.stringify(field)}`,
        ),
    )
    .map(([name]) => `calculated field ${model}.${name}`);
}
