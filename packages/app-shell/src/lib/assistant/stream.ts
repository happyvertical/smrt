// Server-sent events parser for the turn stream. Pure: feed it text as it
// arrives, get back the complete `TurnEvent`s. Partial frames wait for more;
// comments, unknown events and invalid JSON are skipped.
import type { TurnEvent } from './events.ts';

const KINDS = new Set<string>([
  'thread',
  'text',
  'tool_call',
  'tool_result',
  'approval_required',
  'approval_decided',
  'error',
  'done',
]);

export class SseParser {
  private buffer = '';

  push(chunk: string): TurnEvent[] {
    this.buffer += chunk.replace(/\r\n/g, '\n');
    const out: TurnEvent[] = [];
    for (;;) {
      const end = this.buffer.indexOf('\n\n');
      if (end < 0) break;
      const frame = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const event = parseFrame(frame);
      if (event) out.push(event);
    }
    return out;
  }
}

function parseFrame(frame: string): TurnEvent | null {
  let name = 'message';
  const data: string[] = [];
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:'))
      data.push(line.slice(5).replace(/^ /, ''));
  }
  if (name !== 'turn' || data.length === 0) return null;
  try {
    const value = JSON.parse(data.join('\n')) as { type?: unknown };
    return value && typeof value.type === 'string' && KINDS.has(value.type)
      ? (value as TurnEvent)
      : null;
  } catch {
    return null;
  }
}
