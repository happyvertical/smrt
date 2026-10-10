/** Synthetic media and application boundary for the listening workbench. */
import type {
  DataSurfaceActionRequest,
  DataSurfaceActionResult,
  DataSurfaceRegistry,
} from '@happyvertical/smrt-ui/data-surface';
import type {
  DictationSpeechResult,
  DictationSpeechSource,
} from '@happyvertical/smrt-ui/forms';
import type { CaptionTTSAdapter } from '../../../svelte/components/assistant/captions/caption-state.svelte.js';
import type { AssistantActionClient } from '../../../svelte/components/assistant/create-assistant-dock-controller.svelte.js';

/** A source, not another recognizer: Dictation owns its only subscription. */
export function createSyntheticSpeechSource() {
  const results = new Set<(result: DictationSpeechResult) => void>();
  const ends = new Set<() => void>();
  const source: DictationSpeechSource = {
    async start() {},
    async stop() {
      for (const callback of ends) callback();
    },
    onResult(callback) {
      results.add(callback);
      return () => results.delete(callback);
    },
    onEnd(callback) {
      ends.add(callback);
      return () => ends.delete(callback);
    },
    onError() {
      return () => {};
    },
  };
  return {
    source,
    emit(text: string, isFinal: boolean) {
      for (const callback of results) callback({ text, isFinal });
    },
  };
}

/** Manual playback clock; no microphone, provider, or audio device. */
export function createSyntheticPlayback() {
  const starts = new Set<() => void>();
  const ends = new Set<() => void>();
  const errors = new Set<(error: Error) => void>();
  const boundaries = new Set<(index: number, length: number) => void>();
  let settle: (() => void) | undefined;
  let length = 0;
  const adapter: CaptionTTSAdapter = {
    speak(text) {
      length = text.length;
      return new Promise<void>((resolve) => {
        settle = resolve;
      });
    },
    stop() {
      settle?.();
      settle = undefined;
    },
    onStart(callback) {
      starts.add(callback);
      return () => starts.delete(callback);
    },
    onEnd(callback) {
      ends.add(callback);
      return () => ends.delete(callback);
    },
    onError(callback) {
      errors.add(callback);
      return () => errors.delete(callback);
    },
    onBoundary(callback) {
      boundaries.add(callback);
      return () => boundaries.delete(callback);
    },
  };
  return {
    adapter,
    start() {
      for (const callback of starts) callback();
    },
    boundary() {
      for (const callback of boundaries) callback(0, length);
    },
    end() {
      for (const callback of ends) callback();
      settle?.();
      settle = undefined;
    },
  };
}

/** Demo-only action client using the dock's normal preview/apply protocol. */
export class MockAssistantActionClient implements AssistantActionClient {
  #previews = new Map<string, { request: string; revision: number }>();
  #applied = new Map<string, DataSurfaceActionResult>();

  constructor(
    private registry: DataSurfaceRegistry,
    private revision: () => number,
  ) {}

  async preview(
    request: DataSurfaceActionRequest,
  ): Promise<DataSurfaceActionResult> {
    this.#previews.set(request.requestId, {
      request: JSON.stringify({ ...request, phase: 'preview' }),
      revision: this.revision(),
    });
    return {
      version: 1,
      requestId: request.requestId,
      identity: request.identity,
      actionId: request.actionId,
      phase: 'preview',
      ok: true,
      confirmationToken: request.requestId,
      details: {
        project: 'Listening demo',
        status: 'ready',
        requiresConfirmation: true,
      },
    };
  }

  async apply(
    request: DataSurfaceActionRequest,
    key: string,
  ): Promise<DataSurfaceActionResult> {
    const cached = this.#applied.get(key);
    if (cached) return cached;
    const preview = this.#previews.get(request.requestId);
    const { confirmationToken, ...proposal } = request;
    const valid =
      preview &&
      confirmationToken === request.requestId &&
      preview.request === JSON.stringify({ ...proposal, phase: 'preview' });
    const outcome = valid
      ? await this.registry.execute({
          version: 1,
          commandId: request.requestId,
          identity: request.identity,
          expectedRevision: preview.revision,
          controlId: `data-surface.action.${request.actionId}`,
          payload: request.payload,
        })
      : { ok: false, reason: 'missing_preview' };
    const result: DataSurfaceActionResult = {
      version: 1,
      requestId: request.requestId,
      identity: request.identity,
      actionId: request.actionId,
      phase: 'apply',
      ok: outcome.ok,
      reason: outcome.ok ? undefined : outcome.reason,
    };
    this.#applied.set(key, result);
    return result;
  }
}
