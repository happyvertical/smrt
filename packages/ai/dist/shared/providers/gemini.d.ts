import { AICapabilities, AIInterface, AIMessage, AIModel, AIResponse, ChatOptions, CompletionOptions, EmbeddingOptions, EmbeddingResponse, GeminiOptions } from '../types';
export declare class GeminiProvider implements AIInterface {
    private options;
    private client;
    constructor(options: GeminiOptions);
    private initializeClientSync;
    private ensureClient;
    chat(messages: AIMessage[], options?: ChatOptions): Promise<AIResponse>;
    complete(prompt: string, options?: CompletionOptions): Promise<AIResponse>;
    embed(_text: string | string[], _options?: EmbeddingOptions): Promise<EmbeddingResponse>;
    stream(_messages: AIMessage[], _options?: ChatOptions): AsyncIterable<string>;
    countTokens(text: string): Promise<number>;
    getModels(): Promise<AIModel[]>;
    getCapabilities(): Promise<AICapabilities>;
    private mapToolChoice;
    private mapFinishReason;
    private messagesToGeminiFormat;
    private stripMarkdownCodeBlock;
    private mapError;
}
//# sourceMappingURL=gemini.d.ts.map