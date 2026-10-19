import {ACCOUNT_STATE_LIMIT,validateAccountState} from './account-state';
import type {AccountStateCapture} from './account-state';
export function parseAccountStateXml(xml:string):AccountStateCapture{
 if(xml.length>ACCOUNT_STATE_LIMIT||/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('Invalid account snapshot XML.');
 const doc=new DOMParser().parseFromString(xml,'application/xml'),root=doc.documentElement;
 if(doc.querySelector('parsererror')||root?.tagName!=='TradebookAccountState')throw new Error('Incomplete account snapshot; it will retry on the next check.');
 const flag=(value:string|null)=>value==='true'?true:value==='false'?false:undefined;
 if([...root.children].some(e=>e.tagName!=='Account'))throw new Error('Unknown account snapshot records.');
 const accounts=[...root.children].map(row=>{
  const values:Record<string,unknown>={};
  if([...row.children].some(e=>!['Value','Position'].includes(e.tagName)))throw new Error('Unknown account snapshot fields.');
  for(const v of [...row.children].filter(e=>e.tagName==='Value')){const field=v.getAttribute('item')||'';if(field in values)throw new Error('Duplicate account value.');const value=v.getAttribute('value');values[field]={value:value===null||!value.trim()?NaN:Number(value),at:v.getAttribute('observedAtUtc'),source:v.getAttribute('source')};}
  return {account:row.getAttribute('name'),currency:row.getAttribute('currency'),connected:flag(row.getAttribute('connected')),connection:row.getAttribute('connection'),provider:row.getAttribute('provider'),positionsAvailable:flag(row.getAttribute('positionsAvailable')),values,
   positions:[...row.children].filter(e=>e.tagName==='Position').map(p=>({instrument:p.getAttribute('instrument'),side:p.getAttribute('side'),quantity:p.getAttribute('quantity')?.trim()?Number(p.getAttribute('quantity')):NaN,averagePrice:p.getAttribute('averagePrice')?.trim()?Number(p.getAttribute('averagePrice')):NaN}))};
 });
 return validateAccountState({schemaVersion:root.getAttribute('schemaVersion')==='1'?1:0,mode:root.getAttribute('mode'),recorderVersion:root.getAttribute('recorderVersion'),capturedAt:root.getAttribute('capturedAtUtc'),running:flag(root.getAttribute('running')),scopePrefixes:(root.getAttribute('scopePrefixes')||'').split(';').filter(Boolean),accounts});
}
