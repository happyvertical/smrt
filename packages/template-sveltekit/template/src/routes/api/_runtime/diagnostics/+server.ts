import { createRuntimeDiagnosticsHandler } from '@happyvertical/smrt-app-runtime/sveltekit';
import { RUNTIME_DIAGNOSTICS_WEBMCP_TOOL_NAME } from '@happyvertical/smrt-svelte/app/runtime-diagnostics';
import { webMcpToolDefinitions } from '@happyvertical/smrt-virt-web';

import { runtime } from '$lib/server/smrt';

/**
 * Authenticated, authorized (owner role or `runtime_diagnostics.read`) and
 * redacted runtime diagnostics. Schema/migration status and the worker
 * heartbeat stay `unknown` until the application installs real verifiers;
 * process liveness is never substituted for them.
 */
export const GET = createRuntimeDiagnosticsHandler({
  runtime,
  toolNames: () => [
    ...webMcpToolDefinitions.map((definition) => definition.name),
    RUNTIME_DIAGNOSTICS_WEBMCP_TOOL_NAME,
  ],
});
