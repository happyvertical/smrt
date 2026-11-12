/** Plain-language tool labels shared by the built-in loop and external drivers. */
import type { ToolInvocation } from './tool-loop.js';

export type AssistantToolOutcome = Pick<ToolInvocation, 'ok' | 'observation'>;

/** The existing describe seam, with an optional completed result. */
export type DescribeAssistantTool = (
  name: string,
  args?: Record<string, unknown>,
  outcome?: AssistantToolOutcome,
  options?: { recordLabels?: 'generic' },
) => string;

// Tool payloads belong to the model, never to a chip or its title attribute.
function safeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const text = value.replace(/\s+/g, ' ').trim();
  if (
    !text ||
    /[{}[\]<>]|(?:\/|[A-Z]:\\)\S+|\b(?:ALTER TABLE|CREATE TABLE|DROP TABLE|SELECT .* FROM|INSERT INTO|DELETE FROM|Bearer|token|password|secret|api.?key)\b|\b(?:sk-|eyJ)[\w-]+|\b[\w-]{32,}\b/i.test(
      text,
    )
  )
    return;
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

function payload(
  value: unknown,
  depth = 0,
  plainText = false,
): Record<string, unknown> | unknown[] | undefined {
  if (depth > 6) return;
  if (typeof value === 'string') {
    try {
      return payload(JSON.parse(value), depth + 1, plainText);
    } catch {
      return plainText ? { summary: value } : undefined;
    }
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.summary === 'string') return record;
  for (const key of ['data', 'result', 'structuredContent']) {
    const found = payload(record[key], depth + 1, plainText);
    if (found) return found;
  }
  if (Array.isArray(record.content)) {
    for (const block of record.content) {
      const found = payload(block?.text, depth + 1, plainText);
      if (found) return found;
    }
  }
  return record;
}

/** Short bounded summaries; never echoes an unknown tool name or a raw payload. */
export const describeAssistantTool: DescribeAssistantTool = (
  name,
  _args,
  outcome,
  options,
) => {
  if (outcome && !outcome.ok) return 'Could not complete this action';
  const special: Record<string, string> = {
    app_describe: 'Checked the app structure',
    'app.describe': 'Checked the app structure',
    'app.history': 'Checked app history',
    'recipes.search': 'Looked for useful lists',
    'recipes.describe': 'Checked how a list works',
    app_history: 'Checked app history',
    approval_pending: 'Checked pending approvals',
  };
  if (outcome && special[name]) return special[name];
  if (
    outcome &&
    options?.recordLabels === 'generic' &&
    /(?:_list|_search|_get)$/.test(name)
  )
    return 'Checked records';
  const match =
    /^([a-z][a-z\d]*(?:[._-][a-z][a-z\d]*)*)[._-](create|update|delete|remove|list|search|read|get)$/i.exec(
      name,
    );
  const record = outcome ? payload(outcome.observation) : undefined;
  const summary =
    record && !Array.isArray(record) ? safeText(record.summary) : undefined;
  if (summary) return summary;
  if (outcome && options?.recordLabels === 'generic')
    return 'Completed this action';
  if (!match) {
    return outcome ? 'Completed this action' : 'Working on this action';
  }
  const plural = match[1]
    .replace(/[._-]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
  const noun = plural.replace(/ies$/, 'y').replace(/(?<!s)s$/, '');
  const action = match[2].toLowerCase();
  const verb = {
    create: ['Adding', 'Added'],
    update: ['Updating', 'Updated'],
    delete: ['Deleting', 'Deleted'],
    remove: ['Deleting', 'Deleted'],
    list: ['Looking up', 'Looked up'],
    search: ['Looking up', 'Looked up'],
    read: ['Looking up', 'Looked up'],
    get: ['Looking up', 'Looked up'],
  }[action] ?? ['Working on', 'Completed'];
  if (!outcome)
    return `${verb[0]} ${['list', 'search', 'read'].includes(action) ? plural : noun}`;
  if (['list', 'search', 'read'].includes(action)) {
    const rows = Array.isArray(record)
      ? record
      : (record?.items ?? record?.rows);
    const count = Array.isArray(rows) ? rows.length : undefined;
    return `${verb[1]} ${count === undefined ? '' : `${count} `}${count === 1 ? noun : plural}`;
  }
  const displayName =
    record && !Array.isArray(record)
      ? safeText(record.name ?? record.displayName ?? record.title)
      : undefined;
  return `${verb[1]} ${noun}${displayName ? ` ${displayName}` : ''}`;
};

/** Shell-compatible result entry point, using the same describe/label mechanism. */
export function toolSummary(
  name: string,
  result: unknown,
  ok = true,
  options?: { recordLabels?: 'generic'; plainTextSummary?: boolean },
): string {
  if (!ok) return 'Could not complete this action';
  const compatible = options?.plainTextSummary
    ? payload(result, 0, true)
    : undefined;
  const text = safeText(
    options?.plainTextSummary
      ? compatible && !Array.isArray(compatible)
        ? compatible.summary
        : undefined
      : result,
  );
  const summary =
    text &&
    (options?.plainTextSummary ||
      /^(?:Added|Updated|Deleted|Removed|Created|Checked|Looked up|Completed|Could not)\b/i.test(
        text,
      ))
      ? text
      : undefined;
  return describeAssistantTool(
    name,
    undefined,
    {
      ok,
      observation: summary ? { summary } : result,
    },
    options,
  );
}
