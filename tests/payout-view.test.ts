import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CashView} from '../app/cash-view';
import type {Journal} from '../lib/types';

const account='LFF05000000000010';
function journal():Journal{return {ready:true,trades:[],accounts:[],profiles:[],notes:[],imports:[],lastSaved:'',seedVersion:'synthetic',cash:[{id:'historical',account,kind:'payout',date:'2026-10-07',deduction:null,received:null,expense:null,note:'Example firm payout history',firmPayout:{firm:'Example firm',currency:'USD',amount:1234.56,requestedDate:'2026-10-06',approvedDate:'2026-10-07',status:'Paid',source:'historical-image.png'}}],adjustments:[{id:'synthetic-deduction',account,date:'2026-10-20',from:'2026-10-19T21:00:00Z',to:'2026-10-20T21:00:00Z',before:55000,after:53000,tradingNet:0,amount:-2000,kind:'payout',settled:true,source:'automatic-estimate',possiblePayoutIds:[],reasons:[],note:''}]};}
function render(data:Journal){return renderToStaticMarkup(createElement(CashView,{journal:data,start:'2026-01-01',end:'2026-12-31',account:'all',profiles:new Map(),onEdit:()=>{}}));}

test('all payouts share plain rows and one total with no provenance labels, manual-entry prompts or payout-edit popup',()=>{
 const data=journal(),before=JSON.stringify(data),html=render(data),rows=html.match(/<tr data-transaction-kind="payout"[\s\S]*?<\/tr>/g)||[];
 assert.equal(rows.length,2);assert.match(html,/\$3,234\.56/);assert.match(html,/2 payouts/);
 assert.doesNotMatch(html,/90%|trader share|cash received|automatic|detected|firm record|approved|requested|historical-image|Example firm payout history|Details \/ correct|Record a payout|Manual payout entry/i);
 for(const row of rows){assert.doesNotMatch(row,/tabindex|editable-cost|<svg/);assert.match(row,/class="cash-kind payout"/);}
 assert.equal(JSON.stringify(data),before);
});
test('cost rows remain editable without making any payout row interactive',()=>{
 const data=journal();data.cash.push({id:'cost',account:'',kind:'evaluation',date:'2026-10-19',deduction:null,received:null,expense:50,note:'Business cost'});
 const html=render(data);assert.equal((html.match(/tabindex="0"/g)||[]).length,1);assert.match(html,/data-transaction-kind="evaluation" class="editable-cost" tabindex="0"/);assert.match(html,/-\$50\.00/);assert.match(html,/Add cost/);
});
test('a matching deduction does not repeat a historical payout in other balance changes',()=>{
 const data=journal();data.adjustments![0]={...data.adjustments![0],payoutId:'historical',possiblePayoutIds:['historical']};
 const html=render(data);assert.equal((html.match(/data-transaction-kind="payout"/g)||[]).length,1);assert.doesNotMatch(html,/Other balance changes/);assert.match(html,/1 payout/);
});
test('an incoming deduction settles in the background and then becomes one normal payout',()=>{
 const data=journal();data.adjustments![0]={...data.adjustments![0],settled:false,reasons:['Waiting briefly for execution uploads to settle.']};
 const pending=render(data);assert.equal((pending.match(/data-transaction-kind="payout"/g)||[]).length,1);assert.match(pending,/\$1,234\.56/);assert.doesNotMatch(pending,/Other balance changes|Provisional|Waiting briefly|Reasons &amp; classification|\$2,000\.00/);
 data.adjustments![0]={...data.adjustments![0],settled:true,reasons:[]};
 const settled=render(data);assert.equal((settled.match(/data-transaction-kind="payout"/g)||[]).length,2);assert.match(settled,/\$3,234\.56/);assert.match(settled,/2 payouts/);assert.doesNotMatch(settled,/Other balance changes|Provisional/);
});
test('settled missing coverage, firm removals and possible saved-payout overlaps remain reviewable without adding payouts',()=>{
 const data=journal(),base=data.adjustments![0];data.adjustments=[{...base,id:'missing-coverage',amount:null,tradingNet:null,kind:'unexplained',reasons:['Missing trading results']},{...base,id:'firm-removal',kind:'firm-adjustment',reasons:['Firm profit removal']},{...base,id:'possible-overlap',possiblePayoutIds:['historical'],reasons:['Possible saved payout']}];
 const html=render(data);assert.equal((html.match(/data-transaction-kind="payout"/g)||[]).length,1);assert.match(html,/\$1,234\.56/);assert.match(html,/Other balance changes/);assert.match(html,/Missing trading results/);assert.match(html,/Firm profit removal/);assert.match(html,/Saved payout overlap/);assert.doesNotMatch(html,/Provisional|Upload state|Uploads settled/);
});
test('offset posting residuals add neither a payout nor other balance-change clutter',()=>{
 const data=journal(),ordinary=data.adjustments![0],debit={...ordinary,id:'posting-debit',amount:-279.75,settlementOffsetId:'posting-credit'},credit={...ordinary,id:'posting-credit',amount:279.75,kind:'credit' as const,settlementOffsetId:'posting-debit'};
 data.adjustments=[ordinary,debit,credit];const before=JSON.stringify(data),html=render(data);
 assert.equal((html.match(/data-transaction-kind="payout"/g)||[]).length,2);assert.match(html,/\$3,234\.56/);assert.match(html,/2 payouts/);assert.doesNotMatch(html,/Other balance changes|279\.75|Reasons &amp; classification/);assert.equal(JSON.stringify(data),before);
});
