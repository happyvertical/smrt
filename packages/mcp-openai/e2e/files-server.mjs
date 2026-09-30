import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { build } from 'vite';
const result = await build({ configFile: false, logLevel: 'error', build: { write: false, minify: true, lib: { entry: new URL('files-reference.ts', import.meta.url).pathname, name: 'FilesReference', formats: ['es'] } } });
const script = (Array.isArray(result) ? result[0] : result).output.find(item => item.type === 'chunk').code;
const hash = createHash('sha256').update(script).digest('base64');
const html = `<!doctype html><html lang="en"><head><title>Synthetic files</title></head><body><script type="module">${script}</script></body></html>`;
if (Buffer.byteLength(html) > 102400) throw new Error('Reference exceeds 100 KiB');
const host = `<!doctype html><html lang="en"><head><title>Synthetic file host</title></head><body><iframe title="Files" sandbox="allow-scripts" src="/view"></iframe><script>
window.calls=[];window.revoked=false;window.revision=1;window.payload='synthetic';window.mime='text/plain';const frame=document.querySelector('iframe');
const mode=new URLSearchParams(location.search).get('mode');
window.notify=()=>frame.contentWindow.postMessage({jsonrpc:'2.0',method:'notifications/resources/updated',params:{uri:'host-resource://synthetic'}},'*');
addEventListener('message',e=>{
 if(e.source!==frame.contentWindow) return;
 const m=e.data;window.calls.push(m);const reply=result=>e.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');
 const deny=()=>e.source.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Synthetic denied'}},'*');
 if(m.method==='ui/initialize') reply({protocolVersion:'2026-01-26',hostInfo:{name:'synthetic-files',version:'1'},hostCapabilities:{serverTools:{},experimental:mode==='absent'?{}:mode==='unknown'?{'openai/resource':true}:{'openai/resource':{},'openai/files':{}}},hostContext:{}});
 if(m.method==='tools/call') { if(window.revoked||mode==='other-tenant'||mode==='other-owner') reply({isError:true,content:[]});else reply({content:[{type:'text',text:'Authorized import/open/download workflow'}],structuredContent:{path:'/synthetic/file.txt'}}); }
 if(m.method==='resources/read') {
  if(window.revoked) return deny();
  const answer={contents:[{uri:'host-resource://synthetic',mimeType:window.mime,text:window.payload,_meta:{'openai/resource':{writable:true,etag:'v'+window.revision}}}]};
  if(mode==='slow') setTimeout(()=>reply(answer),150);else reply(answer);
 }
 if(m.method==='openai/resources/write') {
  if(window.revoked||mode==='failure') return deny();
  if(m.params.ifMatch!=='v'+window.revision) reply({outcome:'conflict',etag:'v'+window.revision});
  else {window.payload=m.params.text;window.revision++;reply({outcome:'saved',etag:'v'+window.revision});}
 }
 if(['resources/subscribe','resources/unsubscribe','openai/files/open'].includes(m.method)) {if(window.revoked&&m.method!=='resources/unsubscribe')deny();else reply({});}
});</script></body></html>`;
createServer((req,res)=>{res.setHeader('Content-Type','text/html');if(req.url==='/view'){res.setHeader('Content-Security-Policy',`default-src 'none';script-src 'sha256-${hash}';connect-src 'none';img-src 'none';frame-src 'none';base-uri 'none';form-action 'none'`);res.end(html);}else res.end(host);}).listen(47867,'127.0.0.1');
