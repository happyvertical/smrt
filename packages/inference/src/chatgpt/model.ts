import type { AIMessage, AITool, AIToolCall } from '@happyvertical/ai';
import {
  type EngineModel,
  EngineModelFailure,
  engineModelReply,
} from '../engine-model.js';
import type { ChatGPTPlanConnection } from './connection.js';
import { chatgptFailureNote } from './support.js';

export interface ChatGPTModelOptions {
  connection: Pick<ChatGPTPlanConnection, 'clientOptions'>;
  model?: string;
  toolNamespace: { name: string; description: string };
  settingsHref?: string;
  /** Tests/hosts may supply a provider factory; never a raw API-key fallback. */
  createClient?(options: Record<string, unknown>): Promise<{
    chat(
      messages: AIMessage[],
      options: {
        tools: AITool[];
        signal: AbortSignal;
        onProgress(delta: string): void;
      },
    ): Promise<{
      content?: string;
      toolCalls?: AIToolCall[];
      usage?: { totalTokens?: number };
    }>;
  }>;
}

/** A model-round adapter for hosts that own the tool loop. Uses only chat + onProgress. */
export async function createChatGPTModel(
  input: ChatGPTModelOptions,
): Promise<EngineModel> {
  const options = await input.connection.clientOptions({
    ...(input.model ? { model: input.model } : {}),
    toolNamespace: input.toolNamespace,
  });
  const createClient =
    input.createClient ??
    (async (options) => {
      const { getAI } = await import('@happyvertical/ai');
      return getAI(options as unknown as Parameters<typeof getAI>[0]);
    });
  const ai = await createClient(options);
  return {
    async complete(request) {
      try {
        return engineModelReply(
          await ai.chat(request.messages, {
            tools: request.tools,
            signal: request.signal,
            onProgress: request.onText,
          }),
        );
      } catch (error) {
        const note = chatgptFailureNote(error, input.settingsHref);
        if (note)
          throw new EngineModelFailure(note.code, note.message, note.action, {
            cause: error,
          });
        throw error;
      }
    },
  };
}
