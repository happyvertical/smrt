// The process-wide pieces the routes share: a short-lived cache of what the
// local CLIs report (a status check starts a process, so the dock's status
// call must not start one every time), the one sign-in manager, and the
// owner's assistant settings over the shell's preference store.

import { createAgentCliService } from '@happyvertical/smrt-inference/server';
import { createPreferenceStore } from '@happyvertical/smrt-preferences';
import { getShellDb } from '../host.ts';
import { type Principal, runAs } from '../owner.ts';
import {
  ASSISTANT_CUSTOMIZE_PERMISSION,
  ASSISTANT_PERSONALIZE_PERMISSION,
  type AssistantPreferenceStore,
  createAssistantSettings,
} from './settings.ts';

const service = createAgentCliService();
export const {
  configureAgentCli,
  invalidateCliStatus,
  agentLogin,
  cliStatus,
  allCliStatus,
  agentCliDeps,
} = service;

/** The owner's engine and onboarding settings (preferences kind `assistant`). */
export function assistantSettings() {
  return createAssistantSettings(
    async () =>
      createPreferenceStore({
        db: await getShellDb(),
      }) as unknown as AssistantPreferenceStore,
  );
}

/**
 * Run `fn` as the verified owner with the two assistant-setting rights. The
 * caller has already checked the owner against shell.db (`ownerOf`); these
 * rights only open the non-secret `assistant` preference, so an install whose
 * owner role predates them still works (the role is reseeded on a later start).
 */
export function asSettingsOwner<T>(
  owner: Principal,
  fn: () => Promise<T>,
): Promise<T> {
  return runAs(
    {
      ...owner,
      scopes: [
        ...(owner.scopes ?? []),
        ASSISTANT_CUSTOMIZE_PERMISSION,
        ASSISTANT_PERSONALIZE_PERMISSION,
      ],
    },
    fn,
  );
}
