import type { EngineHost } from '../lib/assistant/engine.ts';
import { NO_LOCAL_MODELS } from './no-local-models.ts';

/**
 * Replaces `lib/assistant/engine-host.ts` in the MCP widget build
 * (`scripts/build-mcp.ts`): a local model cannot load there, and bundling
 * WebLLM into the one self-contained file costs megabytes per release.
 */
const unavailable = (): never => {
  throw new Error(NO_LOCAL_MODELS);
};

export const browserHost: EngineHost = {
  createWorker: unavailable,
  createEngine: async () => unavailable(),
};
