import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {CashRecord} from '../lib/types';
import type {BalanceAdjustment} from '../lib/balance-adjustments';
import {cashLedgerRows,cashLedgerSummary} from '../lib/cash-ledger';
import {payoutIncomeSummary} from '../lib/payouts';

const account='LFF05000000000010';
function cash(patch:Partial<CashRecord>={}):CashRecord{return {id:'saved',kind:'payout',account,date:'2026-10-07',deduction:1000,received:null,expense:null,note:'Synthetic payout',...patch};}
function deduction(patch:Partial<BalanceAdjustment>={}):BalanceAdjustment{return {id:'overnight',account,date:'2026-10-20',from:'2026-10-20T21:00:00Z',to:'2026-10-20T23:00:00Z',before:55000,after:53000,tradingNet:0,amount:-2000,kind:'likely-payout',settled:true,source:'automatic-estimate',possiblePayoutIds:[],expectedShare:1800,reasons:[],note:'',...patch};}

test('saved and automatically detected payouts share one chronology and one total without creating a receipt',()=>{
 const records=[cash(),cash({id:'received',date:'2026-10-08',deduction:500,received:450}),cash({id:'cost',kind:'evaluation',date:'2026-10-19',deduction:null,expense:70})],adjustments=[deduction()],original=JSON.stringify({records,adjustments});
 const rows=cashLedgerRows(records,adjustments),summary=cashLedgerSummary(rows);
 assert.deepEqual(rows.map(row=>row.id),['detected:overnight','recorded:cost','recorded:received','recorded:saved']);
 assert.equal(summary.count,3);assert.equal(summary.gross,3500);assert.equal(summary.deductions,3500);assert.equal(summary.expected,3150);assert.equal(summary.detectedCount,1);assert.equal(summary.automaticCount,1);assert.equal(summary.actual,450);assert.equal(summary.receivedCount,1);
 assert.equal(payoutIncomeSummary(records).count,2);assert.equal(JSON.stringify({records,adjustments}),original);
});

test('firm removals, unexplained changes, overlaps and unsettled deductions cannot add a second payout',()=>{
 const changes:Partial<BalanceAdjustment>[]=[{kind:'firm-adjustment'},{kind:'unexplained'},{kind:'ignore'},{kind:'credit',amount:2000},{settled:false},{payoutId:'saved'},{possiblePayoutIds:['saved']},{amount:null},{amount:0}];
 for(const patch of changes){const rows=cashLedgerRows([cash()],[deduction(patch)]),summary=cashLedgerSummary(rows);assert.equal(rows.length,1);assert.equal(summary.count,1);assert.equal(summary.expected,900);assert.equal(summary.detectedCount,0);}
 // A matching record outside the visible date/account selection still suppresses
 // its candidate through the server's globally computed overlap metadata.
 for(const patch of [{payoutId:'outside-filter'},{possiblePayoutIds:['outside-filter']}])assert.equal(cashLedgerRows([],[deduction(patch)]).length,0);
});

test('an owner payout correction adds or removes the same adjustment without inventing a CashRecord',()=>{
 const approved=deduction({kind:'payout',source:'owner'}),row=cashLedgerRows([],[approved])[0];
 assert.equal(row.source,'detected');if(row.source!=='detected')throw new Error('Expected adjustment-backed row');assert.equal(row.adjustment,approved);
 const summary=cashLedgerSummary([row]);assert.equal(summary.expected,1800);assert.equal(summary.actual,null);assert.equal(summary.receivedCount,0);assert.equal(summary.automaticCount,0);
 for(const kind of ['ignore','firm-adjustment','unexplained'] as const)assert.equal(cashLedgerSummary(cashLedgerRows([],[{...approved,kind}])).count,0);
});

test('saved splits, trader-share-only amounts and actual receipts retain their own financial meaning',()=>{
 const records=[cash({id:'custom',account:'OTHER10',deduction:1000,payoutSplit:.8}),cash({id:'share-only',deduction:null,payoutAmountBasis:'trader-share',payoutSplit:.9,firmPayout:{firm:'Lucid',currency:'USD',amount:675,requestedDate:'2026-10-06',approvedDate:'2026-10-07',status:'Paid',source:'Synthetic'}}),cash({id:'actual',deduction:500,received:440}),cash({id:'zero',deduction:500,received:0})];
 const summary=cashLedgerSummary(cashLedgerRows(records,[deduction()]));
 assert.equal(summary.count,5);assert.equal(summary.gross,4000);assert.equal(summary.knownGross,4);assert.equal(summary.expected,3715);assert.equal(summary.actual,440);assert.equal(summary.receivedCount,2);
 const firmOnly=cash({deduction:null,firmPayout:{firm:'Lucid',currency:'USD',amount:1000,requestedDate:'2026-10-06',approvedDate:'2026-10-07',status:'Paid',source:'Synthetic'}}),firmSummary=cashLedgerSummary(cashLedgerRows([firmOnly],[]));
 assert.equal(firmSummary.gross,1000);assert.equal(firmSummary.expected,900);assert.equal(firmSummary.deductions,null);
});

test('adding a known automatic payout never disguises missing amounts or an unknown split',()=>{
 for(const record of [cash({deduction:null}),cash({account:'OTHER10',payoutSplit:undefined})]){
  const summary=cashLedgerSummary(cashLedgerRows([record],[deduction()]));assert.equal(summary.count,2);assert.equal(summary.expected,null);assert.equal(summary.unknownShares,1);assert.equal(summary.actual,null);
 }
 const empty=cashLedgerSummary(cashLedgerRows([],[]));assert.equal(empty.count,0);assert.equal(empty.expected,null);assert.equal(empty.gross,null);
});

test('a later matching saved payout replaces its automatic row after refresh instead of doubling proceeds',()=>{
 for(const record of [cash({date:'2026-10-20',deduction:2000}),cash({date:'2026-10-20',deduction:null,received:1800}),cash({date:'2026-10-20',deduction:null,payoutAmountBasis:'trader-share',payoutSplit:.9,firmPayout:{firm:'Lucid',currency:'USD',amount:1800,requestedDate:'2026-10-20',approvedDate:'2026-10-20',status:'Paid',source:'Synthetic'}})]){
  const before=cashLedgerSummary(cashLedgerRows([],[deduction()])),after=cashLedgerSummary(cashLedgerRows([record],[deduction({possiblePayoutIds:[record.id]})]));
  assert.equal(before.count,1);assert.equal(after.count,1);assert.equal(before.expected,1800);assert.equal(after.expected,1800);assert.equal(after.detectedCount,0);
 }
});

test('row identity is stable across refreshes and distinct when a recorded ID equals an adjustment ID',()=>{
 const records=[cash({id:'overnight',date:'2026-10-20'}),cash({id:'b',date:'2026-10-20'})],changes=[deduction()];
 const first=cashLedgerRows(records,changes),second=cashLedgerRows([...records].reverse(),changes);
 assert.deepEqual(first.map(row=>row.id),second.map(row=>row.id));assert.equal(new Set(first.map(row=>row.id)).size,3);
});
