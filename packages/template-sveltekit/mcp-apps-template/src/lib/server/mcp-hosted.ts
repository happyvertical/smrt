import { createMcpResourceAuth } from '@happyvertical/smrt-app-mcp/auth';
import { applicationRuntime } from './application-runtime.js';
import { resolveHostedMcpPrincipal } from './mcp-hosted-principal.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Hosted MCP requires ${name}.`);
  return value;
}

export function hostedMcpAuth() {
  if (applicationRuntime.profile === 'local') return null;
  if (!resolveHostedMcpPrincipal)
    throw new Error('Hosted MCP requires an application-owned resolveHostedMcpPrincipal binding.');
  return createMcpResourceAuth({
    profile: applicationRuntime.profile,
    resource: required('SMRT_MCP_RESOURCE'),
    issuer: required('SMRT_MCP_ISSUER'),
    jwksUri: required('SMRT_MCP_JWKS_URI'),
    scopes: required('SMRT_MCP_SCOPES').split(/\s+/u),
    algorithms: ['RS256'],
    resolvePrincipal: resolveHostedMcpPrincipal,
  });
}
