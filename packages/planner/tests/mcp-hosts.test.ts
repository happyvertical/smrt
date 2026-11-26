import { describe, expect, it } from 'vitest';
import { loadModel } from '../src/lib/assistant/engine.ts';
import { browserHost } from '../src/mcp/engine-host.ts';
import { NO_LOCAL_MODELS } from '../src/mcp/no-local-models.ts';
import { createSpeechModel } from '../src/mcp/voice-host.ts';

// What `scripts/build-mcp.ts` puts in the widget instead of the on-device
// model runtimes (#5707). A browser test would depend on WebGPU.
describe('MCP widget model hosts', () => {
  it('reports that a language model cannot load', async () => {
    await expect(
      loadModel('any-model', () => {}, undefined, browserHost),
    ).rejects.toThrow(NO_LOCAL_MODELS);
  });

  it('reports that a speech model cannot load', async () => {
    const model = createSpeechModel('moonshine-tiny');
    expect(await model.isCached()).toBe(false);
    await expect(model.load()).rejects.toThrow(NO_LOCAL_MODELS);
  });
});
