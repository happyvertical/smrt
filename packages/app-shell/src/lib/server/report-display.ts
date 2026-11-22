import type { GeneratedExpression } from '@happyvertical/smrt-core';
import { RuntimeReportError } from '@happyvertical/smrt-reports';
import type { AppDefinition, ReportDef } from '../../engine/index.ts';
import { fieldLabel } from '../ui/fields.ts';
import { HttpError } from './http.ts';

/**
 * The owner's sentence for a failure `reportFailure` described. That message
 * is written for the model (it names the spec path, which holds brackets the
 * chat chip refuses), so the owner gets a fixed plain sentence instead, with
 * no path, field list or raw reason in it.
 */
export function reportFailureForOwner(message: string): string {
  const path = /^The report definition is invalid at (spec[\w.[\]]*):/.exec(
    message,
  )?.[1];
  if (!path) return message;
  const part = /^spec\.(filters|having|sort|dimensions|measures)\b/.exec(
    path,
  )?.[1];
  if (part === 'filters' && /\.op$/.test(path))
    return 'A filter in that report used a comparison the app cannot do, so nothing was run.';
  const what = {
    filters: 'A filter',
    having: 'A condition on the totals',
    sort: 'The sorting',
    dimensions: 'A grouping',
    measures: 'A total or count',
  }[part ?? ''];
  return what
    ? `${what} in that report was not valid, so nothing was run.`
    : 'That report was not set up correctly, so nothing was run.';
}

/** Never forward a compiler/driver message: it can contain SQL or file paths. */
export function reportFailure(
  error: unknown,
  definition?: AppDefinition,
  report?: ReportDef,
): HttpError {
  if (
    error instanceof RuntimeReportError &&
    error.code === 'invalid_spec' &&
    /^spec\.(dimensions|measures)\[\d+\]\.as$/.test(error.path)
  )
    return new HttpError(
      400,
      'Give each report result a different name using lowercase words separated by underscores, or omit the result names. Keep the app’s source field names unchanged.',
    );
  if (error instanceof RuntimeReportError && error.code === 'invalid_spec') {
    // Parser paths and reasons are fixed grammar text, never SQL or file paths.
    // The model needs them to correct its own spec instead of guessing again.
    const path = /^spec[\w.[\]]*$/.test(error.path) ? error.path : 'spec';
    const prefix = `${error.path}: `;
    const reason = (
      error.path && error.message.startsWith(prefix)
        ? error.message.slice(prefix.length)
        : error.message
    )
      .replace(/[^\x20-\x7e]/g, ' ')
      .slice(0, 200)
      .trim();
    const hint = /^spec\.sort\[\d+\]/.test(path)
      ? ' Sort entries are {"by": output alias, "direction": "asc" or "desc"}.'
      : /^spec\.dimensions\[\d+\]\.bucket$/.test(path)
        ? ' A bucket is only valid on a date or datetime field.'
        : '';
    return new HttpError(
      400,
      `The report definition is invalid at ${path}: ${reason}.${hint} Correct that part and run the report again.`,
    );
  }
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
