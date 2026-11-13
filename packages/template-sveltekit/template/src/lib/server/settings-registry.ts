/**
 * Startup registrations for the inference and prompt settings sections:
 * the `inference` preference kind, and the permissions their writes check.
 * Imported by `./smrt` BEFORE the runtime exists, because the runtime's init
 * seeds the owner and admin roles over the registered permission catalog, so
 * the local owner gets `inference.customize` and `prompts.customize` on the
 * next start. Registration describes a permission; it never grants one.
 */

import {
  INFERENCE_PERMISSION_DEFINITIONS,
  inferencePreferenceKind,
} from '@happyvertical/smrt-inference/server';
import { registerPreferenceKind } from '@happyvertical/smrt-preferences';
import { registerPermissionDefinitions } from '@happyvertical/smrt-users';

/** Authorizes changing prompt text for the app and its tenants. */
export const PROMPTS_CUSTOMIZE_PERMISSION = 'prompts.customize';

registerPreferenceKind(inferencePreferenceKind, { replace: true });
registerPermissionDefinitions([
  ...INFERENCE_PERMISSION_DEFINITIONS,
  {
    slug: PROMPTS_CUSTOMIZE_PERMISSION,
    category: 'prompts',
    name: 'Customize Prompts',
    description: 'Change the prompt text this app and its tenants use',
  },
]);
