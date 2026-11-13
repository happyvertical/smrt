/** Browser half of the cookbook host. No SvelteKit globals or server imports. */
import {
  type AssistantApprovalView,
  reconcileAssistantApprovalView,
} from '@happyvertical/smrt-chat/assistant-turn';
import { createAssistantHttpTransport } from '@happyvertical/smrt-chat/svelte';
import type { CookbookAppProps } from '@happyvertical/smrt-svelte/cookbook';
import { OnboardingAssistant } from '@happyvertical/smrt-svelte/onboarding';
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';

/** One registry shared by CookbookApp's Provider, mounted screens and assistant. */
export function createCookbookAssistant(
  options: {
    endpoint?: string;
    label?: string;
    introduction?: NonNullable<CookbookAppProps['assistant']>['introduction'];
    onchange?: () => void | Promise<void>;
  } = {},
): NonNullable<CookbookAppProps['assistant']> {
  const transport = createAssistantHttpTransport({
    endpoint: options.endpoint ?? '/api/assistant',
    designRuns: true,
  });
  // Observe the existing authorized card polls; historical terminal rows are inert.
  // Retain terminal observations so overlapping/stale requests cannot re-arm them.
  const approvals = new Map<string, AssistantApprovalView>();
  const observeApprovals = async (
    rows: AssistantApprovalView[],
    notify = true,
  ) => {
    for (const row of rows) {
      const previous = approvals.get(row.id);
      const next = reconcileAssistantApprovalView(previous, row);
      approvals.set(row.id, next);
      if (
        previous &&
        previous.status !== 'succeeded' &&
        next.status === 'succeeded' &&
        notify
      )
        await options.onchange?.();
    }
  };
  const refresh = async <T>(work: Promise<T>): Promise<T> => {
    const result = await work;
    await options.onchange?.();
    return result;
  };
  return {
    component: OnboardingAssistant,
    toolPresentation: 'generic',
    transport: {
      ...transport,
      sendMessage: (input) => refresh(transport.sendMessage(input)),
      ...(transport.resumeTurn
        ? { resumeTurn: (input) => refresh(transport.resumeTurn!(input)) }
        : {}),
      ...(transport.listApprovals
        ? {
            listApprovals: async (threadId?: string) => {
              const rows = await transport.listApprovals!(threadId);
              await observeApprovals(rows);
              return rows;
            },
          }
        : {}),
      ...(transport.decideApproval
        ? {
            decideApproval: (id, approve) =>
              refresh(
                (async () => {
                  const next = await transport.decideApproval!(id, approve);
                  // The existing decision refresh covers immediate completion.
                  // An approved response still needs its later terminal poll.
                  await observeApprovals([next], false);
                  return next;
                })(),
              ),
          }
        : {}),
    },
    registry: createDataSurfaceRegistry(),
    introduction: options.introduction,
    ...(options.label ? { label: options.label } : {}),
  };
}
