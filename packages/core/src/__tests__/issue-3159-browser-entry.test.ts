import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { DecisionClient, DecisionRequest } from '../browser';
import { executeDecision } from '../browser';

const execFileAsync = promisify(execFile);

describe('Issue #3159: browser decision entry', () => {
  it('exports the typed runtime helper and contracts from the browser entry', async () => {
    const client: DecisionClient = {
      getCapabilities: async () => ({ decisions: true }),
      decide: async () => ({
        provenance: { provider: 'browser-test', model: 'browser-model' },
        answers: { result: { type: 'predicate', probability: 1 } },
      }),
    };
    const request: DecisionRequest = {
      state: {},
      questions: { result: { type: 'predicate', instructions: 'Check it.' } },
    };

    await expect(executeDecision(client, request)).resolves.toMatchObject({
      model: 'browser-model',
      provenance: { provider: 'browser-test', model: 'browser-model' },
    });
  });

  it('selects the browser runtime export through the package condition', async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        '--conditions=browser',
        '--input-type=module',
        '-e',
        "import('@happyvertical/smrt-core').then(({ executeDecision }) => console.log(typeof executeDecision))",
      ],
      { cwd: new URL('../..', import.meta.url) },
    );
    expect(stdout.trim()).toBe('function');
  });
});
