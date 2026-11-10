import { defaultCatalog, type PromptCatalog } from '../core/catalog.ts';
import type {
  BatchResult,
  CommandName,
  PlannerController,
  PlanSnapshot,
} from './commands/index.ts';
import {
  COMMAND_NAMES,
  type CommandTool,
  commandTools,
} from './commands/schemas.ts';
import type {
  PlannerGuideControl,
  PlannerGuideHandle,
  PlannerGuideResult,
} from './guide.ts';
import { applyPlannerHostReply } from './host-reply.ts';

const PROTOCOL = 'smrt-planner-commands';
const VERSION = 1;
const MAX_BYTES = 32768;
const MAX_COMMANDS = 16;
const MAX_RECEIPTS = 256;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export interface PlannerBridgeSnapshot {
  generation: string;
  snapshot: PlanSnapshot;
}
export interface PlannerBridgeContext extends PlannerBridgeSnapshot {
  catalog: PromptCatalog;
  tools: readonly CommandTool[];
}
export interface PlannerBridgeRequest {
  id: string;
  generation: string;
  expectedRevision: number;
}
export interface PlannerBridgeExecute extends PlannerBridgeRequest {
  commands: readonly { name: string; input: unknown }[];
}
export interface PlannerBridgeApplyReply extends PlannerBridgeRequest {
  reply: unknown;
}
export type PlannerBridgeResult = PlannerBridgeSnapshot & {
  ok: boolean;
  source: string;
  id?: string;
  result?: BatchResult;
  content?: string;
  spokenContent?: string;
  sampleContextApplied?: boolean;
  error?: { code: string; message: string };
};
export interface PlannerCommandPortClient {
  snapshot(): Promise<PlannerBridgeSnapshot>;
  context(): Promise<PlannerBridgeContext>;
  subscribe(listener: (state: PlannerBridgeSnapshot) => void): () => void;
  execute(input: PlannerBridgeExecute): Promise<PlannerBridgeResult>;
  applyReply(input: PlannerBridgeApplyReply): Promise<PlannerBridgeResult>;
  guide(input: {
    generation: string;
    kind: 'arrival' | 'addition' | 'control';
    control?: PlannerGuideControl;
    requestId?: string;
    /** How long to keep the spotlight, 1–30 s; default 6 s. */
    holdMs?: number;
  }): Promise<PlannerGuideResult>;
  dismissGuide(input: { generation: string }): Promise<{ ok: boolean }>;
  dispose(): void;
}

/** Bind a dedicated, already-authorized port to the actual mounted controller. */
export function bindPlannerCommandPort(options: {
  port: MessagePort;
  controller: PlannerController;
  allowedCommands: readonly CommandName[];
  /** Host-assigned provenance; never accepted from a model/request. */
  source: string;
  guide?: PlannerGuideHandle;
}): { invalidate(): void; dispose(): void } {
  const { port, controller, source } = options;
  if (
    !source ||
    source.length > 128 ||
    options.allowedCommands.some((name) => !COMMAND_NAMES.includes(name))
  )
    throw new Error('Invalid Planner command port policy.');
  const allowed = new Set(options.allowedCommands);
  let generation = crypto.randomUUID();
  let disposed = false;
  const receipts = new Map<
    string,
    {
      fingerprint: string;
      value: PlannerBridgeResult;
      before: PlanSnapshot;
      guided?: boolean;
    }
  >();
  const state = (): PlannerBridgeSnapshot => ({
    generation,
    snapshot: controller.snapshot(),
  });
  const send = (message: unknown) => {
    if (!disposed)
      port.postMessage({
        protocol: PROTOCOL,
        version: VERSION,
        ...(message as object),
      });
  };
  const fail = (
    code: string,
    message: string,
    id?: string,
  ): PlannerBridgeResult => ({
    ...state(),
    ok: false,
    source,
    ...(id ? { id } : {}),
    error: { code, message },
    content: message,
  });
  function execute(
    raw: unknown,
    mode: 'execute' | 'applyReply',
  ): PlannerBridgeResult {
    if (
      !object(raw) ||
      Object.keys(raw).some(
        (key) =>
          ![
            'id',
            'generation',
            'expectedRevision',
            mode === 'execute' ? 'commands' : 'reply',
          ].includes(key),
      ) ||
      typeof raw.id !== 'string' ||
      !raw.id ||
      raw.id.length > 128 ||
      typeof raw.generation !== 'string' ||
      !Number.isSafeInteger(raw.expectedRevision) ||
      Number(raw.expectedRevision) < 0
    )
      return fail('invalid_input', 'Invalid Planner command envelope.');
    const id = raw.id;
    if (raw.generation !== generation)
      return fail(
        'stale_generation',
        'This request belongs to an earlier Planner workspace.',
        id,
      );
    const fingerprint = JSON.stringify({ mode, ...raw });
    const cached = receipts.get(id);
    if (cached)
      return cached.fingerprint === fingerprint
        ? structuredClone(cached.value)
        : fail(
            'conflict',
            'This request id was already used for different input.',
            id,
          );
    if (receipts.size >= MAX_RECEIPTS)
      return fail(
        'limit_reached',
        'This command connection has reached its receipt limit. Reconnect before continuing.',
        id,
      );
    const before = controller.snapshot();
    let value: PlannerBridgeResult;
    const commandId = `${generation}:${id}`;
    if (mode === 'applyReply') {
      const applied = applyPlannerHostReply({
        controller,
        allowedCommands: [...allowed],
        id: commandId,
        expectedRevision: raw.expectedRevision as number,
        reply: raw.reply,
      });
      value = { ...state(), source, id, ...applied };
    } else {
      const commands = raw.commands;
      if (
        !Array.isArray(commands) ||
        commands.length === 0 ||
        commands.length > MAX_COMMANDS ||
        commands.some(
          (command) =>
            !object(command) ||
            Object.keys(command).some(
              (key) => !['name', 'input'].includes(key),
            ) ||
            typeof command.name !== 'string' ||
            !allowed.has(command.name as CommandName),
        )
      )
        return fail(
          'forbidden',
          'The request contains a command this host does not allow.',
          id,
        );
      const result = controller.batch({
        id: commandId,
        expectedRevision: raw.expectedRevision,
        commands,
      });
      value = {
        ...state(),
        source,
        id,
        ok: result.ok,
        result,
        ...(!result.ok
          ? { error: result.error, content: result.error.message }
          : {}),
      };
    }
    receipts.set(id, { fingerprint, value: structuredClone(value), before });
    return value;
  }
  const listener = async (event: MessageEvent) => {
    const raw: unknown = event.data;
    if (
      disposed ||
      !object(raw) ||
      raw.protocol !== PROTOCOL ||
      !Number.isSafeInteger(raw.requestId)
    )
      return;
    let value: unknown;
    const requestGeneration = generation;
    try {
      if (new TextEncoder().encode(JSON.stringify(raw)).length > MAX_BYTES)
        value = fail('invalid_input', 'Planner command message is too large.');
      else if (raw.version !== VERSION)
        value = fail(
          'unsupported_version',
          'Unsupported Planner command protocol.',
        );
      else if (raw.type === 'snapshot') value = state();
      else if (raw.type === 'context')
        value = { ...state(), catalog: defaultCatalog, tools: commandTools };
      else if (raw.type === 'guide') {
        const input = raw.input;
        if (
          !object(input) ||
          Object.keys(input).some(
            (key) =>
              ![
                'generation',
                'kind',
                'requestId',
                'control',
                'holdMs',
              ].includes(key),
          ) ||
          input.generation !== generation ||
          !['arrival', 'addition', 'control'].includes(String(input.kind)) ||
          (input.kind === 'control' &&
            !['build', 'export', 'chef', 'edit', 'specs', 'styles'].includes(
              String(input.control),
            )) ||
          (input.kind !== 'control' && input.control !== undefined) ||
          (input.holdMs !== undefined &&
            (typeof input.holdMs !== 'number' ||
              !Number.isFinite(input.holdMs) ||
              input.holdMs < 0)) ||
          !options.guide
        )
          value = {
            ok: false,
            reason: 'Guidance is unavailable for this workspace.',
          };
        else if (input.kind === 'control')
          value = await options.guide.highlight({
            kind: 'control',
            control: input.control as PlannerGuideControl,
            holdMs: input.holdMs as number | undefined,
          });
        else if (input.kind === 'arrival')
          value = await options.guide.highlight({
            kind: 'arrival',
            holdMs: input.holdMs as number | undefined,
          });
        else {
          const receipt =
            typeof input.requestId === 'string'
              ? receipts.get(input.requestId)
              : undefined;
          if (
            !receipt?.value.ok ||
            !receipt.value.result?.ok ||
            receipt.guided ||
            receipt.value.snapshot.revision !== controller.snapshot().revision
          )
            value = {
              ok: false,
              reason:
                'No current unshown successful addition receipt is available.',
            };
          else {
            value = await options.guide.highlight({
              kind: 'addition',
              before: receipt.before,
              result: receipt.value.result,
            });
            if ((value as PlannerGuideResult).ok) receipt.guided = true;
          }
        }
      } else if (raw.type === 'dismissGuide') {
        if (object(raw.input) && raw.input.generation === generation) {
          options.guide?.dismiss();
          value = { ok: true };
        } else value = { ok: false };
      } else if (raw.type === 'execute' || raw.type === 'applyReply')
        value = execute(raw.input, raw.type);
      else value = fail('invalid_input', 'Unknown Planner command operation.');
    } catch {
      value = fail(
        'invalid_input',
        'The Planner command could not be processed.',
      );
    }
    if (raw.type === 'guide' && requestGeneration !== generation)
      value = {
        ok: false,
        reason: 'The workspace changed before guidance was ready.',
      };
    send({ type: 'response', requestId: raw.requestId, value });
  };
  port.addEventListener('message', listener);
  port.start();
  const unsubscribe = controller.subscribe((snapshot) =>
    send({ type: 'state', value: { generation, snapshot } }),
  );
  return {
    invalidate() {
      if (disposed) return;
      generation = crypto.randomUUID();
      receipts.clear();
      options.guide?.dismiss();
      send({ type: 'state', value: state() });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      options.guide?.dismiss();
      unsubscribe();
      port.removeEventListener('message', listener);
      port.close();
      receipts.clear();
    },
  };
}

/** Client for a dedicated port; the host owns exact origin/source handshake checks. */
export function connectPlannerCommandPort(
  port: MessagePort,
): PlannerCommandPortClient {
  let next = 0;
  let disposed = false;
  let current: PlannerBridgeSnapshot | undefined;
  const listeners = new Set<(state: PlannerBridgeSnapshot) => void>();
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const listener = (event: MessageEvent) => {
    const message = event.data;
    if (
      disposed ||
      !object(message) ||
      message.protocol !== PROTOCOL ||
      message.version !== VERSION
    )
      return;
    if (message.type === 'response' && typeof message.requestId === 'number') {
      const call = pending.get(message.requestId);
      if (!call) return;
      clearTimeout(call.timer);
      pending.delete(message.requestId);
      call.resolve(message.value);
    } else if (message.type === 'state' && object(message.value)) {
      current = message.value as unknown as PlannerBridgeSnapshot;
      for (const subscriber of listeners) subscriber(structuredClone(current));
    }
  };
  port.addEventListener('message', listener);
  port.start();
  const request = (type: string, input?: unknown): Promise<unknown> => {
    if (disposed)
      return Promise.reject(
        new Error('Planner command connection is disposed.'),
      );
    if (pending.size >= 32)
      return Promise.reject(new Error('Too many pending Planner commands.'));
    return new Promise((resolve, reject) => {
      const requestId = ++next;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Planner command connection timed out.'));
      }, 10000);
      pending.set(requestId, { resolve, reject, timer });
      try {
        port.postMessage({
          protocol: PROTOCOL,
          version: VERSION,
          requestId,
          type,
          ...(input === undefined ? {} : { input }),
        });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(error);
      }
    });
  };
  return {
    snapshot: () => request('snapshot') as Promise<PlannerBridgeSnapshot>,
    context: () => request('context') as Promise<PlannerBridgeContext>,
    execute: (input) =>
      request('execute', input) as Promise<PlannerBridgeResult>,
    applyReply: (input) =>
      request('applyReply', input) as Promise<PlannerBridgeResult>,
    guide: (input) => request('guide', input) as Promise<PlannerGuideResult>,
    dismissGuide: (input) =>
      request('dismissGuide', input) as Promise<{ ok: boolean }>,
    subscribe(subscriber) {
      listeners.add(subscriber);
      if (current) subscriber(structuredClone(current));
      return () => listeners.delete(subscriber);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      port.removeEventListener('message', listener);
      port.close();
      listeners.clear();
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error('Planner command connection is disposed.'));
      }
      pending.clear();
    },
  };
}
