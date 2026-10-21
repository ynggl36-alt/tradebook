import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {AccountState} from '../lib/account-state';
import type {CashRecord} from '../lib/types';
import type {RealizedEvent} from '../lib/realized';
import type {BalanceInterval,BalanceObservation} from '../lib/balance-adjustments';
import {balanceIntervals,deriveBalanceAdjustments,inferredPayoutSummary,observation} from '../lib/balance-adjustments';
import {payoutIncomeSummary,payoutProceeds} from '../lib/payouts';

const account='LFF05000000000010',base=Date.parse('2026-10-19T15:00:00.000Z');
const time=(minutes:number,start=base)=>new Date(start+minutes*60000).toISOString();
const now=base+10*60000,postingNow=Date.parse('2026-10-24T15:00:00Z');
function point(cash:number,minutes:number,name=account,start=base):BalanceObservation{
 const capturedAt=time(minutes,start),state:AccountState={account:name,currency:'USD',connected:true,connection:'Lucid funded',provider:'Rithmic',capturedAt,values:{CashValue:{value:cash,at:capturedAt,source:'PlatformRead'}},positions:[],positionsAvailable:true,positionsAt:capturedAt};
 return {...observation(state,'0.4.2',true),receivedAt:capturedAt};
}
function event(net:number|null,minutes:number,id='fill',name=account,start=base):RealizedEvent{
 return {account:name,contract:'MNQ 2026-12',symbol:'MNQ',time:time(minutes,start),fillId:id,ordinal:1,gross:net===null?0:net+.5,commissions:net===null?null:.5,net,exits:1,quantity:1,unmatched:0,coverageIssues:0};
}
function history(events:RealizedEvent[]=[],name=account,start=base){return new Map([[name,[event(0,-1,'known-history',name,start),...events]]]);}
function interval(before=point(50000,0),after=point(49000,5)):BalanceInterval{return {before,after};}
function cashRecord(patch:Partial<CashRecord>={}):CashRecord{return {id:'cash-payout',account,kind:'payout',date:'2026-10-19',deduction:1000,received:null,expense:null,note:'Owner payout',...patch};}
const none={count:0,gross:0};

test('funded deductions count at their full amount with no firm split, eligibility or amount cap',()=>{
 for(const debit of [125,500,2000,5000]){
  const rows=deriveBalanceAdjustments([interval(point(55000,0),point(55000-debit,1500))],history(),[],[],base+1510*60000);
  assert.equal(rows[0].kind,'payout');assert.equal(rows[0].amount,-debit);assert.deepEqual(inferredPayoutSummary(rows),{count:1,gross:debit});assert.equal('expectedShare' in rows[0],false);
 }
});
test('legacy readings, recorder pauses, open positions and long gaps do not block account deductions',()=>{
 const before=point(55000,0),after=point(53000,10000);before.origin='legacy';before.running=false;before.state.positionsAvailable=false;after.state.connected=false;
 const pair={before,after,gap:true},snapshot=JSON.stringify(pair),rows=deriveBalanceAdjustments([pair],history(),[],[],base+10010*60000);
 assert.equal(rows[0].kind,'payout');assert.deepEqual(inferredPayoutSummary(rows),{count:1,gross:2000});assert.equal(JSON.stringify(pair),snapshot);
});
test('funded profiles enable other firms while evaluation overrides and unknown accounts stay excluded',()=>{
 for(const stage of ['Funded','Evaluation','Unclassified']){
  const name='OTHER-FIRM-SYNTHETIC',profiles=[{account:name,label:'Synthetic FundedNext account',stage,status:'Active',notes:''}];
  const rows=deriveBalanceAdjustments([interval(point(55000,0,name),point(52000,1500,name))],history([],name),[],[],base+1510*60000,[],{profiles});
  assert.equal(rows[0].kind,stage==='Funded'?'payout':'unexplained');
 }
 const profiles=[{account,label:'Override',stage:'Evaluation',status:'Active',notes:''}];
 assert.equal(deriveBalanceAdjustments([interval()],history(),[],[],now,[],{profiles})[0].kind,'unexplained');
});
test('trading losses explain cash drops and gains are subtracted before calculating the payout',()=>{
 assert.deepEqual(deriveBalanceAdjustments([interval()],history([event(-1000,2)]),[],[],now),[]);
 const rows=deriveBalanceAdjustments([interval(point(55000,0),point(53250,5))],history([event(250,2)]),[],[],now);
 assert.equal(rows[0].tradingNet,250);assert.equal(rows[0].amount,-2000);assert.deepEqual(inferredPayoutSummary(rows),{count:1,gross:2000});
 assert.equal(deriveBalanceAdjustments([interval(point(55000,0),point(52750,5))],history([event(-250,2)]),[],[],now)[0].amount,-2000);
});
test('missing execution coverage or fees cannot distinguish a trading loss from a payout',()=>{
 for(const events of [new Map<string,RealizedEvent[]>(),history([event(null,2)]),history([{...event(0,2),coverageIssues:1}])]){
  const rows=deriveBalanceAdjustments([interval()],events,[],[],now);assert.equal(rows[0].amount,null);assert.deepEqual(inferredPayoutSummary(rows),none);
 }
 const knownEmpty=new Map<string,RealizedEvent[]>([[account,[]]]);assert.equal(deriveBalanceAdjustments([interval()],knownEmpty,[],[],now)[0].amount,-1000);
});
test('known hedging removals remain firm adjustments and owner classifications still override deductions',()=>{
 const notice=[{id:'synthetic-hedge',date:'2026-10-19',accounts:[account],kind:'hedging-profit-removal' as const,amount:null,source:'Owner notice'}];
 const initial=deriveBalanceAdjustments([interval()],history(),[],[],now,notice);assert.equal(initial[0].kind,'firm-adjustment');assert.deepEqual(inferredPayoutSummary(initial),none);
 for(const kind of ['ignore','firm-adjustment','unexplained','payout'] as const){
  const rows=deriveBalanceAdjustments([interval()],history(),[],[{id:initial[0].id,kind,note:'Owner correction',updatedAt:time(8)}],now,notice);
  assert.equal(rows[0].kind,kind);assert.equal(rows[0].source,'owner');assert.equal(inferredPayoutSummary(rows).count,kind==='payout'?1:0);
 }
});
test('saved payouts suppress duplicate deductions even with an unknown historical split',()=>{
 for(const record of [cashRecord(),cashRecord({deduction:null,payoutAmountBasis:'trader-share',firmPayout:{firm:'Any firm',currency:'USD',amount:900,requestedDate:'2026-10-19',approvedDate:'2026-10-19',status:'Paid',source:'Synthetic'}})]){
  const rows=deriveBalanceAdjustments([interval()],history(),[record],[],now);assert.ok(rows[0].possiblePayoutIds.includes(record.id));assert.deepEqual(inferredPayoutSummary(rows),none);
 }
});
test('one saved payout cannot explain two separate deductions',()=>{
 const points=[point(55000,0),point(54000,2),point(53000,5)];
 const rows=deriveBalanceAdjustments(balanceIntervals(points),history(),[cashRecord()],[],now);assert.equal(rows.length,2);assert.ok(rows.every(row=>!row.payoutId));assert.deepEqual(inferredPayoutSummary(rows),none);
});
test('late execution uploads get a short settlement window before a deduction enters totals',()=>{
 const pair=interval(point(55000,0),{...point(53000,5),receivedAt:time(9)});
 assert.deepEqual(inferredPayoutSummary(deriveBalanceAdjustments([pair],history(),[],[],now)),none);
 assert.deepEqual(inferredPayoutSummary(deriveBalanceAdjustments([pair],history(),[],[],base+12*60000)),{count:1,gross:2000});
});
test('cash credits, missing values and currency changes do not become payouts',()=>{
 assert.equal(deriveBalanceAdjustments([interval(point(50000,0),point(51000,5))],history(),[],[],now)[0].kind,'credit');
 const before=point(50000,0),after=point(49000,5);
 assert.deepEqual(deriveBalanceAdjustments([interval(before,{...after,state:{...after.state,currency:'CAD'}})],history(),[],[],now),[]);
 assert.deepEqual(deriveBalanceAdjustments([interval({...before,state:{...before.state,values:{}}},after)],history(),[],[],now),[]);
});
test('immutable observations prefer a real capture over legacy copies and reject conflicting captures',()=>{
 const before=point(55000,0),after=point(53000,5),legacy={...before,origin:'legacy' as const,id:'legacy:'+before.id};
 const pairs=balanceIntervals([after,legacy,before]);assert.equal(pairs.length,1);assert.equal(pairs[0].before.id,before.id);
 assert.throws(()=>balanceIntervals([before,{...before,running:false}]),/Conflicting/);
});
