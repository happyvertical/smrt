import { mountMcpProtectedResourceMetadataRoute } from '@happyvertical/smrt-app-mcp/sveltekit';

import { runtime } from '$lib/server/smrt';

/** RFC 9728 metadata at exactly the URL hosted bearer challenges advertise (404 locally). */
export const GET = mountMcpProtectedResourceMetadataRoute({ runtime });
