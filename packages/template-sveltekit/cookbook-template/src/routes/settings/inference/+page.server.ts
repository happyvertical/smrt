import { createInferenceSettingsPage } from '@happyvertical/smrt-template-sveltekit/host/settings';
import { host } from '$lib/server/smrt';
export const { load, actions } = createInferenceSettingsPage(
  host.inferenceSettings,
);
