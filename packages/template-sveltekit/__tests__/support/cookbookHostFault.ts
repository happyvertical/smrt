import type {
  WorkflowCheckContext,
  WorkflowStepCheck,
} from '@happyvertical/smrt-workflows';

/**
 * Workflow checkpoint fault injection shared by the `cookbookHost.part*`
 * files. Every file registers the same `vi.mock` for
 * `@happyvertical/smrt-workflows`, which delegates here. This module imports
 * nothing but types: the mock factory loads it while that package is being
 * resolved, so a runtime import of it would be circular.
 */
export const checkpointFault = {
  errors: [] as string[],
  /** Runs after a step's check returned, before the driver saves it. */
  afterCheck: undefined as
    | undefined
    | ((
        result: WorkflowStepCheck,
        context: WorkflowCheckContext,
      ) => Promise<void>),
};

export function wrapWorkflows<
  T extends typeof import('@happyvertical/smrt-workflows'),
>(original: T): T {
  return {
    ...original,
    createWorkflowRunJobs: (
      options: Parameters<typeof original.createWorkflowRunJobs>[0],
    ) =>
      original.createWorkflowRunJobs({
        ...options,
        definition: {
          ...options.definition,
          steps: options.definition.steps.map((step) => ({
            ...step,
            execute: step.execute
              ? async (
                  ...args: Parameters<NonNullable<typeof step.execute>>
                ) => {
                  try {
                    return await step.execute!(...args);
                  } catch (error) {
                    checkpointFault.errors.push(String(error));
                    throw error;
                  }
                }
              : undefined,
            check: step.check
              ? async (...args: Parameters<NonNullable<typeof step.check>>) => {
                  try {
                    const result = await step.check!(...args);
                    await checkpointFault.afterCheck?.(result, args[1]);
                    return result;
                  } catch (error) {
                    checkpointFault.errors.push(String(error));
                    throw error;
                  }
                }
              : undefined,
          })),
        },
      }),
  };
}
