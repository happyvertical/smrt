import { AICapabilities, AIInterface, AIMessage, AIModel, AIResponse, BedrockOptions, ChatOptions, CompletionOptions, EmbeddingOptions, EmbeddingResponse } from '../types';
export declare class BedrockProvider implements AIInterface {
    private options;
    private client;
    constructor(options: BedrockOptions);
    private initializeClientSync;
    private ensureClient;
    chat(messages: AIMessage[], options?: ChatOptions): Promise<AIResponse>;
    complete(prompt: string, options?: CompletionOptions): Promise<AIResponse>;
    embed(_text: string | string[], _options?: EmbeddingOptions): Promise<EmbeddingResponse>;
    stream(_messages: AIMessage[], _options?: ChatOptions): AsyncIterable<string>;
    countTokens(text: string): Promise<number>;
    getModels(): Promise<AIModel[]>;
    getCapabilities(): Promise<AICapabilities>;
    private chatWithClaude;
    private chatWithTitan;
    private chatWithCohere;
    private chatWithLlama;
    private mapMessagesToClaude;
    private mapClaudeFinishReason;
    private mapError;
}
//# sourceMappingURL=bedrock.d.ts.map