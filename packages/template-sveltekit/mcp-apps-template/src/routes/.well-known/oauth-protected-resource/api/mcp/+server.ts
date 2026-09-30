import { hostedMcpAuth } from '$lib/server/mcp-hosted';

/** Serve exactly the RFC 9728 metadata URL advertised by hosted bearer challenges. */
export function GET() {
  const auth = hostedMcpAuth();
  return auth?.metadataResponse() ?? new Response(null, { status: 404 });
}
