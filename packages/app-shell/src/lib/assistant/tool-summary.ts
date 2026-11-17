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
  if (!ok) {
    const reason = plainFailureReason(result);
    if (reason) return reason;
  }
  return sharedToolSummary(name, result, ok, options);
}

/**
 * Known failure classes, each with a fixed owner-facing sentence. The raw
 * error text (SQL, field lists, ids, paths) is only ever matched, never
 * echoed, so nothing from it can reach the card. Order matters: first match
 * wins. The sentences must not match their own patterns (stored summaries
 * pass through here again on reload).
 */
const FAILURE_REASONS: readonly [RegExp, string][] = [
  [
    /invalid where clause operator|unsupported .*filter operator|unknown (?:filter )?operator/i,
    'That search used a comparison the app cannot do, so nothing was looked up.',
  ],
  [
    /invalid where clause field|field does not exist|unknown field|no such column/i,
    'That used a field this list does not have.',
  ],
  [
    /sensitive field/i,
    'That field is private, so it cannot be used to search.',
  ],
  [
    /unique constraint|duplicate|already exists/i,
    'A record with those details already exists.',
  ],
  [
    /not null constraint|is required|required field|missing required|cannot be (?:null|empty)/i,
    'A required value was missing.',
  ],
  [
    /not found|no such record|does not exist/i,
    'That could not be found. It may have been removed.',
  ],
  [
    /forbidden|not allowed|permission|unauthori[sz]ed|access denied/i,
    'You do not have permission to do that.',
  ],
  [/timed? ?out|took too long/i, 'That took too long and was stopped.'],
  [
    /invalid (?:input|argument|value|type|enum)|validation|must be (?:a|an|one of)|expected (?:a|an|string|number|boolean)/i,
    'Some of the values were not in a form the app accepts.',
  ],
];

/** Every string an error result carries, however the tool wrapped it. */
function failureTexts(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || out.length > 12) return out;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === 'object')
        return failureTexts(parsed, depth + 1, out);
    } catch {
      // Plain text: matched as is.
    }
    out.push(value.slice(0, 2000));
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) failureTexts(item, depth + 1, out);
    return out;
  }
  const record = value as Record<string, unknown>;
  for (const key of [
    'error',
    'message',
    'summary',
    'text',
    'content',
    'structuredContent',
    'result',
    'data',
  ])
    failureTexts(record[key], depth + 1, out);
  return out;
}

/** The owner-facing sentence for a recognised failure, else undefined. */
function plainFailureReason(result: unknown): string | undefined {
  const text = failureTexts(result).join('\n');
  if (!text) return;
  return FAILURE_REASONS.find(([pattern]) => pattern.test(text))?.[1];
}

/**
 * A summary the server already made safe, shown on the card. Failures keep
 * their plain reason; chat re-checks it so nothing raw can reach the chip.
 */
export function shownSummary(name: string, summary: unknown, ok: boolean) {
  return ok || typeof summary !== 'string'
    ? toolSummary(name, summary, ok)
    : toolSummary(name, { summary }, false);
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
