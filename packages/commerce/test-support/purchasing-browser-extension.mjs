/** Extension of the reviewed quote browser host; real native forms without a financial backend. */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { compile } from 'svelte/compiler';
const purchasingCss = (await Promise.all(['packages/commerce/src/svelte/components/PurchaseOrderEditor.svelte','packages/smrt-ui/src/components/forms/Checkbox.svelte'].map(async file => compile(await readFile(file,'utf8'),{filename:resolve(file),generate:'server'}).css?.code ?? ''))).join('');
const source={id:'source-1',label:'Quote Q-104',vendor:'North Studio'};
const initial={instrument:'purchase-order',tax:'0.00',scope:'Retained scope',inclusions:'Design',exclusions:'Printing',reason:'Reduce unused scope',allocations:[{id:'a',label:'Design',amount:'1200.00',retained:true,minimumMinor:0,maximumMinor:120000},{id:'b',label:'Delivery',amount:'',retained:true,minimumMinor:0}]};
let requests=[];
let sequence=1;
export async function handleRequest(req,res,{vite,render,css}) {
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname==='/purchase-source'){const {default:Source}=await vite.ssrLoadModule('/src/svelte/components/PurchaseSourceSelector.svelte');const output=render(Source,{props:{sources:[source],action:'/purchase-native'}});res.setHeader('Content-Type','text/html');res.end(`<html><body>${output.body}</body></html>`);return true;}
 if(pathname==='/purchase-demo'||pathname==='/purchase-review-refresh') {
  res.setHeader('Content-Type','text/html');res.end(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:16px;font-family:sans-serif}*{box-sizing:border-box}</style></head><body><div id="app"></div><script type="module" src="/test-support/purchasing-client.ts"></script></body></html>`);return true;
 }
 if(pathname!=='/purchase-native'&&pathname!=='/purchase-post')return false;
 const {default:Editor}=await vite.ssrLoadModule('/src/svelte/components/PurchaseOrderEditor.svelte');
 let values=structuredClone(initial),message='',review;
 const hiddenFields=[{name:'requestId',value:'same-purchase-request'},{name:'expectedTenantId',value:'tenant-1'},{name:'sourceId',value:'source-1'},{name:'predecessorId',value:'prior-order'}];
 if(req.method==='POST') {
  let body='';for await(const chunk of req)body+=chunk;
  const data=new URLSearchParams(body);requests.push([...data.entries()]);
  const text=name=>data.get(name)??'';
  values={...Object.fromEntries(['instrument','tax','scope','inclusions','exclusions','reason'].map(key=>[key,text(key)])),allocations:data.getAll('allocationId').map((id,index)=>({...initial.allocations.find(row=>row.id===id),id,label:id==='a'?'Design':id==='b'?'Delivery':'Additional',amount:data.getAll('allocationAmount')[index]??''}))};
  for(const field of hiddenFields)field.value=text(field.name);
  const intent=text('intent');
  if(intent==='addAllocation')values.allocations.push({id:`new-${++sequence}`,label:'Additional',amount:''});
  else if(intent.startsWith('removeAllocation:'))values.allocations=values.allocations.filter(row=>row.id!==intent.slice('removeAllocation:'.length));
  else if(intent==='review'||intent==='record') {
   review={fingerprint:'retained-review',sourceLabel:'North Studio Q-104',total:{currency:'CAD',minorUnitDigits:2,amountMinor:0},taxMinor:0,scope:values.scope};
   if(intent==='record')message='Simulated uncertain response; exact submitted identity retained.';
  }
 }
 const output=render(Editor,{props:{operation:'reduce',source,currency:'CAD',minorUnitDigits:2,values,instruments:[{value:'purchase-order',label:'Purchase order'}],action:'/purchase-post',hiddenFields,review,message,rowActions:{add:'addAllocation',removePrefix:'removeAllocation:'}}});
 res.setHeader('Content-Type','text/html');res.end(`<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:16px;font-family:sans-serif}*{box-sizing:border-box}${css}${purchasingCss}</style>${output.head}</head><body>${output.body}</body></html>`);return true;
}
export async function run({browser,baseUrl,evidence}) {
 const context=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});const page=await context.newPage();
 await page.goto(`${baseUrl}/purchase-source`);
 await page.getByRole('combobox').selectOption('source-1');await Promise.all([page.waitForURL('**/purchase-native?source=source-1'),page.getByRole('button',{name:'Use this source',exact:true}).click()]);
 assert.equal(await page.getByLabel('Delivery').getAttribute('required'),'');
 assert.equal(await page.getByRole('button',{name:'Remove Design',exact:true}).count(),0);
 const beforeBlank=requests.length;await page.getByRole('button',{name:'Review purchase or award',exact:true}).click();assert.equal(requests.length,beforeBlank);assert.equal(await page.getByLabel('Delivery').evaluate(input=>input.validity.valueMissing),true);
 await page.getByLabel('Design').fill('12..5');
 await page.getByRole('button',{name:'Add allocation',exact:true}).focus();
 await Promise.all([page.waitForURL('**/purchase-post'),page.keyboard.press('Enter')]);
 assert.equal(await page.getByLabel('Design').inputValue(),'12..5');
 assert.equal(await page.locator('[name=allocationId]').count(),3);
 await Promise.all([page.waitForEvent('load'),page.getByRole('button',{name:'Remove Additional',exact:true}).click()]);
 assert.equal(await page.locator('[name=allocationId]').count(),2);
 await page.getByLabel('Design').fill('0');await page.getByLabel('Delivery').fill('0');
 await Promise.all([page.waitForEvent('load'),page.getByRole('button',{name:'Review purchase or award',exact:true}).click()]);
 assert.equal(await page.locator('[name=reviewFingerprint]').inputValue(),'retained-review');
 await page.getByRole('checkbox').focus();await page.keyboard.press('Space');
 await Promise.all([page.waitForEvent('load'),page.getByRole('button',{name:'Record reviewed decision',exact:true}).click()]);
 const recorded=JSON.stringify(requests.at(-1));
 assert.equal(await page.locator('[name=requestId]').inputValue(),'same-purchase-request');
 assert.equal(await page.getByRole('checkbox').isChecked(),false);
 await page.getByRole('checkbox').focus();await page.keyboard.press('Space');
 await Promise.all([page.waitForEvent('load'),page.getByRole('button',{name:'Record reviewed decision',exact:true}).click()]);
 assert.equal(JSON.stringify(requests.at(-1)),recorded);
 await page.screenshot({path:resolve(evidence,'purchase-native-390.png'),fullPage:true});await context.close();
 const hydrated=await browser.newContext({viewport:{width:390,height:844}});const demo=await hydrated.newPage();const errors=[];demo.on('pageerror',error=>errors.push(String(error)));
 await demo.goto(`${baseUrl}/purchase-demo`);await demo.getByRole('button',{name:'Preview ordinary amendment',exact:true}).click();await demo.getByLabel('Purchasing source').selectOption('source-2');await demo.getByRole('button',{name:'Use this source',exact:true}).click();assert.equal(await demo.locator('[name=sourceId]').inputValue(),'source-2');await demo.getByLabel('Design services').fill('0');
 await demo.getByRole('button',{name:'Review purchase or award',exact:true}).click();assert.equal(await demo.getByText('Reviewed total: 0.00 CAD',{exact:true}).count(),1);await demo.getByRole('checkbox').focus();await demo.keyboard.press('Space');await demo.getByRole('button',{name:'Record reviewed decision',exact:true}).click();
 assert.equal(await demo.locator('[name=requestId]').inputValue(),'demo-purchase-request');
 assert.equal(await demo.getByLabel('Design services').inputValue(),'0');
 assert.equal(await demo.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await demo.screenshot({path:resolve(evidence,'purchase-demo-390.png'),fullPage:true});
 await demo.goto(`${baseUrl}/purchase-review-refresh`);
 await demo.getByRole('checkbox').focus();await demo.keyboard.press('Space');assert.equal(await demo.getByRole('checkbox').isChecked(),true);
 await demo.getByRole('button',{name:'Receive replacement review',exact:true}).click();
 assert.equal(await demo.locator('[name=reviewFingerprint]').inputValue(),'review-2');assert.equal(await demo.getByRole('checkbox').isChecked(),false);
 assert.deepEqual(errors,[]);await hydrated.close();
 console.log('PASS: purchasing native keyboard allocation edits, explicit reduction zero, review/unchecked confirmation, identical uncertain retry, hydrated390px.');
}
