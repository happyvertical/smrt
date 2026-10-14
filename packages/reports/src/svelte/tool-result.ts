import type { Component } from 'svelte';
import RuntimeReportToolResult from './RuntimeReportToolResult.svelte';
import { validReportProposal } from './result.js';
import type { RuntimeReportProposal } from './types.js';

export interface ToolResultMessage {
  toolCallData?: unknown;
}

export function runtimeReportProposalFromMessage(
  message: ToolResultMessage,
): RuntimeReportProposal | null {
  const data = message.toolCallData;
  if (!data || typeof data !== 'object') return null;
  const value = data as {
    name?: unknown;
    tool?: unknown;
    toolName?: unknown;
    result?: unknown;
  };
  const toolName = value.name ?? value.tool ?? value.toolName;
  return toolName === 'reports.runtime.define' &&
    validReportProposal(value.result)
    ? value.result
    : null;
}

/** Host selector for AssistantDock's generic `toolResultComponent` seam. */
export function runtimeReportToolResultComponent(
  message: ToolResultMessage,
): Component<{ message: ToolResultMessage }> | undefined {
  return runtimeReportProposalFromMessage(message)
    ? RuntimeReportToolResult
    : undefined;
}
