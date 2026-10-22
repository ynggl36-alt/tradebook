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
test('a delayed trading cash posting offsets its exact adjacent residual without rewriting the evidence',()=>{
 const points=[point(55000,0),point(54998.75,5),point(55278.5,6)],events=history([event(278.5,4)]),before=JSON.stringify({points,events:[...events]});
 const rows=deriveBalanceAdjustments(balanceIntervals(points),events,[],[],now),debit=rows.find(row=>row.amount===-279.75)!,credit=rows.find(row=>row.amount===279.75)!;
 assert.equal(rows.length,2);assert.equal(debit.tradingNet,278.5);assert.equal(credit.tradingNet,0);
 assert.equal(debit.kind,'payout');assert.equal(credit.kind,'credit');assert.equal(debit.source,'automatic-estimate');assert.equal(credit.source,'automatic-estimate');
 assert.equal(debit.before,55000);assert.equal(debit.after,54998.75);assert.equal(credit.before,54998.75);assert.equal(credit.after,55278.5);
 assert.equal(debit.settlementOffsetId,credit.id);assert.equal(credit.settlementOffsetId,debit.id);assert.match(debit.reasons.at(-1)!,/no net balance adjustment/);
 assert.deepEqual(inferredPayoutSummary(rows),none);assert.equal(JSON.stringify({points,events:[...events]}),before);
});
test('two ordinary full deductions survive beside a short trading posting offset',()=>{
 const points=[point(55000,0),point(53000,5),point(51000,60),point(50998.75,65),point(51278.5,66)];
 const rows=deriveBalanceAdjustments(balanceIntervals(points),history([event(278.5,64)]),[],[],base+75*60000);
 assert.deepEqual(inferredPayoutSummary(rows),{count:2,gross:4000});assert.equal(rows.filter(row=>row.amount===-2000&&!row.settlementOffsetId).length,2);assert.equal(rows.filter(row=>row.settlementOffsetId).length,2);
});
test('cash-first and execution-first postings use the same exact three-minute boundary in either input order',()=>{
 for(const cashFirst of [false,true])for(const lag of [1,3,3.001]){
  const points=cashFirst?[point(55000,0),point(55279.75,5),point(55278.5,5+lag)]:[point(55000,0),point(54998.75,5),point(55278.5,5+lag)];
  const events=history([event(278.5,cashFirst?5+lag/2:4)]),pairs=balanceIntervals(points),rows=deriveBalanceAdjustments(pairs,events,[],[],base+15*60000);
  assert.equal(rows.filter(row=>row.settlementOffsetId).length,lag<=3?2:0);
  assert.deepEqual(inferredPayoutSummary(rows),lag<=3?none:{count:1,gross:279.75});
  assert.deepEqual(deriveBalanceAdjustments([...pairs].reverse(),events,[],[],base+15*60000),rows);
 }
});
test('an automatic offset waits for both residuals to complete upload settlement',()=>{
 const points=[point(55000,0),point(54000,5),{...point(55000,6),receivedAt:time(9)}],pairs=balanceIntervals(points);
 const pending=deriveBalanceAdjustments(pairs,history(),[],[],now);assert.equal(pending.some(row=>row.settlementOffsetId),false);
 const settled=deriveBalanceAdjustments(pairs,history(),[],[],base+12*60000);assert.equal(settled.filter(row=>row.settlementOffsetId).length,2);assert.deepEqual(inferredPayoutSummary(settled),none);
});
test('posting offsets are one-to-one and deterministic when a credit could also offset the next debit',()=>{
 const pairs=balanceIntervals([point(55000,0),point(54000,1),point(55000,2),point(54000,3)]),rows=deriveBalanceAdjustments([...pairs].reverse(),history(),[],[],now);
 const first=rows.find(row=>row.to===time(1))!,middle=rows.find(row=>row.to===time(2))!,last=rows.find(row=>row.to===time(3))!;
 assert.equal(first.settlementOffsetId,middle.id);assert.equal(middle.settlementOffsetId,first.id);assert.equal(last.settlementOffsetId,undefined);assert.deepEqual(inferredPayoutSummary(rows),{count:1,gross:1000});
});
test('unmatched credits, different accounts, gaps, overlaps, endpoint changes and cent differences never offset',()=>{
 const a=point(55000,0),b=point(54000,5),c=point(55000,6),other='LFF05000000000011',events=new Map([...history(),...history([],other)]);
 const cases:BalanceInterval[][]=[
  [interval(b,c)],
  [interval(a,b),interval(point(54000,5,other),point(55000,6,other))],
  [interval(a,b),interval(point(54000,6),point(55000,7))],
  [interval(a,b),interval(point(54000,4),c)],
  [interval(a,b),interval({...b,id:'distinct-raw-observation'},c)],
  [interval(a,b),interval({...b,state:{...b.state,values:{CashValue:{...b.state.values.CashValue!,value:54001}}}},point(55001,6))],
  [interval(a,b),interval(b,point(55000.01,6))],
 ];
 for(const pairs of cases){const rows=deriveBalanceAdjustments(pairs,events,[],[],now);assert.equal(rows.length,pairs.length);assert.ok(rows.every(row=>!row.settlementOffsetId));}
});
test('saved payout matches and possible historical overlaps cannot be automatically offset',()=>{
 const pairs=balanceIntervals([point(55000,0),point(54000,5),point(55000,6)]);
 const records=[cashRecord(),cashRecord({deduction:null,payoutAmountBasis:'trader-share',firmPayout:{firm:'Any firm',currency:'USD',amount:900,requestedDate:'2026-10-19',approvedDate:'2026-10-19',status:'Paid',source:'Synthetic'}})];
 for(const record of records){
  const rows=deriveBalanceAdjustments(pairs,history(),[record],[],now),debit=rows.find(row=>row.amount!<0)!;
  assert.ok(debit.possiblePayoutIds.includes(record.id));assert.ok(rows.every(row=>!row.settlementOffsetId));assert.deepEqual(inferredPayoutSummary(rows),none);
 }
});
test('an owner label on either endpoint prevents offsets and can restore the full deduction as a payout',()=>{
 const pairs=balanceIntervals([point(55000,0),point(54000,5),point(55000,6)]),initial=deriveBalanceAdjustments(pairs,history(),[],[],now);
 for(const target of initial)for(const kind of ['payout','ignore','firm-adjustment','unexplained'] as const){
  const labels=[{id:target.id,kind,note:'Owner classification',updatedAt:time(9)}],snapshot=JSON.stringify(labels),rows=deriveBalanceAdjustments(pairs,history(),[],labels,now),owner=rows.find(row=>row.id===target.id)!;
  assert.equal(owner.source,'owner');assert.equal(owner.kind,kind);assert.equal(owner.note,'Owner classification');assert.ok(rows.every(row=>!row.settlementOffsetId));assert.equal(JSON.stringify(labels),snapshot);
  assert.equal(inferredPayoutSummary(rows).count,target.amount!<0&&kind!=='payout'?0:1);
 }
});
test('a firm notice applying only to the compensating credit still protects the entire pair',()=>{
 const start=Date.parse('2026-10-20T04:58:00Z'),points=[point(55000,0,account,start),point(54000,1,account,start),point(55000,2,account,start)];
 const notices=[{id:'synthetic-posting-notice',date:'2026-10-20',accounts:[account],kind:'hedging-profit-removal' as const,amount:null,source:'Synthetic notice'}];
 const rows=deriveBalanceAdjustments(balanceIntervals(points),history([],account,start),[],[],start+10*60000,notices);
 assert.equal(rows.find(row=>row.amount!<0)!.kind,'payout');assert.ok(rows.every(row=>!row.settlementOffsetId));assert.deepEqual(inferredPayoutSummary(rows),{count:1,gross:1000});
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
