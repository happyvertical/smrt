import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { build } from 'vite';
const result = await build({ configFile: false, logLevel: 'error', build: { write: false, minify: true, lib: { entry: new URL('reference.ts', import.meta.url).pathname, name: 'NavigationReference', formats: ['iife'] } } });
const script = (Array.isArray(result) ? result[0] : result).output.find(item => item.type === 'chunk').code;
const hash = createHash('sha256').update(script).digest('base64');
const html = `<!doctype html><html lang="en"><head><title>Synthetic navigation</title></head><body><script>${script}</script></body></html>`;
if (Buffer.byteLength(html) > 102400) throw new Error('Reference exceeds 100 KiB');
const host = `<!doctype html><html lang="en"><head><title>Synthetic host</title></head><body><iframe title="Navigation" sandbox="allow-scripts" src="/view"></iframe><script>
window.calls=[]; window.portableContextReplacements=[]; let initialHeld=false; const frame=document.querySelector('iframe');
const mode=new URLSearchParams(location.search).get('mode');
window.send=(params)=>frame.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params},'*');
addEventListener('message', e=>{
 if(e.source!==frame.contentWindow) return;
 const m=e.data; window.calls.push(m);
 const reply=result=>e.source.postMessage({jsonrpc:'2.0',id:m.id,result},'*');
 if(m.method==='ui/initialize') reply({protocolVersion:'2026-01-26',hostInfo:{name:'synthetic',version:'1'},hostCapabilities:{...(mode==='absent'||mode==='unknown'?{}:{serverTools:{}}),message:{text:{}},updateModelContext:{text:{},structuredContent:{}},experimental:mode==='absent'||mode==='mobile'?{}:mode==='unknown'?{'openai/modelContext':'future','openai/message':'future'}:{'openai/modelContext':{},'openai/message':{}}},hostContext:{availableDisplayModes:mode==='absent'||mode==='unknown'?['inline']:['inline','fullscreen'],'openai/deepLink':{url:'/items/owned'}}});
 if(m.method==='tools/call') {
  if(mode==='pending'&&!initialHeld) { initialHeld=true; window.releaseInitial=()=>reply({content:[{type:'text',text:'Stale initial response'}]}); }
  else if(m.params.arguments.url==='/items/denied') reply({isError:true,content:[{type:'text',text:'Denied'}]});
  else if(m.params.arguments.url==='/items/slow') setTimeout(()=>reply({content:[{type:'text',text:'Stale'}]}),100);
  else reply({content:[{type:'text',text:'Authorized synthetic item'}]});
 }
 if(m.method==='ui/request-display-mode') {
  if(mode==='failure') e.source.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Unsupported'}},'*');
  else reply({mode:m.params.mode});
 }
 if(m.method==='ui/update-model-context'||m.method==='ui/message') {
  const nativeContext=m.method==='ui/update-model-context'&&!!m.params.content?.[0]?._meta;
  const reject=()=>e.source.postMessage({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'Synthetic failure'}},'*');
  if(mode==='held-failure'&&nativeContext) window.releaseNativeFailure=reject;
  else if(mode==='failure'&&nativeContext) reject();
  else { if(m.method==='ui/update-model-context') window.portableContextReplacements.push(m.params); reply({}); }
 }
});
</script></body></html>`;
createServer((req,res)=>{
 res.setHeader('Content-Type','text/html');
 if(req.url==='/view') {res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'sha256-${hash}'; connect-src 'none'; img-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'`);res.end(html);}
 else res.end(host);
}).listen(47865,'127.0.0.1');
