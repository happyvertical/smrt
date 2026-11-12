// One line of a CLI's JSON stream -> a small tool-neutral event. A line that is
// not JSON, or an event kind this does not know, is ignored: both tools add
// event kinds over time, and nothing here may depend on a kind it has not seen.
//
// `forbidden` is a safety net, not the lock: every machine-touching tool is
// switched off on the command line (see ./session.ts). If a stream ever shows
// one anyway, the turn stops instead of carrying on.

export type AgentEvent =
  | { type: 'session'; id: string }
  | { type: 'execution_model'; model: string }
  | { type: 'text'; delta: string }
  /** A whole message (the tool did not stream it, or it is the last word). */
  | { type: 'message'; text: string }
  | { type: 'tool_use'; id: string; name: string; args: string }
  | { type: 'tool_result'; id: string; ok: boolean; text: string }
  | { type: 'forbidden'; what: string }
  | {
      type: 'done';
      ok: boolean;
      text?: string;
      error?: string;
      tokens?: number;
    };

/** The MCP server name both tools are given, and so the tool-name prefix. */
export const MCP_SERVER_NAME = 'smrt';
const CLAUDE_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function parse(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return obj(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((part) => str(obj(part)?.text) || '')
      .filter(Boolean)
      .join('\n');
  return '';
}

/** A tool name as the shell knows it (`mcp__smrt__app_describe` -> `app_describe`). */
export function shellToolName(name: string): string {
  return name.startsWith(CLAUDE_PREFIX)
    ? name.slice(CLAUDE_PREFIX.length)
    : name;
}

/** Stateful: Claude Code streams text deltas, then repeats the text whole. */
export function claudeParser() {
  let streamed = false;
  return (line: string): AgentEvent[] => {
    const e = parse(line);
    if (!e) return [];
    const out: AgentEvent[] = [];
    const type = str(e.type);
    const reportedModel =
      type === 'system' && str(e.subtype) === 'init'
        ? e.model
        : type === 'assistant'
          ? obj(e.message)?.model
          : undefined;
    if (
      typeof reportedModel === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(reportedModel)
    )
      out.push({ type: 'execution_model', model: reportedModel });
    if (type === 'system' && str(e.subtype) === 'init' && str(e.session_id))
      out.push({ type: 'session', id: str(e.session_id) });
    else if (type === 'stream_event') {
      const event = obj(e.event);
      if (str(event?.type) === 'message_start') streamed = false;
      const delta = obj(event?.delta);
      if (
        str(event?.type) === 'content_block_delta' &&
        str(delta?.type) === 'text_delta' &&
        str(delta?.text)
      ) {
        // Text of a sub-agent is not the person's conversation.
        if (!e.parent_tool_use_id) {
          streamed = true;
          out.push({ type: 'text', delta: str(delta?.text) });
        }
      }
    } else if (type === 'assistant') {
      const content = obj(e.message)?.content;
      for (const block of Array.isArray(content) ? content : []) {
        const b = obj(block);
        if (!b) continue;
        if (str(b.type) === 'text' && !streamed && str(b.text))
          out.push({ type: 'message', text: str(b.text) });
        else if (str(b.type) === 'tool_use') {
          const name = str(b.name);
          if (!name.startsWith(CLAUDE_PREFIX))
            out.push({ type: 'forbidden', what: name || 'a tool' });
          else
            out.push({
              type: 'tool_use',
              id: str(b.id),
              name: shellToolName(name),
              args: JSON.stringify(b.input ?? {}),
            });
        }
      }
      streamed = false;
    } else if (type === 'user') {
      const content = obj(e.message)?.content;
      for (const block of Array.isArray(content) ? content : []) {
        const b = obj(block);
        if (b && str(b.type) === 'tool_result')
          out.push({
            type: 'tool_result',
            id: str(b.tool_use_id),
            ok: b.is_error !== true,
            text: textOfContent(b.content),
          });
      }
    } else if (type === 'result') {
      const ok = e.is_error !== true && str(e.subtype) === 'success';
      out.push({
        type: 'done',
        ok,
        ...(e.structured_output && typeof e.structured_output === 'object'
          ? { text: JSON.stringify(e.structured_output) }
          : str(e.result)
            ? { text: str(e.result) }
            : {}),
        ...usageTokens(e.usage),
        ...(!ok
          ? {
              error: ['model_not_available', 'model_access_denied'].includes(
                str(e.error_code),
              )
                ? 'plan_model_refused'
                : str(e.subtype) || 'error',
            }
          : {}),
      });
    }
    return out;
  };
}

/**
 * The only item kinds a turn through the shell's tools produces. Anything
 * else (a command, a file change, a web search, a sub-agent call, a kind a
 * newer Codex adds) is treated as forbidden: fail closed.
 */
const CODEX_ALLOWED_ITEMS: ReadonlySet<string> = new Set([
  'agent_message',
  'reasoning',
  'mcp_tool_call',
  'todo_list',
  'error',
  'user_message',
]);

/** Codex `exec --json`: whole items, no text deltas. */
export function codexParser() {
  return (line: string): AgentEvent[] => {
    const e = parse(line);
    if (!e) return [];
    const type = str(e.type);
    if (type === 'thread.started' && str(e.thread_id))
      return [{ type: 'session', id: str(e.thread_id) }];
    if (type === 'turn.completed')
      return [{ type: 'done', ok: true, ...usageTokens(e.usage) }];
    if (type === 'turn.failed' || type === 'error') {
      const failure = obj(e.error);
      return [
        {
          type: 'done',
          ok: false,
          error: ['model_not_available', 'model_access_denied'].includes(
            str(failure?.code),
          )
            ? 'plan_model_refused'
            : str(failure?.message) || str(e.message) || 'error',
        },
      ];
    }
    const item = obj(e.item);
    if (!item || !(type === 'item.started' || type === 'item.completed'))
      return [];
    const kind = str(item.type);
    if (
      kind === 'error' &&
      str(item.message).includes('code-mode host is disabled')
    )
      return [{ type: 'done', ok: false, error: 'tool_host_policy' }];
    if (!CODEX_ALLOWED_ITEMS.has(kind))
      return [{ type: 'forbidden', what: kind || 'an item' }];
    if (kind === 'agent_message' && type === 'item.completed' && str(item.text))
      return [{ type: 'message', text: str(item.text) }];
    if (kind === 'mcp_tool_call') {
      // Only the shell's own server.
      if (str(item.server) !== MCP_SERVER_NAME)
        return [
          {
            type: 'forbidden',
            what: `a tool of ${str(item.server) || 'another server'}`,
          },
        ];
      const id = str(item.id);
      if (type === 'item.started')
        return [
          {
            type: 'tool_use',
            id,
            name: shellToolName(str(item.tool)),
            args: JSON.stringify(item.arguments ?? {}),
          },
        ];
      const result = obj(item.result);
      const failed = str(item.status) === 'failed' || item.error != null;
      return [
        {
          type: 'tool_result',
          id,
          ok: !failed && result?.is_error !== true,
          text:
            textOfContent(result?.content) ||
            str(obj(item.error)?.message) ||
            (result?.structured_content
              ? JSON.stringify(result.structured_content)
              : ''),
        },
      ];
    }
    return [];
  };
}

/** Native Anthropic input_tokens excludes cache reads/creation. Codex cached_input_tokens
 * is already part of input_tokens and is deliberately not added again. */
function usageTokens(value: unknown): { tokens?: number } {
  const usage = obj(value);
  if (usage?.input_tokens === undefined || usage.output_tokens === undefined)
    return {};
  const counts = [
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_read_input_tokens ?? 0,
    usage.cache_creation_input_tokens ?? 0,
  ];
  if (
    !counts.every(
      (count) =>
        typeof count === 'number' && Number.isSafeInteger(count) && count >= 0,
    )
  )
    return {};
  const total = (counts as number[]).reduce((sum, count) => sum + count, 0);
  return Number.isSafeInteger(total) ? { tokens: total } : {};
}
