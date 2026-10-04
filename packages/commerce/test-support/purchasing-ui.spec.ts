import { JSDOM } from 'jsdom';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import * as publicUI from '@happyvertical/smrt-commerce/svelte';
import type { PurchaseOrder } from '../src/models/Contract.js';
import PurchaseOrderEditor from '../src/svelte/components/PurchaseOrderEditor.svelte';
import PurchaseSourceSelector from '../src/svelte/components/PurchaseSourceSelector.svelte';
import type { PurchaseDraftValues, PurchaseReviewSnapshot } from '../src/svelte/purchasing-types.js';

const source={id:'quote-1',label:'Quote Q-104',vendor:'Acme Vendor'};
const values:PurchaseDraftValues={instrument:'purchase-order',tax:'0.00',scope:'Retained scope',inclusions:'Design',exclusions:'Printing',reason:'Explicit reduction',allocations:[{id:'a',label:'Design',amount:'0',retained:true,minimumMinor:0,maximumMinor:120000},{id:'b',label:'Delivery',amount:'12..5',retained:true,sourceMinor:null}]};
const review:PurchaseReviewSnapshot={fingerprint:'same-review',sourceLabel:'Acme Vendor Q-104',total:{currency:'CAD',minorUnitDigits:2,amountMinor:1250},taxMinor:0,scope:'Reviewed retained scope',notices:['Historical source retained']};
const props={source,currency:'CAD',minorUnitDigits:2,values,instruments:[{value:'purchase-order',label:'Purchase order'}],action:'/orders?/submit',hiddenFields:[{name:'requestId',value:'same-request'},{name:'sourceId',value:'quote-1'},{name:'predecessorId',value:'prior-order'}]};
function doc(body:string){return new JSDOM(body).window.document;}

describe('purchasing UI contracts',()=>{
 it('exports public PurchaseOrder-compatible presentation and registry slots',()=>{
  const order:Pick<PurchaseOrder,'currency'|'totalAmount'>={currency:'CAD',totalAmount:1250};
  const html=render(publicUI.PurchaseOrderEditor,{props:{...props,currency:order.currency,review:{...review,total:{...review.total,amountMinor:order.totalAmount}}}}).body;
  expect(html).toContain('12.50');expect(ModuleUIRegistry.get('@happyvertical/smrt-commerce','purchase-order-editor')).toBe(publicUI.PurchaseOrderEditor);
 });
 it('uses native GET source selection with explicit unavailable options and retained unknown selection',()=>{
  const page=doc(render(PurchaseSourceSelector,{props:{action:'/select',value:'missing',name:'pricingSource',sources:[{...source,disabled:true,notice:'Superseded'}]}}).body);
  expect(page.querySelector('form')?.method).toBe('get');
  expect(page.querySelector('option[value=missing]')?.hasAttribute('disabled')).toBe(true);
  expect(page.querySelector('option[value="quote-1"]')?.textContent).toContain('Superseded');
  expect(page.querySelector('button')?.disabled).toBe(true);
  expect(render(PurchaseSourceSelector,{props:{action:'/select',sources:[]}}).body).toContain('No sources available.');
 });
 it('retains every prior allocation and explicit zero, requiring amounts during reductions',()=>{
  const page=doc(render(PurchaseOrderEditor,{props:{...props,operation:'reduce',rowActions:{add:'addAllocation',removePrefix:'remove:'},names:{allocationId:'packageId',allocationAmount:'packageAmount'},errors:{b:'Invalid amount'},message:'Uncertain response'}}).body);
  expect([...page.querySelectorAll<HTMLInputElement>('[name=packageId]')].map(row=>row.value)).toEqual(['a','b']);
  const amounts=[...page.querySelectorAll<HTMLInputElement>('[name=packageAmount]')];
  expect(amounts.map(row=>row.value)).toEqual(['0','12..5']);
  expect(amounts.every(row=>row.required)).toBe(true);
  expect(page.querySelector('button[value="remove:a"]')).toBeNull();
  expect(page.querySelector('button[value=addAllocation]')?.hasAttribute('formnovalidate')).toBe(true);
  expect(page.body.textContent).toContain('Unknown');
  expect(page.body.textContent).toContain('1200.00');
  expect(page.querySelector('[name=reviewFingerprint]')).toBeNull();
  expect(page.querySelector('button[value=record]')).toBeNull();
 });
 it('renders reviewed exact totals/fingerprint with unchecked confirmation and configurable submitters',()=>{
  const page=doc(render(PurchaseOrderEditor,{props:{...props,review,intents:{name:'action',review:'preview',record:'award',edit:'change'},names:{confirmation:'approve'},confirmationValue:'confirmed'}}).body);
  expect(page.querySelector<HTMLInputElement>('[name=reviewFingerprint]')?.value).toBe('same-review');
  expect(page.querySelector<HTMLInputElement>('[name=requestId]')?.value).toBe('same-request');
  const confirm=page.querySelector<HTMLInputElement>('[name=approve]');expect(confirm?.required).toBe(true);expect(confirm?.checked).toBe(false);expect(confirm?.value).toBe('confirmed');
  expect(page.querySelector('button[name=action][value=award]')).not.toBeNull();
  expect(page.querySelector('button[value=change]')?.hasAttribute('formnovalidate')).toBe(true);
  expect(page.body.textContent).toContain('Historical source retained');
  expect(page.body.textContent).toContain('12.50');
 });
 it('retains fingerprint after uncertain commit without fabricating a new review snapshot',()=>{
  const page=doc(render(PurchaseOrderEditor,{props:{...props,retryFingerprint:'same-review'}}).body);
  expect(page.querySelector<HTMLInputElement>('[name=reviewFingerprint]')?.value).toBe('same-review');
  expect(page.body.textContent).toContain('Retry the same reviewed submission');
  expect(page.querySelector<HTMLInputElement>('[name=allocationAmount]')?.value).toBe('0');
 });
 it('offers no write controls to readers and handles empty allocation input',()=>{
  const page=doc(render(PurchaseOrderEditor,{props:{...props,readonly:true,review,values:{...values,allocations:[]}}}).body);
  expect(page.querySelector('fieldset')?.disabled).toBe(true);expect(page.querySelector('button[type=submit]')).toBeNull();expect(page.body.textContent).toContain('No allocations supplied.');
 });
});

describe('purchasing invalid money recovery', () => {
  for (const field of ['sourceMinor', 'minimumMinor', 'maximumMinor', 'total', 'taxMinor'] as const) {
    it.each([1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(`${field} renders invalid %s as unavailable`, (invalid) => {
      const allocations = [{ id: 'a', label: 'Draft', amount: '12..5', ...(['total', 'taxMinor'].includes(field) ? {} : { [field]: invalid }) }];
      const snapshot = { ...review, total: { ...review.total, ...(field === 'total' ? { amountMinor: invalid } : {}) }, ...(field === 'taxMinor' ? { taxMinor: invalid } : {}) };
      const html = render(PurchaseOrderEditor, { props: { ...props, values: { ...values, allocations }, review: snapshot } }).body;
      expect(html).toContain('Amount unavailable');
      expect(doc(html).querySelector<HTMLInputElement>('[name=allocationAmount]')?.value).toBe('12..5');
    });
  }
  it.each([-1, 9, 1.5, NaN])('invalid scale %s recovers allocation, review total and tax', (minorUnitDigits) => {
    const html = render(PurchaseOrderEditor, { props: { ...props, minorUnitDigits, review: { ...review, total: { ...review.total, minorUnitDigits } } } }).body;
    expect(html.match(/Amount unavailable/g)?.length).toBe(5);
  });
});
