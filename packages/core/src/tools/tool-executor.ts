/**
 * Tool Call Execution for AI Function Calling
 *
 * This module handles runtime execution of AI tool calls on SMRT object instances.
 */

import { createLogger } from '@happyvertical/logger';
import type { Signal } from '@happyvertical/smrt-types';
import { RuntimeError, ValidationError } from '../errors.js';
import type { SignalBus } from '../signals/bus.js';

const logger = createLogger({ level: 'info' });

/**
 * A dynamically-dispatched tool target (typically a SmrtObject instance, but
 * typed structurally so any object whose method names are resolved at runtime
 * from the AI tool call is accepted). No index signature is declared so plain
 * class instances like `SmrtObject` remain assignable; dynamic method lookup
 * goes through a `Record<string, unknown>` cast at the call boundary.
 */
interface ToolCallTarget {
  id?: string | null;
  constructor?: { name?: string };
}

/**
 * A callable resolved from a {@link ToolCallTarget} by method name. The method
 * is actually invoked with the parsed (untyped JSON) tool-call arguments, so
 * the parameter list is `unknown[]` rather than `never[]`.
 */
type InstanceMethod = (...args: unknown[]) => unknown;

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
  arguments: Record<string, unknown>;

  /**
   * Result returned from the method
   */
  result: unknown;

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
export function validateToolCall(
  methodName: string,
  args: Record<string, unknown>,
  allowedMethods: string[],
): void {
  // Check if method is allowed
  if (!allowedMethods.includes(methodName)) {
    throw ValidationError.invalidValue(
      'methodName',
      methodName,
      `Method must be one of: ${allowedMethods.join(', ')}`,
    );
  }

  // Basic argument validation (could be enhanced)
  if (typeof args !== 'object' || args === null) {
    throw ValidationError.invalidValue(
      'arguments',
      args,
      'Arguments must be a valid object',
    );
  }
}

/**
 * Executes a tool call on an object instance
 *
 * @param instance - Object instance to call method on
 * @param toolCall - Tool call from AI
 * @param allowedMethods - List of methods AI is allowed to call
 * @param signalBus - Optional signal bus for emitting execution events
 * @returns Result of the tool call execution
 */
export async function executeToolCall(
  instance: ToolCallTarget,
  toolCall: ToolCall,
  allowedMethods: string[],
  signalBus?: SignalBus,
): Promise<ToolCallResult> {
  const startTime = Date.now();
  const methodName = toolCall.function.name;
  const executionId = signalBus?.generateExecutionId() ?? toolCall.id;

  // Declare args outside try blocks so it's accessible in catch block
  let args: Record<string, unknown> | undefined;

  try {
    // Parse arguments
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch (_parseError) {
      throw ValidationError.invalidValue(
        'arguments',
        toolCall.function.arguments,
        'Arguments must be valid JSON',
      );
    }

    // Type guard - args is always defined after successful parsing
    if (!args) {
      throw ValidationError.invalidValue(
        'arguments',
        toolCall.function.arguments,
        'Arguments must be a valid object',
      );
    }

    // Validate tool call
    validateToolCall(methodName, args, allowedMethods);

    // Check method exists. The target is dynamically dispatched, so the method
    // is resolved by string index (cast to a record) and the result is
    // `unknown`; narrow it to a callable at this boundary after the runtime
    // `typeof === 'function'` guard.
    const method = (instance as Record<string, unknown>)[methodName];
    if (typeof method !== 'function') {
      throw RuntimeError.operationFailed(
        `Method '${methodName}' not found on object`,
      );
    }
    const invokeMethod = method as InstanceMethod;

    // Emit start signal
    if (signalBus) {
      const startSignal: Signal = {
        id: executionId,
        objectId: instance.id ?? 'unknown',
        className: instance.constructor?.name ?? 'Unknown',
        method: methodName,
        type: 'start',
        args: [args], // Wrap in array for consistency
        timestamp: new Date(),
      };
      await signalBus.emit(startSignal);
    }

    // Execute method
    const result = await invokeMethod(args);

    // Emit end signal
    if (signalBus) {
      const endSignal: Signal = {
        id: executionId,
        objectId: instance.id ?? 'unknown',
        className: instance.constructor?.name ?? 'Unknown',
        method: methodName,
        type: 'end',
        args: [args],
        result,
        duration: Date.now() - startTime,
        timestamp: new Date(),
      };
      await signalBus.emit(endSignal);
    }

    return {
      id: toolCall.id,
      methodName,
      arguments: args,
      result,
      success: true,
      duration: Date.now() - startTime,
    };
  } catch (error) {
    // Emit error signal
    if (signalBus) {
      const errorSignal: Signal = {
        id: executionId,
        objectId: instance.id ?? 'unknown',
        className: instance.constructor?.name ?? 'Unknown',
        method: methodName,
        type: 'error',
        // Preserve actual args if parsed, otherwise include raw arguments for debugging
        args: [
          typeof args !== 'undefined' ? args : toolCall.function.arguments,
        ],
        error: error instanceof Error ? error : new Error(String(error)),
        duration: Date.now() - startTime,
        timestamp: new Date(),
      };
      await signalBus.emit(errorSignal);
    }

    return {
      id: toolCall.id,
      methodName,
      arguments: {},
      result: null,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - startTime,
    };
  }
}

/**
 * Executes multiple tool calls in sequence
 *
 * @param instance - Object instance to call methods on
 * @param toolCalls - Array of tool calls from AI
 * @param allowedMethods - List of methods AI is allowed to call
 * @param signalBus - Optional signal bus for emitting execution events
 * @returns Array of tool call results
 */
export async function executeToolCalls(
  instance: ToolCallTarget,
  toolCalls: ToolCall[],
  allowedMethods: string[],
  signalBus?: SignalBus,
): Promise<ToolCallResult[]> {
  const results: ToolCallResult[] = [];

  for (const toolCall of toolCalls) {
    const result = await executeToolCall(
      instance,
      toolCall,
      allowedMethods,
      signalBus,
    );
    results.push(result);

    // Stop on first error if needed
    if (!result.success) {
      logger.warn(`Tool call failed for ${result.methodName}: ${result.error}`);
      // Continue executing other tools (don't break)
    }
  }

  return results;
}

/**
 * Formats tool call results into messages for AI
 *
 * @param results - Tool call execution results
 * @returns Array of tool response messages
 */
export function formatToolResults(
  results: ToolCallResult[],
): Array<{ role: 'tool'; tool_call_id: string; content: string }> {
  return results.map((result) => ({
    role: 'tool' as const,
    tool_call_id: result.id,
    content: result.success
      ? JSON.stringify(result.result)
      : `Error: ${result.error}`,
  }));
}
