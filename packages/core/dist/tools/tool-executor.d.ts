import { SignalBus } from '../signals/bus.js';
/**
 * Tool call structure from AI response
 */
export interface ToolCall {
    /**
     * Unique identifier for this tool call
     */
    id: string;
    /**
     * Type of tool (always 'function' for now)
     */
    type: 'function';
    /**
     * Function details
     */
    function: {
        /**
         * Name of the method to call
         */
        name: string;
        /**
         * JSON string of arguments to pass to the method
         */
        arguments: string;
    };
}
/**
 * Result of executing a tool call
 */
export interface ToolCallResult {
    /**
     * Tool call ID for correlation
     */
    id: string;
    /**
     * Method name that was called
     */
    methodName: string;
    /**
     * Parsed arguments that were used
     */
    arguments: Record<string, any>;
    /**
     * Result returned from the method
     */
    result: any;
    /**
     * Whether the call succeeded
     */
    success: boolean;
    /**
     * Error message if call failed
     */
    error?: string;
    /**
     * Execution time in milliseconds
     */
    duration?: number;
}
/**
 * Validates tool call arguments against method parameters
 *
 * @param methodName - Name of the method being called
 * @param args - Parsed arguments from tool call
 * @param allowedMethods - List of methods AI is allowed to call
 * @throws ValidationError if method not allowed or arguments invalid
 */
export declare function validateToolCall(methodName: string, args: Record<string, any>, allowedMethods: string[]): void;
/**
 * Executes a tool call on an object instance
 *
 * @param instance - Object instance to call method on
 * @param toolCall - Tool call from AI
 * @param allowedMethods - List of methods AI is allowed to call
 * @param signalBus - Optional signal bus for emitting execution events
 * @returns Result of the tool call execution
 */
export declare function executeToolCall(instance: any, toolCall: ToolCall, allowedMethods: string[], signalBus?: SignalBus): Promise<ToolCallResult>;
/**
 * Executes multiple tool calls in sequence
 *
 * @param instance - Object instance to call methods on
 * @param toolCalls - Array of tool calls from AI
 * @param allowedMethods - List of methods AI is allowed to call
 * @param signalBus - Optional signal bus for emitting execution events
 * @returns Array of tool call results
 */
export declare function executeToolCalls(instance: any, toolCalls: ToolCall[], allowedMethods: string[], signalBus?: SignalBus): Promise<ToolCallResult[]>;
/**
 * Formats tool call results into messages for AI
 *
 * @param results - Tool call execution results
 * @returns Array of tool response messages
 */
export declare function formatToolResults(results: ToolCallResult[]): Array<{
    role: 'tool';
    tool_call_id: string;
    content: string;
}>;
//# sourceMappingURL=tool-executor.d.ts.map