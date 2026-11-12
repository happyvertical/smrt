/** Browser half of the cookbook host. No SvelteKit globals or server imports. */
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
  const refresh = async <T>(work: Promise<T>): Promise<T> => {
    const result = await work;
    await options.onchange?.();
    return result;
  };
  return {
    component: OnboardingAssistant,
    transport: {
      ...transport,
      sendMessage: (input) => refresh(transport.sendMessage(input)),
      ...(transport.resumeTurn
        ? { resumeTurn: (input) => refresh(transport.resumeTurn!(input)) }
        : {}),
      ...(transport.decideApproval
        ? {
            decideApproval: (id, approve) =>
              refresh(transport.decideApproval!(id, approve)),
          }
        : {}),
    },
    registry: createDataSurfaceRegistry(),
    introduction: options.introduction,
    ...(options.label ? { label: options.label } : {}),
  };
}
