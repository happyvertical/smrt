// ONE policy for every tool surface (the /mcp route, the assistant's tool
// allow-list). The owner sees and calls everything in the merged catalog;
// anyone else sees nothing and every call is refused. Risky app tools are not
// refused here: the call is accepted and turned into an Approval (builder.ts).
//
// The assistant worker reuses these two functions as its allow-list:
//   toolsFor(principal)          the tools this principal may see (owner: all)
//   authorizeCall(principal, n)  the tool, or a PolicyError (401/403/404)
import type { McpAppPrincipal } from '@happyvertical/smrt-app-mcp';
import {
  type CatalogResponse,
  type CatalogTool,
  dispatchTool,
  listCatalog,
} from './catalog.ts';
import { isOwner, PolicyError, type Principal } from './owner.ts';

function asMcp(principal: Principal): McpAppPrincipal {
  return {
    id: principal.id,
    tenantId: principal.tenantId,
    kind: 'human',
    scopes: [...(principal.scopes ?? [])],
  };
}

/** The tools this principal may see. Empty unless the principal is the owner. */
export async function toolsFor(
  principal: Principal | null | undefined,
): Promise<CatalogTool[]> {
  if (!principal || !(await isOwner(principal))) return [];
  return listCatalog(asMcp(principal));
}

/**
 * Check a call before dispatch and return the catalog entry it resolves to.
 * Throws {@link PolicyError}: 401 without a principal, 403 for a non-owner,
 * 403 for a name that is not in the principal's catalog.
 */
export async function authorizeCall(
  principal: Principal | null | undefined,
  name: string,
): Promise<CatalogTool> {
  if (!principal?.id || !principal.tenantId)
    throw new PolicyError(401, 'sign in first');
  if (!(await isOwner(principal)))
    throw new PolicyError(403, 'only the owner can use these tools');
  const tool = (await listCatalog(asMcp(principal))).find(
    (t) => t.name === name,
  );
  if (!tool) throw new PolicyError(403, 'unknown tool');
  return tool;
}

/** Authorize and run one call: the assistant's and /mcp's single entry. */
export async function callTool(
  principal: Principal | null | undefined,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CatalogResponse> {
  const tool = await authorizeCall(principal, name);
  return dispatchTool(asMcp(principal as Principal) as never, tool, args);
}

export { asMcp as toMcpPrincipal };
