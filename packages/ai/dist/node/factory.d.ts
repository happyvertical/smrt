import { AIInterface } from '../shared/types';
/**
 * Re-export the universal getAI function
 */
export { getAI } from '../shared/factory';
/**
 * Node.js-enhanced auto-detection of AI provider based on available credentials
 * Includes support for environment variables
 *
 * @param options - Configuration options that may contain provider-specific credentials
 * @returns Promise resolving to an AI provider instance
 * @throws ValidationError if no provider can be detected from the options
 */
export declare function getAIAuto(options?: Record<string, any>): Promise<AIInterface>;
//# sourceMappingURL=factory.d.ts.map