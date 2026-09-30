import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  createMcpAppServer,
  prepareMcpAppResource,
} from "@happyvertical/smrt-app-mcp";
import { build } from "vite";

const result = await build({
  configFile: false,
  logLevel: "error",
  build: {
    write: false,
    minify: true,
    lib: {
      entry: new URL("reference.ts", import.meta.url).pathname,
      name: "Reference",
      formats: ["iife"],
    },
  },
});
const script = (Array.isArray(result) ? result[0] : result).output.find(
  (item) => item.type === "chunk",
).code;
const styles = `*{box-sizing:border-box}html{font:100%/1.5 system-ui,sans-serif}body{margin:0;padding:1rem;max-width:50rem}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:.5rem 0}main{display:grid;gap:.5rem;margin-block:1rem}button,a{font:inherit;min-height:44px;padding:.5rem .75rem}button{white-space:normal;text-align:start;cursor:pointer}a{display:inline-flex;align-items:center}code{display:block;overflow-wrap:anywhere;white-space:normal;font-size:.875rem}button:focus-visible,a:focus-visible{outline:3px solid currentColor;outline-offset:2px}`;
const html = `<!doctype html><html lang="en"><head><title>Synthetic opportunities</title><style>${styles}</style></head><body><script>${script}</script></body></html>`;
const definition = {
  uri: "ui://synthetic-opportunities/v1/view.html",
  version: "v1",
  name: "Synthetic opportunity viewer",
  html,
};
const prepared = prepareMcpAppResource(definition);
const digest = (value) => createHash("sha256").update(value).digest("base64");
const csp = `default-src 'none'; script-src 'sha256-${digest(script)}'; style-src 'sha256-${digest(styles)}'; connect-src 'none'; img-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`;
const principal = {
  id: "synthetic-reader",
  tenantId: "synthetic-tenant",
  scopes: ["opportunities:read"],
};
let revoked = false;
const listResult = {
  content: [{ type: "text", text: "Synthetic opportunity summary" }],
  structuredContent: {
    opportunities: [
      { id: "synthetic-1", title: "Synthetic analyst role" },
      { id: "synthetic-2", title: "Synthetic designer role" },
    ],
  },
};
const app = createMcpAppServer({
  smrtOptions: () => ({}),
  serverInfo: { name: "synthetic-reference", version: "1" },
  allowedClassNames: [],
  resources: [definition],
  resourcePolicy: ({ principal: actor }) =>
    !revoked &&
    actor?.id === principal.id &&
    actor.tenantId === principal.tenantId,
  toolPolicy: ({ principal: actor }) =>
    !revoked &&
    actor?.id === principal.id &&
    actor.tenantId === principal.tenantId &&
    actor.scopes?.includes("opportunities:read") === true,
  workflowTools: [
    {
      name: "opportunity_list",
      description: "Synthetic opportunities",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object" },
      effect: "read",
      idempotent: true,
      openWorld: false,
      ui: { resourceUri: definition.uri },
      execute: () => listResult,
    },
    {
      name: "opportunity_detail",
      description: "Synthetic opportunity details",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", enum: ["synthetic-1", "synthetic-2"] },
        },
        required: ["id"],
        additionalProperties: false,
      },
      outputSchema: { type: "object" },
      effect: "read",
      idempotent: true,
      openWorld: false,
      ui: { resourceUri: definition.uri },
      execute: ({ arguments: args }) => ({
        content: [
          {
            type: "text",
            text: `Synthetic role details: ${args.id}. Prepare in the application; a human must review.`,
          },
        ],
        structuredContent: { id: args.id },
      }),
    },
  ],
});
console.log(
  `Synthetic MCP App raw HTML: ${prepared.descriptor._meta["com.happyvertical.smrt/resource"].bytes} bytes`,
);
const host = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic host</title><style>html,body{margin:0;width:100%;min-height:100%;font:100% system-ui}iframe{display:block;border:0;width:100%;height:100vh;min-height:24rem}</style></head><body><script>
window.calls = []; window.deferred = [];
window.mount = (capabilities = {serverTools:{},openLinks:{}}) => {
 const frame = document.createElement('iframe'); frame.title = 'Opportunity app'; frame.sandbox = 'allow-scripts'; frame.src = '/view'; document.body.append(frame); window.view = frame;
 window.activeCaps = capabilities; return frame;
};
addEventListener('message', async e => {
 if (e.source !== window.view?.contentWindow) return;
 const m = e.data; window.calls.push(m);
 const reply = result => e.source.postMessage({jsonrpc:'2.0', id:m.id, result}, '*');
 if(m.method === 'ui/initialize') reply({protocolVersion:'2026-01-26',hostInfo:{name:'synthetic',version:'1'},hostCapabilities:window.activeCaps,hostContext:{}});
 if(m.method === 'ui/notifications/initialized') {
   e.source.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-input',params:{arguments:{}}}, '*');
   const response = await fetch('/tools',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'opportunity_list',arguments:{}})});
   if(response.ok) e.source.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:await response.json()}, '*');
 }
 if(m.method === 'tools/call' && m.params.name !== 'pending') {
  if(!window.activeCaps.serverTools) e.source.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Forbidden'}},'*');
  else {
   const response = await fetch('/tools',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(m.params)});
   if(!response.ok) e.source.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Forbidden'}},'*');
   else {
    const result = await response.json();
    if(window.deferTools) window.deferred.push({id:m.id,result}); else reply(result);
   }
  }
 }
 if(m.method === 'ui/open-link') reply({});
});
window.mount(new URLSearchParams(location.search).has('headless') ? {} : undefined);
</script></body></html>`;
createServer(async (req, res) => {
  try {
    if (req.url === "/view") {
      const resource = await app.readResource({
        uri: definition.uri,
        principal,
      });
      res.setHeader("Content-Security-Policy", csp);
      res.setHeader("Content-Type", `${resource.mimeType};charset=utf-8`);
      res.end(resource.text);
    } else if (req.url === "/metrics") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          bytes:
            prepared.descriptor._meta["com.happyvertical.smrt/resource"].bytes,
          descriptor: (await app.listResources({ principal }))[0],
        }),
      );
    } else if (req.url === "/tools" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 16384) throw new Error("Oversized fixture request");
      }
      const input = JSON.parse(body);
      // The synthetic host's server session owns principal. The view can only supply tool arguments.
      const result = await app.callTool({
        name: input.name,
        arguments: input.arguments,
        principal,
      });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    } else if (req.url === "/policy" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      revoked = JSON.parse(body).revoked === true;
      res.end("{}");
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(host);
    }
  } catch {
    res.statusCode = 403;
    res.end("Forbidden");
  }
}).listen(47862, "127.0.0.1");
