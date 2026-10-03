import { createHostedMcpResourceAuth } from '@happyvertical/smrt-app-mcp/auth';
import { mountMcpProtectedResourceMetadataRoute } from '@happyvertical/smrt-app-mcp/sveltekit';

import { resolveHostedMcpPrincipal } from '$lib/server/mcp-hosted-principal';
import { runtime } from '$lib/server/smrt';

const { profile } = await runtime.resolvedRuntime();

/** RFC 9728 metadata at exactly the URL hosted bearer challenges advertise (404 locally). */
export const GET = mountMcpProtectedResourceMetadataRoute(
  createHostedMcpResourceAuth({
    profile,
    resolvePrincipal: resolveHostedMcpPrincipal,
  }),
);
