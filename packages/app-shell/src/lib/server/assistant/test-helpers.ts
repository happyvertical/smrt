// Test helpers for the assistant suites: a scripted stub model (nothing here
// reaches a network) and a driver that runs one turn and collects its events.
import type { TurnEvent, TurnStop } from '../../assistant/events.ts';
import type { Principal } from '../owner.ts';
import type { holdForUser } from './hold.ts';
import type {
  AssistantModel,
  ModelReply,
  ModelRequest,
  ModelToolCall,
} from './model.ts';
import { createThread } from './threads.ts';
import { runTurn, type TurnLimits } from './turn.ts';

export type Step = (request: ModelRequest) => ModelReply | Promise<ModelReply>;

let counter = 0;
export function call(name: string, args: unknown = {}): ModelToolCall {
  counter += 1;
  return {
    id: `call_${counter}`,
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
  };
}

export function say(text: string, ...calls: ModelToolCall[]): ModelReply {
  return { text, toolCalls: calls };
}

/** Plays `steps` in order; repeats the last step when it runs out. */
export function scripted(steps: Step[]) {
  const requests: ModelRequest[] = [];
  const model: AssistantModel = {
    async complete(request) {
      requests.push(request);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)];
      return step(request);
    },
  };
  return { model, requests };
}

export async function drive(options: {
  principal: Principal;
  model: AssistantModel;
  text?: string;
  limits?: Partial<TurnLimits>;
  signal?: AbortSignal;
  hold?: typeof holdForUser;
  onEvent?: (event: TurnEvent) => void;
}): Promise<{ events: TurnEvent[]; stop: TurnStop; threadId: string }> {
  const thread = await createThread(options.principal.id, 'test');
  const events: TurnEvent[] = [];
  const stop = await runTurn({
    principal: options.principal,
    thread,
    text: options.text ?? 'hello',
    model: options.model,
    signal: options.signal ?? new AbortController().signal,
    emit: (e) => {
      events.push(e);
      options.onEvent?.(e);
    },
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.hold ? { hold: options.hold } : {}),
  });
  return { events, stop, threadId: thread.id as string };
}
