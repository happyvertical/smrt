import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
it('retains one successful auth instance and retries failed construction',()=>{const source=readFileSync(join(process.cwd(),'mcp-apps-template/src/lib/server/mcp-hosted.ts'),'utf8').replace(/^import .*;\n/gm,'');const js=ts.transpile(source.replace('export function','function'),{target:ts.ScriptTarget.ES2022});const factory=vi.fn().mockImplementationOnce(()=>{throw new Error('retry');}).mockImplementation(()=>({metadataResponse(){}}));const auth=runInNewContext(js+'\nhostedMcpAuth',{createMcpResourceAuth:factory,applicationRuntime:{profile:'self-hosted'},resolveHostedMcpPrincipal:()=>null,process:{env:{SMRT_MCP_RESOURCE:'https://local.invalid/api/mcp',SMRT_MCP_ISSUER:'https://local.invalid',SMRT_MCP_JWKS_URI:'https://local.invalid/jwks',SMRT_MCP_SCOPES:'items.read'}}});expect(()=>auth()).toThrow('retry');const first=auth();expect(auth()).toBe(first);expect(factory).toHaveBeenCalledTimes(2);});
