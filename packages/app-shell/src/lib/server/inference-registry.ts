// Startup registrations for the Inference settings section: the `inference`
// preference kind and the permissions its writes check. Imported by `smrt.ts`
// BEFORE the runtime exists, because the runtime's init seeds the owner role
// over the registered permission catalog, so the owner holds
// `inference.customize` from the next start. Registration describes a
// permission; it never grants one (the owner check in `owner.ts` still gates
// every settings route).
import {
  INFERENCE_PERMISSION_DEFINITIONS,
  inferencePreferenceKind,
} from '@happyvertical/smrt-inference/server';
import { registerPreferenceKind } from '@happyvertical/smrt-preferences';
import { registerPermissionDefinitions } from '@happyvertical/smrt-users';

registerPreferenceKind(inferencePreferenceKind, { replace: true });
registerPermissionDefinitions([...INFERENCE_PERMISSION_DEFINITIONS]);
