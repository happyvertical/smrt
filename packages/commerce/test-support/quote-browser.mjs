/** Targeted native-POST and hydrated browser evidence; no database or financial writes. */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { compile } from 'svelte/compiler';
import { chromium } from '@playwright/test';

const repositoryRoot = process.cwd();
const root = resolve(repositoryRoot, 'packages/commerce');
const evidence = process.env.QUOTE_EVIDENCE_DIR ?? resolve(process.env.CI_TEST_TMPDIR ?? '.artifacts', 'quote-browser');
await mkdir(evidence, {recursive:true});
const server = httpServer();
const vite = await createServer({configFile:false,root,plugins:[svelte()],server:{middlewareMode:true,hmr:{server}},appType:'custom'});
const { render } = await vite.ssrLoadModule('svelte/server');
const { default: Editor } = await vite.ssrLoadModule('/src/svelte/components/QuoteEditor.svelte');
let css='';
for(const file of ['packages/commerce/src/svelte/components/QuoteEditor.svelte',...['Form','FormGroup','Input','Select','Textarea'].map(name=>`packages/smrt-ui/src/components/forms/${name}.svelte`),'packages/smrt-ui/src/components/ui/Button.svelte']) {
 const output=compile(await readFile(resolve(repositoryRoot,file),'utf8'),{filename:resolve(repositoryRoot,file),generate:'server'});
 css+=output.css?.code??'';
}
const initial={counterpartyId:'vendor-1',reference:'Q-104',date:'2026-10-03',validUntil:'',currency:'CAD',total:'1200.00',tax:'60.00',scope:'Design services',inclusions:'',exclusions:'',reason:'',lines:[{id:'line-1',description:'Design',quantity:'10',unitRate:'114.00'}]};
const extension=process.env.QUOTE_BROWSER_EXTENSION ? await import(pathToFileURL(resolve(process.env.QUOTE_BROWSER_EXTENSION)).href) : null;
const requests=[];
let sequence=1;
server.on('request',async(req,res)=>{
 try {
 if(await extension?.handleRequest?.(req,res,{vite,render,css,requests}))return;
 if(req.url==='/native' || req.url==='/post') {
  let values=structuredClone(initial), message='', hidden=[{name:'requestId',value:'same-request'},{name:'expectedTenantId',value:'tenant-1'}];
  if(req.method==='POST') {
   let body=''; for await(const chunk of req)body+=chunk;
   const data=new URLSearchParams(body);requests.push(Object.fromEntries(data));
   const text=name=>data.get(name)??'';
   values={...Object.fromEntries(Object.keys(initial).filter(key=>key!=='lines').map(key=>[key,text(key)])),lines:data.getAll('lineId').map((id,index)=>({id,description:data.getAll('lineDescription')[index]??'',quantity:data.getAll('lineQuantity')[index]??'',unitRate:data.getAll('lineUnitRate')[index]??''}))};
   hidden=hidden.map(field=>({...field,value:text(field.name)}));
   if(text('intent')==='addLine')values.lines.push({id:`line-${++sequence}`,description:'',quantity:'',unitRate:''});
   else if(text('intent').startsWith('removeLine:'))values.lines=values.lines.filter(line=>line.id!==text('intent').slice('removeLine:'.length));
   else message='Simulated uncertain response: retry with the same request identity.';
  }
  const output=render(Editor,{props:{kind:'vendor-quotation',values,counterparties:[{id:'vendor-1',label:'Acme Vendor'}],action:'/post',hiddenFields:hidden,message,errors:message?{total:'Confirm the total'}:{}}});
  res.setHeader('Content-Type','text/html');res.end(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:16px;font-family:sans-serif}*{box-sizing:border-box}${css}</style>${output.head}</head><body>${output.body}</body></html>`);return;
 }
 if(req.url==='/demo') {
  res.setHeader('Content-Type','text/html');res.end(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:16px;font-family:sans-serif}*{box-sizing:border-box}</style></head><body><div id="app"></div><script type="module" src="/test-support/quote-client.ts"></script></body></html>`);return;
 }
 vite.middlewares(req,res,()=>{res.statusCode=404;res.end();});
 }catch(error){res.statusCode=500;res.end(String(error));}
});
await new Promise(resolve=>server.listen(5585,'127.0.0.1',resolve));
let browser;
try {
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 console.log(`Browser: ${browser.version()}`);
 const native=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});
 const page=await native.newPage();await page.goto('http://127.0.0.1:5585/native');
 await page.locator('select[name=currency]').selectOption('JPY');
 await page.getByLabel('Total, including tax').fill('12..50');
 await Promise.all([page.waitForEvent('load'),page.getByLabel('Total, including tax').press('Enter')]);
 assert.equal(requests.at(-1).intent,'save');
 assert.equal(requests.at(-1).currency,'JPY');
 assert.equal(await page.locator('[name=lineId]').count(),1);
 assert.equal(await page.locator('select[name=currency]').inputValue(),'JPY');
 assert.equal(await page.getByLabel('Total, including tax').inputValue(),'12..50');
 await page.getByLabel('Reference',{exact:true}).fill('Keyboard retained');
 await page.getByRole('button',{name:'Add line',exact:true}).focus();
 await Promise.all([page.waitForEvent('load'),page.keyboard.press('Enter')]);
 assert.equal(await page.getByLabel('Total, including tax').inputValue(),'12..50');
 assert.equal(await page.locator('[name=lineId]').count(),2);
 assert.equal(requests.at(-1).intent,'addLine');
 await Promise.all([page.waitForEvent('load'),page.getByRole('button',{name:'Remove line 2',exact:true}).click()]);
 assert.equal(await page.locator('[name=lineId]').count(),1);
 await Promise.all([page.waitForEvent('load'),page.getByRole('button',{name:'Save draft',exact:true}).click()]);
 assert.equal(await page.getByLabel('Total, including tax').inputValue(),'12..50');
 assert.equal(await page.locator('[name=requestId]').inputValue(),'same-request');
 const firstSave=JSON.stringify(requests.at(-1));
 await Promise.all([page.waitForEvent('load'),page.getByRole('button',{name:'Save draft',exact:true}).click()]);
 assert.equal(JSON.stringify(requests.at(-1)),firstSave);
 await page.screenshot({path:resolve(evidence,'native-retained-390.png'),fullPage:true});
 await native.close();
 const hydrated=await browser.newContext({viewport:{width:390,height:844}});const demo=await hydrated.newPage();const errors=[];
 demo.on('pageerror',error=>errors.push(String(error)));
 await demo.goto('http://127.0.0.1:5585/demo');await demo.getByRole('button',{name:'Add line',exact:true}).waitFor();
 await demo.locator('select[name=currency]').selectOption('JPY');
 await demo.getByLabel('Total, including tax').fill('9..99');
 await demo.getByLabel('Total, including tax').press('Enter');
 await demo.getByText('Demo rejected submission. Values and request identity remain available for retry.',{exact:true}).waitFor();
 assert.equal(await demo.locator('[name=lineId]').count(),1);
 assert.equal(await demo.getByLabel('Total, including tax').inputValue(),'9..99');
 assert.equal(await demo.locator('select[name=currency]').inputValue(),'JPY');
 await demo.getByRole('button',{name:'Add line',exact:true}).click();
 assert.equal(await demo.locator('[name=lineId]').count(),2);
 await demo.getByRole('button',{name:'Save draft',exact:true}).click();
 assert.equal(await demo.getByLabel('Total, including tax').inputValue(),'9..99');
 assert.equal(await demo.locator('[name=requestId]').inputValue(),'demo-request-1');
 assert.equal(await demo.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
 await demo.getByRole('button',{name:'Preview read only',exact:true}).click();
 assert.equal(await demo.getByLabel('Total, including tax').isDisabled(),true);
 assert.equal(await demo.locator('select[name=currency]').isDisabled(),true);
 assert.equal(await demo.locator('input[type=hidden][name=currency]').inputValue(),'JPY');
 assert.equal(await demo.getByRole('button',{name:'Save draft',exact:true}).count(),0);
 await demo.screenshot({path:resolve(evidence,'demo-readonly-390.png'),fullPage:true});
 assert.deepEqual(errors,[]);
 await extension?.run?.({browser,baseUrl:'http://127.0.0.1:5585',evidence,requests});
 console.log('PASS: native no-JS keyboard add/remove, identical uncertain retry, raw value/token/currency retention; hydrated controls/read-only and 390px overflow.');
} finally {
 await browser?.close();await new Promise(resolve=>server.close(resolve));await vite.close();
}
