import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { build } from 'vite';
const result = await build({ configFile: false, logLevel: 'error', build: { write: false, minify: true, lib: { entry: new URL('reference.ts', import.meta.url).pathname, name: 'Reference', formats: ['iife'] } } });
const script = (Array.isArray(result) ? result[0] : result).output.find((item) => item.type === 'chunk').code;
const hash = createHash('sha256').update(script).digest('base64');
const html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Synthetic opportunities</title></head><body><script>${script}</script></body></html>`;
const bytes = Buffer.byteLength(html);
if (bytes > 100 * 1024) throw new Error(`Reference HTML exceeds 100 KiB: ${bytes}`);
console.log(`Synthetic MCP App raw HTML: ${bytes} bytes`);
const host = `<!doctype html><html lang="en"><head><title>Synthetic host</title></head><body><script>
window.calls = []; window.closed = 0;
window.mount = (capabilities = {serverTools:{},openLinks:{}}) => {
 const frame = document.createElement('iframe'); frame.title = 'Opportunity app'; frame.sandbox = 'allow-scripts'; frame.src = '/view'; document.body.append(frame); window.view = frame;
 window.activeCaps = capabilities; return frame;
};
addEventListener('message', e => {
 if (e.source !== window.view?.contentWindow) return;
 const m = e.data; window.calls.push(m);
 const reply = result => e.source.postMessage({jsonrpc:'2.0', id:m.id, result}, '*');
 if(m.method === 'ui/initialize') reply({protocolVersion:'2026-01-26',hostInfo:{name:'synthetic',version:'1'},hostCapabilities:window.activeCaps,hostContext:{}});
 if(m.method === 'ui/notifications/initialized') {
   e.source.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-input',params:{arguments:{}}}, '*');
   e.source.postMessage({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{content:[{type:'text',text:'Synthetic opportunity summary'}],structuredContent:{opportunities:[{id:'synthetic-1',title:'Synthetic analyst role'}]}}}, '*');
 }
 if(m.method === 'tools/call' && m.params.name !== 'pending') {
  if(!window.activeCaps.serverTools) e.source.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Forbidden'}},'*');
  else reply(m.params.name==='opportunity_list' ? {content:[{type:'text',text:'Synthetic opportunity summary'}],structuredContent:{opportunities:[{id:'synthetic-1',title:'Synthetic analyst role'}]}} : {content:[{type:'text',text:'Synthetic role details. Prepare in the application; a human must review.'}],structuredContent:{id:'synthetic-1'}});
 }
 if(m.method === 'ui/open-link') reply({});
});
window.mount(new URLSearchParams(location.search).has('headless') ? {} : undefined);
</script></body></html>`;
createServer((req, res) => {
  if (req.url === '/view') {
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'sha256-${hash}'; connect-src 'none'; img-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`);
    res.setHeader('Content-Type', 'text/html'); res.end(html);
  } else if(req.url === '/metrics') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({bytes})); }
  else { res.setHeader('Content-Type', 'text/html'); res.end(host); }
}).listen(47862, '127.0.0.1');
