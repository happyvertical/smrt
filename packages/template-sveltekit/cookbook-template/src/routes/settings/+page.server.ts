import type { AssistantApprovalView } from '@happyvertical/smrt-chat/assistant-turn';
import { redirect } from '@sveltejs/kit';
import { host } from '$lib/server/smrt';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) redirect(303, '/setup');
  const response = await host.prebuilt(event);
  if (!response.ok) throw new Error('Settings unavailable');
  const approvals = await host.assistant.GET({
    ...event,
    params: { ...event.params, path: 'approvals' },
  });
  if (!approvals.ok) throw new Error('Approvals unavailable');
  return {
    approvals: (await approvals.json()).approvals as AssistantApprovalView[],
    prebuilt: (await response.json()) as {
      enabled: boolean;
      revision: string | null;
    },
  };
};
