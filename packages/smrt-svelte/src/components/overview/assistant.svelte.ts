/**
 * The overview assistant in the browser (#3727 phase 4): the structured
 * operations an in-page assistant (the AssistantDock) applies to a mounted
 * overview, with a single-step Undo.
 *
 * A batch is planned with {@link planOverviewOperations} against the
 * controller's definition and current override, so it is atomic (one invalid
 * operation rejects the batch and nothing changes) and can only produce an
 * override the save endpoint accepts. A valid batch lands through
 * `controller.restore`, so the grid updates live and the host's `onchange`
 * persists it like any other edit. The override before the batch is kept for
 * Undo; Undo restores it exactly, and refuses once the overview changed in
 * between (it would discard that edit).
 *
 * The browser tools (`overview_describe`, `overview_apply`, `overview_undo`)
 * register on the page's WebMCP registry through `useWebMcpTool`, the same
 * path every bespoke page tool takes, so the dock offers and runs them like
 * any other page tool (a `write` waits for the person's Allow unless the host
 * policy says otherwise). The browser session is the principal: the
 * controller only holds this viewer's override, and `canCustomize` gates every
 * apply and undo.
 */

import type { Toaster } from '@happyvertical/smrt-ui/feedback';
import type { WebMcpToolSpec } from '../../web/webmcp.svelte.js';
import { useWebMcpTool } from '../../web/webmcp.svelte.js';
import type { OverviewController } from './controller.svelte.js';
import {
  describeOverview,
  OVERVIEW_MAX_OPERATIONS,
  OVERVIEW_OPERATION_SCHEMA,
  type OverviewDescription,
  type OverviewOperationIssue,
  type OverviewOperationKind,
  type OverviewOperationResult,
  planOverviewOperations,
} from './operations.js';
import type { OverviewOverride } from './types.js';

/** One applied batch, kept for Undo. */
export interface OverviewAssistantBatch {
  /** Opaque id; `undo(id)` only undoes this batch. */
  id: string;
  results: OverviewOperationResult[];
  /** How many operations of each kind the batch applied. */
  counts: Partial<Record<OverviewOperationKind, number>>;
  /** The override before the batch (what Undo restores). */
  before: OverviewOverride | null;
  /** The override the batch produced. */
  after: OverviewOverride | null;
}

export type OverviewAssistantApplyResult =
  | {
      ok: true;
      /** `null` when the batch changed nothing (no Undo is offered). */
      batchId: string | null;
      results: OverviewOperationResult[];
    }
  | {
      ok: false;
      reason: 'not_allowed' | 'invalid';
      issues: OverviewOperationIssue[];
    };

export type OverviewAssistantUndoResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'not_allowed' | 'nothing_to_undo' | 'changed_since';
    };

export interface OverviewAssistantOptions {
  /**
   * Tool name prefix (default `overview`): tools are `<prefix>_describe`,
   * `<prefix>_apply` and `<prefix>_undo`. Give each overview on one page its
   * own prefix.
   */
  toolPrefix?: string;
  /** Turns widget titles and labels that are i18n keys into text. */
  translate?: (key: string) => string;
  /**
   * Also show each applied batch as a toast with an Undo action (the host
   * mounts a smrt-ui `ToastViewport` for it). `OverviewAssistantUndo` is the
   * inline alternative.
   */
  toaster?: Toaster;
  /** Toast and inline message text; receives the batch. */
  message?: (batch: OverviewAssistantBatch) => string;
  /** Undo button label (default `Undo`). */
  undoLabel?: string;
  /** Called after a batch applies. */
  onapply?: (batch: OverviewAssistantBatch) => void;
  /** Batch cap (default 20). */
  maxOperations?: number;
}

const TOOL_PREFIX = /^[a-z][a-z0-9_]{0,40}$/;
let batchSeq = 0;

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function defaultMessage(batch: OverviewAssistantBatch): string {
  void batch;
  return 'The assistant updated this overview.';
}

export class OverviewAssistant {
  readonly controller: OverviewController;
  readonly #options: OverviewAssistantOptions;
  readonly #prefix: string;
  #last = $state.raw<OverviewAssistantBatch | null>(null);
  #toastId: string | null = null;

  constructor(
    controller: OverviewController,
    options: OverviewAssistantOptions = {},
  ) {
    const prefix = options.toolPrefix ?? 'overview';
    if (!TOOL_PREFIX.test(prefix)) {
      throw new Error(
        `createOverviewAssistant: invalid toolPrefix "${prefix}"`,
      );
    }
    this.controller = controller;
    this.#options = options;
    this.#prefix = prefix;
  }

  /** The last applied batch while it can still be undone. */
  get lastBatch(): OverviewAssistantBatch | null {
    return this.#last;
  }

  /** Text for the Undo affordance. */
  message(batch: OverviewAssistantBatch): string {
    return (this.#options.message ?? defaultMessage)(batch);
  }

  get undoLabel(): string {
    return this.#options.undoLabel ?? 'Undo';
  }

  /** What the overview allows and shows now. */
  describe(): OverviewDescription {
    return describeOverview({
      definition: this.controller.definition,
      registry: this.controller.registry,
      override: this.controller.committedOverride,
      canCustomize: this.controller.canCustomize,
      translate: this.#options.translate,
      maxOperations: this.#options.maxOperations,
    });
  }

  /** Apply a batch atomically; the grid updates through the controller. */
  apply(operations: unknown): OverviewAssistantApplyResult {
    const controller = this.controller;
    if (!controller.canCustomize) {
      return { ok: false, reason: 'not_allowed', issues: [] };
    }
    // What the controller last committed, even if the host has not fed it
    // back yet.
    const before = controller.committedOverride;
    const plan = planOverviewOperations({
      definition: controller.definition,
      registry: controller.registry,
      override: before,
      operations,
      maxOperations: this.#options.maxOperations,
    });
    if (!plan.ok) return { ok: false, reason: 'invalid', issues: plan.issues };
    if (plan.unchanged) {
      return { ok: true, batchId: null, results: plan.results };
    }
    const restored = controller.restore(plan.override);
    if (!restored.ok) {
      if (restored.reason === 'unchanged') {
        return { ok: true, batchId: null, results: plan.results };
      }
      return { ok: false, reason: 'not_allowed', issues: [] };
    }
    const counts: OverviewAssistantBatch['counts'] = {};
    for (const result of plan.results) {
      counts[result.op] = (counts[result.op] ?? 0) + 1;
    }
    batchSeq += 1;
    const batch: OverviewAssistantBatch = {
      id: `b${batchSeq}`,
      results: plan.results,
      counts,
      before,
      after: plan.override,
    };
    this.#last = batch;
    this.#showToast(batch);
    this.#options.onapply?.(batch);
    return { ok: true, batchId: batch.id, results: plan.results };
  }

  /**
   * Restore the override from before the last batch. Refused when the
   * overview changed after that batch (the person edited it), or when `id`
   * names another batch.
   */
  undo(id?: string): OverviewAssistantUndoResult {
    const batch = this.#last;
    if (!batch || (id !== undefined && id !== batch.id)) {
      return { ok: false, reason: 'nothing_to_undo' };
    }
    const controller = this.controller;
    if (!controller.canCustomize) return { ok: false, reason: 'not_allowed' };
    if (!sameJson(controller.committedOverride, batch.after)) {
      this.dismiss();
      return { ok: false, reason: 'changed_since' };
    }
    const restored = controller.restore(batch.before);
    if (!restored.ok && restored.reason !== 'unchanged') {
      return { ok: false, reason: 'not_allowed' };
    }
    this.dismiss();
    return { ok: true };
  }

  /** Forget the last batch (hides the Undo affordance). */
  dismiss(): void {
    this.#last = null;
    if (this.#toastId) this.#options.toaster?.dismiss(this.#toastId);
    this.#toastId = null;
  }

  #showToast(batch: OverviewAssistantBatch): void {
    const toaster = this.#options.toaster;
    if (!toaster) return;
    if (this.#toastId) toaster.dismiss(this.#toastId);
    this.#toastId = toaster.show({
      message: this.message(batch),
      variant: 'info',
      duration: 10_000,
      action: { label: this.undoLabel, run: () => void this.undo(batch.id) },
    });
  }

  /** The browser tool specs (register with `useOverviewAssistantTools`). */
  tools(): WebMcpToolSpec[] {
    const p = this.#prefix;
    const json = (value: unknown) => JSON.stringify(value);
    return [
      {
        name: `${p}_describe`,
        description:
          'Describe this overview page: the widget types it allows (with their option fields, allowed values and span range) and the widgets it shows now, in order. Call before changing it; never invent types, option keys or models.',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: () => json(this.describe()),
      },
      {
        name: `${p}_apply`,
        description:
          'Change this overview with a batch of structured operations (add, configure, move, resize, remove). The batch is all-or-nothing: if any operation is invalid nothing changes and the issues are returned to fix. The person can undo the batch.',
        inputSchema: {
          type: 'object',
          required: ['operations'],
          additionalProperties: false,
          properties: {
            operations: {
              type: 'array',
              minItems: 1,
              maxItems: this.#options.maxOperations ?? OVERVIEW_MAX_OPERATIONS,
              items: OVERVIEW_OPERATION_SCHEMA,
            },
          },
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        execute: (args) => {
          const result = this.apply(args.operations);
          if (result.ok) {
            return json({
              ok: true,
              changed: result.batchId !== null,
              undoToken: result.batchId,
              applied: result.results,
              widgets: this.describe().widgets,
            });
          }
          return json({
            ok: false,
            error:
              result.reason === 'not_allowed'
                ? 'You may not change this overview.'
                : 'The batch was rejected and nothing changed. Fix the listed operations and call again.',
            issues: result.issues,
          });
        },
      },
      {
        name: `${p}_undo`,
        description:
          'Undo the last batch you applied to this overview (pass its undoToken). Single step; refused if the overview changed since.',
        inputSchema: {
          type: 'object',
          required: ['undoToken'],
          additionalProperties: false,
          properties: { undoToken: { type: 'string' } },
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        execute: (args) => {
          const token =
            typeof args.undoToken === 'string' ? args.undoToken : '';
          const result = this.undo(token);
          return json(
            result.ok
              ? { ok: true, widgets: this.describe().widgets }
              : { ok: false, error: result.reason },
          );
        },
      },
    ];
  }
}

/** Create the browser overview assistant for a controller. */
export function createOverviewAssistant(
  controller: OverviewController,
  options?: OverviewAssistantOptions,
): OverviewAssistant {
  return new OverviewAssistant(controller, options);
}

/**
 * Register the assistant's browser tools on the page's WebMCP registry for
 * the calling component's lifetime. Call during component initialization.
 * `apply` and `undo` are `write` tools: the nearest Provider's
 * `webmcp.effects` must allow `write`, or only `describe` is exposed.
 */
export function useOverviewAssistantTools(
  assistant: OverviewAssistant,
  options: { effects?: readonly ('read' | 'write' | 'destructive')[] } = {},
): void {
  for (const spec of assistant.tools()) {
    useWebMcpTool(() => spec, {
      ...(options.effects ? { effects: options.effects } : {}),
    });
  }
}
