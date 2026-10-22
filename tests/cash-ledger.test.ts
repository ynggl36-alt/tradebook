import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {CashRecord} from '../lib/types';
import type {BalanceAdjustment} from '../lib/balance-adjustments';
import {cashLedgerRows,cashLedgerSummary} from '../lib/cash-ledger';
import {payoutIncomeSummary,payoutProceeds} from '../lib/payouts';
const account='LFF05000000000010';
function cash(patch:Partial<CashRecord>={}):CashRecord{return {id:'saved',kind:'payout',account,date:'2026-10-07',deduction:1000,received:null,expense:null,note:'Synthetic payout',...patch};}
function deduction(patch:Partial<BalanceAdjustment>={}):BalanceAdjustment{return {id:'overnight',account,date:'2026-10-20',from:'2026-10-19T21:00:00Z',to:'2026-10-20T23:00:00Z',before:55000,after:53000,tradingNet:0,amount:-2000,kind:'payout',settled:true,source:'automatic-estimate',possiblePayoutIds:[],reasons:[],note:'',...patch};}
test('saved and automatic deductions share one chronology and full-amount total without changing records',()=>{
 const records=[cash(),cash({id:'received',date:'2026-10-08',deduction:500,received:450}),cash({id:'cost',kind:'evaluation',date:'2026-10-19',deduction:null,expense:70})],adjustments=[deduction()],original=JSON.stringify({records,adjustments});
 const rows=cashLedgerRows(records,adjustments),summary=cashLedgerSummary(rows);
 assert.deepEqual(rows.map(row=>row.id),['detected:overnight','recorded:cost','recorded:received','recorded:saved']);assert.equal(summary.count,3);assert.equal(summary.gross,3500);assert.deepEqual(summary,{count:3,knownAmounts:3,unknownAmounts:0,gross:3500});assert.deepEqual(payoutIncomeSummary(records),{count:2,gross:1500});assert.equal(JSON.stringify({records,adjustments}),original);
});
test('firm removals, overlaps, unknown amounts and unsettled deductions cannot add payouts',()=>{
 const changes:Partial<BalanceAdjustment>[]=[{kind:'firm-adjustment'},{kind:'unexplained'},{kind:'ignore'},{kind:'credit',amount:2000},{settled:false},{payoutId:'saved'},{possiblePayoutIds:['saved']},{amount:null},{amount:0}];
 for(const patch of changes){const summary=cashLedgerSummary(cashLedgerRows([cash()],[deduction(patch)]));assert.equal(summary.count,1);assert.equal(summary.gross,1000);}
 for(const patch of [{payoutId:'outside-filter'},{possiblePayoutIds:['outside-filter']}])assert.equal(cashLedgerRows([],[deduction(patch)]).length,0);
});
test('legacy split and receipt metadata never scale or replace a known account deduction',()=>{
 for(const split of [.8,.9,1]){const record=cash({payoutSplit:split,received:750,payoutAmountBasis:'trader-share'});assert.deepEqual(payoutProceeds(record),{gross:1000});}
 const firmOnly=cash({deduction:null,firmPayout:{firm:'Any firm',currency:'USD',amount:1000,requestedDate:'2026-10-06',approvedDate:'2026-10-07',status:'Paid',source:'Synthetic'}});
 assert.deepEqual(payoutProceeds(firmOnly),{gross:1000});assert.deepEqual(payoutProceeds(cash({deduction:null,received:875})),{gross:875});
});
test('an unknown payout amount stays unknown without inventing a split or hiding it behind known totals',()=>{
 const summary=cashLedgerSummary(cashLedgerRows([cash({deduction:null})],[deduction()]));assert.equal(summary.count,2);assert.equal(summary.unknownAmounts,1);assert.equal(summary.gross,null);
 assert.equal(cashLedgerSummary([]).gross,null);
});
test('a later saved payout replaces the automatic row and owner corrections remain reversible',()=>{
 const record=cash({date:'2026-10-20',deduction:2000});
 assert.equal(cashLedgerSummary(cashLedgerRows([],[deduction()])).gross,2000);
 const after=cashLedgerSummary(cashLedgerRows([record],[deduction({possiblePayoutIds:[record.id]})]));assert.equal(after.count,1);assert.equal(after.gross,2000);
 for(const kind of ['ignore','firm-adjustment','unexplained'] as const)assert.equal(cashLedgerSummary(cashLedgerRows([],[deduction({kind,source:'owner'})])).count,0);
});


test('historical and newly measured payouts use one display model while their original evidence stays intact',()=>{
 const historical=cash({note:'Example firm payout history',firmPayout:{firm:'Example firm',currency:'USD',amount:1000,requestedDate:'2026-10-06',approvedDate:'2026-10-07',status:'Paid',source:'historical-image.png'}}),original=JSON.stringify(historical);
 const rows=cashLedgerRows([historical],[deduction()]);assert.ok(rows.every(row=>row.kind==='payout'));assert.equal(rows.find(row=>row.record)?.note,'');assert.equal(rows.find(row=>row.adjustment)?.amount,2000);
 assert.equal(rows.find(row=>row.record)?.record?.firmPayout?.source,'historical-image.png');assert.equal(JSON.stringify(historical),original);assert.equal('automaticCount' in cashLedgerSummary(rows),false);
 const custom={...historical,note:'Owner reference'};assert.equal(cashLedgerRows([custom],[])[0].note,'Owner reference');
});
