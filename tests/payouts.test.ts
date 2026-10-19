import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planFirmPayoutImport,payoutSummary,validateFirmPayout} from '../lib/payouts';
const row=()=>({account:'LFF05000000000004',firmPayout:{firm:'Lucid',currency:'USD',amount:2000,requestedDate:'2026-07-19',approvedDate:'2026-07-20',status:'Paid',source:'Owner-supplied payout history'}});
test('a firm-paid confirmation preserves request and approval dates without inventing a deposit, deduction or split',()=>{
 const result=planFirmPayoutImport([row()],[]),record=result.records[0];assert.equal(record.firmPayout?.amount,2000);assert.equal(record.firmPayout?.requestedDate,'2026-07-19');assert.equal(record.date,'2026-07-20');assert.equal(record.received,null);assert.equal(record.deduction,null);assert.equal(record.expense,null);
 assert.deepEqual(payoutSummary([record]),{firmCount:1,firmAccounts:1,firmAmount:2000,receivedCount:0,received:null,deductions:null,awaitingBank:1});
});
test('repeated payout history is idempotent and cannot erase a later bank match or silently replace a changed amount',()=>{
 const original=planFirmPayoutImport([row()],[]).records[0],matched={...original,received:1800,deduction:2000};
 assert.equal(planFirmPayoutImport([row(),row()],[matched]).records.length,0);assert.equal(planFirmPayoutImport([row(),row()],[matched]).duplicates,2);assert.equal(matched.received,1800);
 assert.throws(()=>planFirmPayoutImport([{...row(),firmPayout:{...row().firmPayout,amount:1999}}],[matched]),/differs/);
 const second={...row(),firmPayout:{...row().firmPayout,requestedDate:'2026-07-26',approvedDate:'2026-07-26'}};assert.equal(planFirmPayoutImport([row(),second],[]).records.length,2);
});
test('malformed dates, simulator accounts, amounts and unsupported statuses are rejected',()=>{
 for(const patch of [{approvedDate:'2026-07-18'},{requestedDate:'2026-02-30'},{amount:0},{amount:-1},{amount:NaN},{amount:1.001},{status:'Pending'},{currency:'CAD'}])assert.throws(()=>validateFirmPayout({...row().firmPayout,...patch}));
 assert.throws(()=>planFirmPayoutImport([{...row(),account:'Sim101'}],[]));assert.throws(()=>planFirmPayoutImport([],[]));
});
test('firm totals and confirmed deposits are shown separately without counting both as income',()=>{
 const a=planFirmPayoutImport([row()],[]).records[0],b={...a,id:'b',account:'LFF05000000000005',received:1800,firmPayout:{...a.firmPayout!,amount:789.75}},c={...a,id:'c',firmPayout:undefined,received:100,deduction:125};
 const result=payoutSummary([a,b,c]);assert.equal(result.firmAmount,2789.75);assert.equal(result.received,1900);assert.equal(result.firmCount,2);assert.equal(result.firmAccounts,2);assert.equal(result.awaitingBank,1);assert.equal(result.deductions,125);
});
