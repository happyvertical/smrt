/**
 * Fixtures for object.ts AI + memory coverage tests.
 *
 * Separate file so the @smrt() classes are picked up by test-manifest
 * generation. The AI client is injectable so is()/do()/describe() can run
 * against a stub without a real provider (mocking AI is the only mocking
 * allowed by the testing rules).
 *
 * @see src/object.ts (issue #1500 coverage, ORM group)
 */

import { SmrtObject } from '../../object.js';
import { smrt } from '../../registry.js';

/** Minimal stub matching the slice of AIClient that is()/do()/describe() use. */
export interface StubAi {
  message: (prompt: string, options?: any) => Promise<string>;
}

@smrt({ tableName: 'object_ai_memory_nodes' })
export class ObjectAiMemoryNode extends SmrtObject {
  name: string = '';

  /** Test seam: set this to control what the AI returns. */
  stubAi?: StubAi;

  /** Capture the last prompt/options passed to the stub for assertions. */
  lastPrompt?: string;
  lastOptions?: any;

  // Override the protected AI accessor to return our injectable stub instead
  // of resolving a real provider. This is the sanctioned "mock only AI" seam.
  protected async getAiClient(): Promise<any> {
    if (!this.stubAi) {
      throw new Error('stubAi not configured for ObjectAiMemoryNode');
    }
    const stub = this.stubAi;
    return {
      message: async (prompt: string, options?: any) => {
        this.lastPrompt = prompt;
        this.lastOptions = options;
        return stub.message(prompt, options);
      },
    };
  }
}
