// Tricia keeps its saved chip wording through chat's shared label mechanism.
import { toolSummary as sharedToolSummary } from '@happyvertical/smrt-chat/tool-summary';
import { validReportResult } from '@happyvertical/smrt-reports/display';
import type { AppReportResult } from '../ui/types.ts';

export function toolSummary(name: string, result: unknown, ok = true): string {
  const options = { recordLabels: 'generic' as const, plainTextSummary: true };
  if (!ok && name === 'app_runreport') {
    const failure = reportPayload(result);
    if (failure?.kind === 'report_failure') {
      const summary = sharedToolSummary(name, failure, true, options);
      if (summary !== 'Completed this action') return summary;
    }
  }
  return sharedToolSummary(name, result, ok, options);
}

const reportPayload = (
  input: unknown,
  depth = 0,
): Record<string, unknown> | undefined => {
  if (depth > 6) return;
  if (typeof input === 'string') {
    if (input.length > 2_000_000) return;
    try {
      return reportPayload(JSON.parse(input), depth + 1);
    } catch {
      return;
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const record = input as Record<string, unknown>;
  if (
    validReportResult(record) ||
    (record.kind === 'report_failure' && typeof record.summary === 'string')
  )
    return record;
  for (const key of ['structuredContent', 'result', 'data']) {
    const found = reportPayload(record[key], depth + 1);
    if (found) return found;
  }
  if (Array.isArray(record.content))
    for (const block of record.content) {
      const found = reportPayload(block?.text, depth + 1);
      if (found) return found;
    }
  return;
};

/** Engine-run reports only. Rows are transient UI data, never tool-chip text. */
export function reportPresentation(
  name: string,
  value: unknown,
  ok = true,
): { result: AppReportResult; href?: string } | undefined {
  if (!ok || name !== 'app_runreport') return;
  const result = reportPayload(value);
  if (!result || !validReportResult(result)) return;
  const saved =
    typeof result.reportName === 'string' &&
    /^[a-zA-Z][a-zA-Z0-9]*$/.test(result.reportName)
      ? result.reportName
      : undefined;
  return {
    result: result as AppReportResult,
    ...(saved ? { href: `/reports/${encodeURIComponent(saved)}` } : {}),
  };
}
export function reportLink(value: unknown): string | undefined {
  return typeof value === 'string' &&
    /^\/reports\/[a-zA-Z][a-zA-Z0-9]*$/.test(value)
    ? value
    : undefined;
}
