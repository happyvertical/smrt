import { createInferenceSettingsPage } from '@happyvertical/smrt-template-sveltekit/host/settings';
import { inferenceSettingsController } from '$lib/server/settings';
export const { load, actions } = createInferenceSettingsPage(inferenceSettingsController());
