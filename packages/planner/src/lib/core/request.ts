import {
  HOST_HISTORY_CHARS,
  HOST_HISTORY_TURNS,
  HOST_MESSAGE_CHARS,
  HOST_WIRE_VERSION,
  type HostRequest,
} from '../inference/host.ts';
import {
  PLANNER_COMMANDS_VERSION,
  type PlanSnapshot,
} from '../planner/commands/types.ts';

export type HostRequestParse =
  | { ok: true; request: HostRequest }
  | { ok: false; error: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Check the JSON body the planner POSTs in host mode. Strict about the shape
 * (version, a non-empty message, a snapshot object of a known version, history
 * of user and assistant turns only), and clips lengths to the contract's limits
 * rather than refusing. The result feeds `buildHostPrompt`.
 */
export function parseHostRequest(body: unknown): HostRequestParse {
  if (!isObject(body))
    return { ok: false, error: 'the body must be an object' };
  if (body.version !== HOST_WIRE_VERSION) {
    return {
      ok: false,
      error: `unsupported version (this server speaks ${HOST_WIRE_VERSION})`,
    };
  }
  if (typeof body.message !== 'string' || !body.message.trim()) {
    return { ok: false, error: '"message" must be a non-empty string' };
  }
  const snapshot = body.snapshot;
  if (!isObject(snapshot) || snapshot.version !== PLANNER_COMMANDS_VERSION) {
    return { ok: false, error: '"snapshot" must be a version-1 plan snapshot' };
  }
  const history: NonNullable<HostRequest['history']> = [];
  if (body.history !== undefined) {
    if (!Array.isArray(body.history)) {
      return { ok: false, error: '"history" must be an array' };
    }
    for (const turn of body.history.slice(-HOST_HISTORY_TURNS)) {
      if (
        !isObject(turn) ||
        (turn.role !== 'user' && turn.role !== 'assistant') ||
        typeof turn.content !== 'string'
      ) {
        return {
          ok: false,
          error: '"history" entries need role user or assistant and content',
        };
      }
      history.push({
        role: turn.role,
        content: turn.content.slice(0, HOST_HISTORY_CHARS),
      });
    }
  }
  return {
    ok: true,
    request: {
      version: HOST_WIRE_VERSION,
      message: body.message.slice(0, HOST_MESSAGE_CHARS),
      snapshot: snapshot as unknown as PlanSnapshot,
      ...(history.length ? { history } : {}),
    },
  };
}
