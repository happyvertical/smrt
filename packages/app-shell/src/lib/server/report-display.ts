import type { GeneratedExpression } from '@happyvertical/smrt-core';
import { RuntimeReportError } from '@happyvertical/smrt-reports';
import type { AppDefinition, ReportDef } from '../../engine/index.ts';
import { fieldLabel } from '../ui/fields.ts';
import { HttpError } from './http.ts';

/** Never forward a compiler/driver message: it can contain SQL or file paths. */
export function reportFailure(
  error: unknown,
  definition?: AppDefinition,
  report?: ReportDef,
): HttpError {
  if (error instanceof RuntimeReportError && error.code === 'invalid_result') {
    const measure = report?.spec.measures.find((m) => m.as === error.path);
    const model = report && definition?.models[report.spec.source];
    const field = measure?.field && model?.fields[measure.field];
    if (measure?.fn === 'sum' && measure.field && field && model) {
      const inputs = new Set<string>();
      const visit = (node: GeneratedExpression) => {
        if ('col' in node) {
          const input = model.fields[node.col];
          if (input) inputs.add(fieldLabel(node.col, input));
        } else {
          for (const child of Object.values(node)) {
            if (Array.isArray(child)) child.forEach(visit);
            else if (child && typeof child === 'object') visit(child);
          }
        }
      };
      if (field.calculated) visit(field.calculated);
      const hint = inputs.size
        ? ` One of the ${model.label ?? report?.spec.source} probably has a mistyped ${[...inputs].join(' or ')}.`
        : ' Check the values in this field.';
      return new HttpError(
        400,
        `The total of ${fieldLabel(measure.field, field)} is too large to show exactly.${hint}`,
      );
    }
    return new HttpError(
      400,
      'A report value is too large to show exactly. Check the values used by this report.',
    );
  }
  const message = error instanceof Error ? error.message : '';
  if (/time limit/i.test(message))
    return new HttpError(
      409,
      'This report took too long. Try a smaller period or fewer groups.',
    );
  return new HttpError(
    400,
    'This report could not run. Its fields may have changed. Ask the assistant to update it.',
  );
}
