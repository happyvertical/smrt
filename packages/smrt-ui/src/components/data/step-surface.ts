/**
 * A multi-step flow (a wizard, a setup checklist) as a mounted data surface,
 * so an agent can see where a person is and move the flow forward.
 *
 * The published state lists the steps (`state.steps`: id, label, status) and
 * the current one. Three controls move between them:
 *
 * - `next` — advance from the current step. A step whose forward button only
 *   checks input and shows the next step runs the page's `next` handler, the
 *   same function the button calls. A step whose forward button SAVES or
 *   CREATES something (`nextWrites`) is never pressed by an agent: `next`
 *   reveals and highlights that button instead, and publishes
 *   `awaitingPerson: true` until the page moves on. People apply writes.
 * - `back` — return to the previous step (never a write).
 * - `go-to` — jump to a step the page marks `available` (payload
 *   `{ target }`: a step id or label).
 *
 * A handler that returns `false` (validation failed) refuses the command, so
 * the agent sees the step did not change and can read the form's errors.
 */

import type {
  DataSurfaceDescriptor,
  DataSurfaceJsonValue,
  DataSurfaceRegistry,
  DataSurfaceSubject,
  DataSurfaceVisibleCommand,
} from '@happyvertical/smrt-types';
import { linkTargetFromPayload } from './link-surface.js';

export interface StepSurfaceStep {
  id: string;
  /** Plain label a person sees in the progress row. */
  label: string;
  description?: string;
  /** The step's work is done. */
  complete?: boolean;
  /** `go-to` may jump here (default: complete steps and the current one). */
  available?: boolean;
}

type StepHandler = () => boolean | undefined | Promise<boolean | undefined>;

export interface StepSurfaceOptions {
  registry: DataSurfaceRegistry;
  surfaceId: string;
  subject?: DataSurfaceSubject;
  label: string;
  description: string;
  steps: readonly StepSurfaceStep[];
  /** Id of the step on screen. */
  current: string;
  /**
   * The forward action of the current step, when it does not write — the
   * same function its Continue button calls. Return `false` to refuse.
   */
  next?: StepHandler;
  /**
   * The current step's forward button saves or creates something. An agent's
   * `next` then only reveals the button (see {@link StepSurfaceOptions.showNext}).
   */
  nextWrites?: boolean;
  /** Reveal and highlight the current step's forward button for the person. */
  showNext?: () => void;
  /** Return to the previous step. Return `false` to refuse. */
  back?: StepHandler;
  /** Jump to a step. Return `false` to refuse. */
  goTo?: (stepId: string) => boolean | undefined | Promise<boolean | undefined>;
  /** Extra JSON state published alongside the steps. */
  state?: Record<string, DataSurfaceJsonValue>;
}

export type StepSurfaceUpdate = Partial<
  Pick<
    StepSurfaceOptions,
    | 'steps'
    | 'current'
    | 'next'
    | 'nextWrites'
    | 'showNext'
    | 'back'
    | 'goTo'
    | 'state'
  >
>;

export interface StepSurfaceHandle {
  update(next: StepSurfaceUpdate): void;
  destroy(): void;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function stepAvailable(step: StepSurfaceStep, current: string): boolean {
  return step.available ?? (step.complete === true || step.id === current);
}

/** Resolve a `go-to` payload to a step id (id, exact label, unique prefix). */
export function resolveStepTarget(
  payload: DataSurfaceJsonValue | undefined,
  steps: readonly StepSurfaceStep[],
): string | null {
  const target = linkTargetFromPayload(payload);
  if (!target) return null;
  const wanted = normalize(target);
  const byId = steps.find((step) => normalize(step.id) === wanted);
  if (byId) return byId.id;
  const byLabel = steps.filter((step) => normalize(step.label) === wanted);
  if (byLabel.length === 1) return byLabel[0].id;
  if (byLabel.length > 1) return null;
  const byPrefix = steps.filter((step) =>
    normalize(step.label).startsWith(wanted),
  );
  return byPrefix.length === 1 ? byPrefix[0].id : null;
}

/** The descriptor {@link registerStepSurface} mounts. */
export function stepSurfaceDescriptor(
  options: Pick<
    StepSurfaceOptions,
    'surfaceId' | 'subject' | 'label' | 'description'
  >,
): DataSurfaceDescriptor {
  const columns: DataSurfaceDescriptor['columns'] = [
    { id: 'id', label: 'ID', capabilities: ['read'], role: 'row-key' },
    { id: 'label', label: 'Step', capabilities: ['read'] },
    { id: 'status', label: 'Status', capabilities: ['read'], role: 'status' },
    { id: 'description', label: 'About', capabilities: ['read'] },
  ];
  return {
    version: 1,
    identity: {
      kind: 'custom',
      surfaceId: options.surfaceId,
      ...(options.subject ? { subject: options.subject } : {}),
    },
    schemaVersion: 1,
    label: options.label,
    description: options.description,
    rowKey: 'id',
    columns,
    query: {
      modes: ['rows'],
      projectableColumnIds: columns.map((column) => column.id),
      filterableColumnIds: [],
      sortableColumnIds: [],
    },
    controls: [
      {
        id: 'next',
        label: 'Next step',
        description:
          'Continue from the current step. When the step saves or creates something (state.nextWrites), this only shows the person the button to press.',
      },
      { id: 'back', label: 'Previous step' },
      {
        id: 'go-to',
        label: 'Go to step',
        description:
          'Jump to an available step. Payload: { target } — a step id or label.',
      },
    ],
    actions: [],
    limits: { maxQueryRows: 50, maxQueryBytes: 100_000, maxSelectionSize: 1 },
  };
}

/** Mount a multi-step flow on a data-surface registry. */
export function registerStepSurface(
  options: StepSurfaceOptions,
): StepSurfaceHandle {
  let current: StepSurfaceOptions = { ...options };
  let awaitingPerson = false;
  let revision = 1;

  const publishedState = () => {
    const index = current.steps.findIndex(
      (step) => step.id === current.current,
    );
    return {
      ...(current.state ?? {}),
      current: current.current,
      currentLabel: current.steps[index]?.label ?? null,
      stepNumber: index + 1,
      stepCount: current.steps.length,
      nextWrites: current.nextWrites === true,
      awaitingPerson,
      steps: current.steps.map((step) => ({
        id: step.id,
        label: step.label,
        ...(step.description ? { description: step.description } : {}),
        status:
          step.id === current.current
            ? 'current'
            : step.complete
              ? 'complete'
              : stepAvailable(step, current.current)
                ? 'available'
                : 'upcoming',
      })),
    };
  };
  let signature = JSON.stringify(publishedState());
  const publish = () => {
    const next = JSON.stringify(publishedState());
    if (next !== signature) {
      signature = next;
      revision += 1;
    }
  };

  const run = async (
    handler: (() => ReturnType<StepHandler>) | undefined,
  ): Promise<{ ok: false } | undefined> => {
    if (!handler) return { ok: false };
    const result = await handler();
    return result === false ? { ok: false } : undefined;
  };

  const dispose = options.registry.register({
    descriptor: stepSurfaceDescriptor(options),
    getSnapshot: () => ({ revision, state: publishedState(), selection: null }),
    execute: async (command: DataSurfaceVisibleCommand) => {
      switch (command.controlId) {
        case 'next': {
          if (current.nextWrites) {
            if (!current.showNext) return { ok: false };
            current.showNext();
            awaitingPerson = true;
            publish();
            return undefined;
          }
          return run(current.next);
        }
        case 'back':
          return run(current.back);
        case 'go-to': {
          const stepId = resolveStepTarget(command.payload, current.steps);
          const step = current.steps.find((item) => item.id === stepId);
          if (!step || !current.goTo) return { ok: false };
          if (!stepAvailable(step, current.current)) return { ok: false };
          const goTo = current.goTo;
          return run(() => goTo(step.id));
        }
        default:
          return { ok: false };
      }
    },
  });

  return {
    update(next) {
      const moved =
        next.current !== undefined && next.current !== current.current;
      current = { ...current, ...next };
      // The person pressed the button (or the flow moved another way).
      if (moved || next.nextWrites === false) awaitingPerson = false;
      publish();
    },
    destroy() {
      dispose();
    },
  };
}
