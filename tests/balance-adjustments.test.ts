import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {AccountState} from '../lib/account-state';
import type {CashRecord} from '../lib/types';
import type {RealizedEvent} from '../lib/realized';
import type {BalanceInterval,BalanceObservation} from '../lib/balance-adjustments';
import {balanceIntervals,deriveBalanceAdjustments,inferredPayoutSummary,KNOWN_FIRM_ADJUSTMENTS,observation} from '../lib/balance-adjustments';
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
const noProceeds={count:0,gross:0,expected:0};
const demoNotices=[{id:'synthetic-notice-a',date:'2026-08-03',accounts:[account],kind:'hedging-profit-removal' as const,amount:null,source:'Synthetic test notice'},{id:'synthetic-notice-b',date:'2026-08-10',accounts:['LFE05099999999999'],kind:'hedging-profit-removal' as const,amount:null,source:'Synthetic test notice'}];

// CashValue changes alone are not payouts: executions must first explain their
// portion, and unobserved values or unknown coverage cannot become invented cash.
test('a trading loss fully explains a cash balance drop without creating an adjustment or payout',()=>{
 const pair=interval(),events=history([event(-1000,2)]),snapshot=JSON.stringify([pair,[...events]]);
 const rows=deriveBalanceAdjustments([pair],events,[],[],now);
 assert.deepEqual(rows,[]);assert.deepEqual(inferredPayoutSummary(rows),noProceeds);assert.equal(JSON.stringify([pair,[...events]]),snapshot);
});
test('realized profit is removed from a cash drop before estimating the remaining debit',()=>{
 const pair=interval(point(50000,0),point(49250,5)),cash:CashRecord[]=[],snapshot=JSON.stringify(cash),rows=deriveBalanceAdjustments([pair],history([event(250,2)]),cash,[],now);
 assert.equal(rows.length,1);assert.equal(rows[0].tradingNet,250);assert.equal(rows[0].amount,-1000);assert.equal(rows[0].kind,'likely-payout');assert.equal(rows[0].settled,true);
 assert.equal(rows[0].source,'automatic-estimate');assert.equal(rows[0].expectedShare,900);assert.equal(rows[0].payoutId,undefined);
 assert.deepEqual(inferredPayoutSummary(rows),{count:1,gross:1000,expected:900});assert.equal(JSON.stringify(cash),snapshot);
});
test('a balance credit is separate from payout proceeds even on a recognized funded account',()=>{
 const rows=deriveBalanceAdjustments([interval(point(50000,0),point(51000,5))],history(),[],[],now);
 assert.equal(rows.length,1);assert.equal(rows[0].amount,1000);assert.equal(rows[0].kind,'credit');assert.equal(rows[0].expectedShare,null);assert.deepEqual(inferredPayoutSummary(rows),noProceeds);
});
test('missing cash reads and missing execution history never produce a fabricated payout amount',()=>{
 const before=point(50000,0),after=point(49000,5);
 for(const pair of [{before:{...before,state:{...before.state,values:{}}},after},{before,after:{...after,state:{...after.state,values:{}}}}])assert.deepEqual(deriveBalanceAdjustments([pair],history(),[],[],now),[]);
 for(const events of [new Map<string,RealizedEvent[]>(),new Map([[account,[]]]),history([], 'LFF05000000000019999')]){
  const rows=deriveBalanceAdjustments([{before,after}],events,[],[],now);assert.equal(rows.length,1);assert.equal(rows[0].amount,null);assert.equal(rows[0].tradingNet,null);assert.equal(rows[0].kind,'unexplained');assert.equal(rows[0].expectedShare,null);assert.deepEqual(inferredPayoutSummary(rows),noProceeds);
 }
 assert.deepEqual(deriveBalanceAdjustments([],history(),[],[],now),[]);
});
test('expected inferred proceeds apply the 90 percent Lucid share with cent rounding and remain estimates',()=>{
 for(const [debit,expected] of [[500,450],[750.55,675.5],[1000.01,900.01],[2000,1800]]){
  const rows=deriveBalanceAdjustments([interval(point(50000,0),point(50000-debit,5))],history(),[],[],now);
  assert.equal(rows[0].kind,'likely-payout');assert.equal(rows[0].amount,-debit);assert.equal(rows[0].expectedShare,expected);assert.deepEqual(inferredPayoutSummary(rows),{count:1,gross:debit,expected});
 }
});

test('duplicate and out-of-order captures yield adjacent intervals and late inserts supersede the former interval',()=>{
 const first=point(50000,0),middle=point(49500,2),last=point(49000,5),oldRows=deriveBalanceAdjustments(balanceIntervals([first,last]),history(),[],[],now),oldId=oldRows[0].id;
 assert.deepEqual(inferredPayoutSummary(oldRows),{count:1,gross:1000,expected:900});
 const observations=[last,middle,first,structuredClone(first),structuredClone(last),structuredClone(middle)],snapshot=JSON.stringify(observations),pairs=balanceIntervals(observations);
 assert.deepEqual(pairs.map(pair=>[pair.before.capturedAt,pair.after.capturedAt]),[[first.capturedAt,middle.capturedAt],[middle.capturedAt,last.capturedAt]]);
 const labels=[{id:oldId,kind:'payout' as const,note:'Classification of the superseded interval',updatedAt:time(10)}],rows=deriveBalanceAdjustments(pairs,history(),[],labels,now);
 assert.equal(rows.length,2);assert.equal(rows.some(row=>row.id===oldId),false);assert.equal(rows.every(row=>row.source==='automatic-estimate'),true);assert.deepEqual(rows.map(row=>row.amount),[-500,-500]);
 assert.deepEqual(inferredPayoutSummary(rows),{count:2,gross:1000,expected:900});assert.equal(JSON.stringify(observations),snapshot);
 assert.deepEqual(deriveBalanceAdjustments(balanceIntervals([...observations].reverse()),history(),[],labels,now),rows);
});
test('conflicting captures at one time are rejected and a real capture replaces a legacy baseline at that time',()=>{
 const first=point(50000,0),last=point(49000,5),legacy={...first,id:'legacy:'+first.id,origin:'legacy' as const,running:false};
 assert.throws(()=>balanceIntervals([first,point(49999,0),last]),/conflict/i);
 for(const points of [[legacy,last,first],[first,last,legacy]]){
  const pairs=balanceIntervals(points);assert.equal(pairs.length,1);assert.equal(pairs[0].before.origin,'capture');assert.equal(pairs[0].before.id,first.id);
 }
});

test('a matching cash deduction or firm confirmation explains the debit without adding inferred proceeds',()=>{
 const firm=cashRecord({id:'firm-payout',deduction:null,note:'',firmPayout:{firm:'Lucid',currency:'USD',amount:1000,requestedDate:'2026-10-18',approvedDate:'2026-10-19',status:'Paid',source:'Owner firm record'}});
 for(const record of [cashRecord(),firm]){
  const cash=[record],snapshot=JSON.stringify(cash),rows=deriveBalanceAdjustments([interval()],history(),cash,[],now);
  assert.equal(rows[0].kind,'payout');assert.equal(rows[0].payoutId,record.id);assert.deepEqual(rows[0].possiblePayoutIds,[record.id]);
  assert.deepEqual(inferredPayoutSummary(rows),noProceeds);assert.equal(payoutIncomeSummary(cash).expected,900);assert.equal(payoutIncomeSummary(cash).actual,null);assert.equal(JSON.stringify(cash),snapshot);
 }
});
test('bank receipts and firm trader-share amounts are possible matches that cannot create duplicate proceeds',()=>{
 const received=cashRecord({id:'bank-receipt',deduction:null,received:900,date:'2026-10-22'}),share=cashRecord({id:'firm-trader-share',deduction:null,payoutAmountBasis:'trader-share',payoutSplit:.9,firmPayout:{firm:'Lucid',currency:'USD',amount:900,requestedDate:'2026-10-18',approvedDate:'2026-10-19',status:'Paid',source:'Owner firm record'}});
 for(const record of [received,share]){
  const rows=deriveBalanceAdjustments([interval()],history(),[record],[],postingNow);
  assert.equal(payoutProceeds(record).gross,null);assert.equal(payoutProceeds(record).expected,900);assert.equal(rows[0].possiblePayoutIds.includes(record.id),true);assert.deepEqual(inferredPayoutSummary(rows),noProceeds);
  assert.equal(payoutIncomeSummary([record]).expected!+inferredPayoutSummary(rows).expected,900);
 }
});
test('payout matching allows the three-day posting window and rejects records outside it or on another account',()=>{
 for(const date of ['2026-10-16','2026-10-22']){
  const record=cashRecord({id:'posted-'+date,date}),rows=deriveBalanceAdjustments([interval()],history(),[record],[],postingNow);
  assert.equal(rows[0].payoutId,record.id);assert.deepEqual(inferredPayoutSummary(rows),noProceeds);
 }
 const earlyFirm=cashRecord({id:'approved-three-days-earlier',deduction:null,firmPayout:{firm:'Lucid',currency:'USD',amount:1000,requestedDate:'2026-10-15',approvedDate:'2026-10-16',status:'Paid',source:'Owner firm record'}});
 assert.equal(deriveBalanceAdjustments([interval()],history(),[earlyFirm],[],postingNow)[0].payoutId,earlyFirm.id);
 for(const record of [cashRecord({date:'2026-10-15'}),cashRecord({date:'2026-10-23'}),cashRecord({account:'LFF05000000000019999'})]){
  const rows=deriveBalanceAdjustments([interval()],history(),[record],[],postingNow);assert.equal(rows[0].payoutId,undefined);assert.deepEqual(rows[0].possiblePayoutIds,[]);assert.deepEqual(inferredPayoutSummary(rows),{count:1,gross:1000,expected:900});
 }
});
test('one known payout cannot explain two deductions or cause either candidate to add proceeds again',()=>{
 const pairs=balanceIntervals([point(50000,0),point(49000,2),point(48000,5)]),record=cashRecord(),rows=deriveBalanceAdjustments(pairs,history(),[record],[],now);
 assert.equal(rows.length,2);assert.equal(rows.every(row=>row.payoutId===undefined),true);assert.equal(rows.every(row=>row.possiblePayoutIds.includes(record.id)),true);assert.deepEqual(inferredPayoutSummary(rows),noProceeds);
 assert.equal(payoutIncomeSummary([record]).expected,900);
});
test('owner classification can exclude a known debit but cannot invent money from unknown coverage',()=>{
 const pair=interval(),id=deriveBalanceAdjustments([pair],history(),[],[],now)[0].id;
 for(const kind of ['firm-adjustment','unexplained','ignore'] as const){
  const rows=deriveBalanceAdjustments([pair],history(),[],[{id,kind,note:'Owner classification',updatedAt:time(10)}],now);
  assert.equal(rows[0].kind,kind);assert.equal(rows[0].source,'owner');assert.equal(rows[0].expectedShare,null);assert.deepEqual(inferredPayoutSummary(rows),noProceeds);
 }
 const label={id,kind:'payout' as const,note:'Confirmed by owner',updatedAt:time(10)},unknown=deriveBalanceAdjustments([pair],new Map(),[],[label],now);
 assert.equal(unknown[0].kind,'payout');assert.equal(unknown[0].amount,null);assert.equal(unknown[0].expectedShare,null);assert.deepEqual(inferredPayoutSummary(unknown),noProceeds);
});

test('both known hedging incidents remain firm adjustments with no invented notice amount or payout income',()=>{
 assert.equal(demoNotices.length,2);
 for(const notice of demoNotices){
  assert.equal(notice.kind,'hedging-profit-removal');assert.equal(notice.amount,null);
  for(const name of notice.accounts){
   const start=Date.parse(notice.date+'T15:00:00Z'),pair=interval(point(50000,0,name,start),point(49000,5,name,start)),at=start+10*60000;
   const known=deriveBalanceAdjustments([pair],history([],name,start),[],[],at,demoNotices);assert.equal(known[0].kind,'firm-adjustment');assert.equal(known[0].expectedShare,null);assert.deepEqual(inferredPayoutSummary(known),noProceeds);
   const unknown=deriveBalanceAdjustments([pair],new Map(),[],[],at,demoNotices);assert.equal(unknown[0].kind,'firm-adjustment');assert.equal(unknown[0].amount,null);assert.equal(unknown[0].tradingNet,null);assert.deepEqual(inferredPayoutSummary(unknown),noProceeds);
  }
 }
 assert.deepEqual(deriveBalanceAdjustments([],new Map(),[],[],now),[]);
});

// Every unhealthy interval must fail closed for automatic payout inference,
// even when its residual debit happens to have an ordinary payout amount.
test('stopped, legacy, absent and disconnected endpoints cannot count as likely payouts',()=>{
 const first=point(50000,0),last=point(49000,5),pairs:BalanceInterval[]=[
  {before:{...first,running:false},after:last},{before:first,after:{...last,running:false}},
  {before:{...first,origin:'legacy'},after:last},{before:first,after:{...last,origin:'legacy'}},
  {before:{...first,origin:'not-seen'},after:last},{before:first,after:{...last,origin:'not-seen'}},
  {before:{...first,state:{...first.state,connected:false}},after:last},{before:first,after:{...last,state:{...last.state,connected:false}}},
  {before:first,after:last,gap:true},
 ];
 for(const pair of pairs){const rows=deriveBalanceAdjustments([pair],history(),[],[],now);assert.equal(rows.length,1);assert.notEqual(rows[0].kind,'likely-payout');assert.equal(rows[0].expectedShare,null);assert.ok(rows[0].reasons.length);assert.deepEqual(inferredPayoutSummary(rows),noProceeds);}
});
test('a gap longer than twenty minutes cannot count as a likely payout',()=>{
 const rows=deriveBalanceAdjustments([interval(point(50000,0),point(49000,21))],history(),[],[],base+25*60000);
 assert.equal(rows.length,1);assert.notEqual(rows[0].kind,'likely-payout');assert.equal(rows[0].expectedShare,null);assert.deepEqual(inferredPayoutSummary(rows),noProceeds);
});
test('provider, connection and currency changes cannot count as likely payouts',()=>{
 const first=point(50000,0),last=point(49000,5),states:Partial<AccountState>[]=[{provider:'CQG'},{provider:''},{connection:'Another login'},{currency:'EUR'}];
 for(const patch of states){const rows=deriveBalanceAdjustments([{before:first,after:{...last,state:{...last.state,...patch}}}],history(),[],[],now);assert.equal(rows.some(row=>row.kind==='likely-payout'),false);assert.deepEqual(inferredPayoutSummary(rows),noProceeds);}
 const eurFirst={...first,state:{...first.state,currency:'EUR'}},eurLast={...last,state:{...last.state,currency:'EUR'}};
 assert.deepEqual(deriveBalanceAdjustments([{before:eurFirst,after:eurLast}],history(),[],[],now),[]);
});
test('stale balance reads, stale positions and open or unavailable positions cannot count as likely payouts',()=>{
 const first=point(50000,0),last=point(49000,5),pairs:BalanceInterval[]=[
  {before:{...first,state:{...first.state,values:{CashValue:{...first.state.values.CashValue!,at:time(-1)}}}},after:last},
  {before:first,after:{...last,state:{...last.state,values:{CashValue:{...last.state.values.CashValue!,at:time(4)}}}}},
  {before:first,after:{...last,state:{...last.state,positionsAt:time(4)}}},
  {before:first,after:{...last,state:{...last.state,positionsAvailable:false,positionsAt:null}}},
  {before:first,after:{...last,state:{...last.state,positions:[{instrument:'MNQ 2026-12',side:'Long',quantity:1,averagePrice:100}]}}},
 ];
 for(const pair of pairs){const rows=deriveBalanceAdjustments([pair],history(),[],[],now);assert.notEqual(rows[0].kind,'likely-payout');assert.equal(rows[0].expectedShare,null);assert.deepEqual(inferredPayoutSummary(rows),noProceeds);}
});
test('an execution at either balance timestamp leaves ordering ambiguous and cannot count as a likely payout',()=>{
 for(const minutes of [0,5]){
  const rows=deriveBalanceAdjustments([interval()],history([event(0,minutes,'boundary-fill')]),[],[],now);
  assert.equal(rows.length,1);assert.notEqual(rows[0].kind,'likely-payout');assert.equal(rows[0].expectedShare,null);assert.ok(rows[0].reasons.some(reason=>/timestamp|boundary/i.test(reason)));assert.deepEqual(inferredPayoutSummary(rows),noProceeds);
 }
});
test('a six-fraction execution timestamp at the same instant as a three-fraction cash read remains an ambiguous boundary',()=>{
 for(const minutes of [0,5]){
  const boundary={...event(0,minutes,'precise-boundary'),time:time(minutes).replace('.000Z','.000000Z')},rows=deriveBalanceAdjustments([interval()],history([boundary]),[],[],now);
  assert.equal(Date.parse(boundary.time),Date.parse(time(minutes)));assert.equal(rows.length,1);assert.notEqual(rows[0].kind,'likely-payout');assert.equal(rows[0].expectedShare,null);assert.ok(rows[0].reasons.some(reason=>/timestamp|boundary/i.test(reason)));assert.deepEqual(inferredPayoutSummary(rows),noProceeds);
 }
});
test('unknown fees or missing inventory during the interval cannot become an inferred debit',()=>{
 for(const fill of [event(null,2),{...event(0,2),net:null,unmatched:1,coverageIssues:1}]){
  const rows=deriveBalanceAdjustments([interval()],history([fill]),[],[],now);assert.equal(rows[0].tradingNet,null);assert.equal(rows[0].amount,null);assert.notEqual(rows[0].kind,'likely-payout');assert.equal(rows[0].expectedShare,null);assert.deepEqual(inferredPayoutSummary(rows),noProceeds);
 }
});
test('settling waits three minutes from the latest receipt at either endpoint',()=>{
 for(const [beforeReceived,afterReceived,checkMinute,settledMinute] of [[8,6,10,11],[1,9,11,12]]){
  const pair=interval({...point(50000,0),receivedAt:time(beforeReceived)},{...point(49000,5),receivedAt:time(afterReceived)});
  const pending=deriveBalanceAdjustments([pair],history(),[],[],base+checkMinute*60000);assert.equal(pending[0].settled,false);assert.deepEqual(inferredPayoutSummary(pending),noProceeds);
  const settled=deriveBalanceAdjustments([pair],history(),[],[],base+settledMinute*60000);assert.equal(settled[0].settled,true);assert.equal(settled[0].kind,'likely-payout');assert.deepEqual(inferredPayoutSummary(settled),{count:1,gross:1000,expected:900});
 }
});
