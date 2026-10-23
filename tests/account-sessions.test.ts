import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reportedAccountSessions,reportedCheckpoint,reportedTradingDelta} from '../lib/account-sessions';
import type {NativePnlRow} from '../lib/account-sessions';
import {realizedEvents,aggregateRealized} from '../lib/realized';
import {deriveBalanceAdjustments,observation,balanceIntervals} from '../lib/balance-adjustments';
import {flexPayoutDays} from '../lib/lucid-flex';
import type {Fill} from '../lib/types';
import type {AccountState} from '../lib/account-state';
const account='LFF05000000000081',day='2026-10-20',time=(minute:number)=>day+'T14:'+String(minute).padStart(2,'0')+':00.000Z';
function fill(id:number,side:'Buy'|'Sell',qty:number,price:number,pos:number,minute:number):Fill{return {id:String(id),ordinal:id,side,qty,price,pos,time:time(minute),contract:'MNQ 2026-12',symbol:'MNQ',pv:2};}
function row(minute:number,net:number,cash=50000+net,extra:Partial<NativePnlRow>={}):NativePnlRow{return {account,capturedAt:time(minute),netAt:time(minute),cashAt:time(minute),net,cash,connected:1,currency:'USD',connection:'Synthetic',provider:'Synthetic',...extra};}
const baseline=[fill(1,'Buy',1,100,1,0),fill(2,'Sell',1,180,0,1)];
function state(r:NativePnlRow):AccountState{return {account:r.account,capturedAt:r.capturedAt,connected:true,currency:'USD',connection:r.connection,provider:r.provider,values:{CashValue:{value:r.cash!,at:r.cashAt!,source:'PlatformRead'},RealizedProfitLoss:{value:r.net!,at:r.netAt!,source:'PlatformRead'}},positionsAvailable:true,positionsAt:r.capturedAt,positions:[]};}

test('platform session values are validated with commissions and replace broken model inventory without creating payouts',()=>{
 const fills=[...baseline,fill(3,'Buy',5,200,7,3),fill(4,'Sell',5,195,2,4),fill(5,'Buy',5,210,7,5),fill(6,'Sell',3,240,4,6)];
 const events=realizedEvents(account,fills),rows=[row(2,159),row(3,156.5),row(4,104),row(5,101.5),row(6,280)],before=JSON.stringify({fills,rows});
 const native=reportedAccountSessions(rows,new Map([[account,events]]),Date.parse(time(7)));
 assert.equal(native.sessions[0].net,280);assert.equal(aggregateRealized(events,'session')[0].net,null);
 const adjustments=deriveBalanceAdjustments(balanceIntervals(rows.map(r=>observation(state(r),'0.5.0',true))),new Map([[account,events]]),[],[],Date.parse(time(12)),[],{nativeReadings:native.readings});
 assert.deepEqual(adjustments,[]);const progress=flexPayoutDays(account,[],[],Date.parse(time(7)),{sessions:aggregateRealized(events,'session'),reportedSessions:native.sessions});assert.equal(progress.days,1);assert.equal(progress.today,280);
 assert.equal(JSON.stringify({fills,rows}),before);
});
test('a real same-session payout remains a full deduction and resets only post-payout qualifying profit',()=>{
 const events=realizedEvents(account,baseline),rows=[row(2,159),row(3,159,48159)],native=reportedAccountSessions(rows,new Map([[account,events]]),Date.parse(time(7)));
 const adjustments=deriveBalanceAdjustments(balanceIntervals(rows.map(r=>observation(state(r),'0.5.0',true))),new Map([[account,events]]),[],[],Date.parse(time(12)),[],{nativeReadings:native.readings});
 assert.equal(adjustments.length,1);assert.equal(adjustments[0].amount,-2000);assert.equal(adjustments[0].kind,'payout');
 const checkpoint=reportedCheckpoint(account,time(3),native,events)!;assert.equal(checkpoint.net,159);assert.equal(checkpoint.afterNet,0);
 const progress=flexPayoutDays(account,[],[],Date.parse(time(7)),{sessions:aggregateRealized(events,'session'),reportedSessions:native.sessions,reportedCheckpoints:[checkpoint],adjustments});assert.equal(progress.days,0);
});
test('stale, disconnected, non-USD, future and gross-only reporting cannot masquerade as verified session net',()=>{
 const events=realizedEvents(account,baseline);
 for(const r of [row(2,160),row(2,159,50159,{netAt:time(1)}),row(2,159,50159,{cashAt:time(1)}),row(2,159,50159,{connected:0}),row(2,159,50159,{currency:'CAD'}),row(9,159),row(2,NaN),row(2,159,Infinity)])assert.equal(reportedAccountSessions([r],new Map([[account,events]]),Date.parse(time(7))).sessions.length,0);
});
test('reported days use the latest value, never a peak, and do not double-count contracts or native plus model',()=>{
 const events=realizedEvents(account,baseline),native=reportedAccountSessions([row(2,159),row(3,149)],new Map([[account,events]]),Date.parse(time(7)));
 const progress=flexPayoutDays(account,[],[],Date.parse(time(7)),{sessions:aggregateRealized(events,'session'),reportedSessions:native.sessions});assert.equal(progress.days,0);assert.equal(progress.today,149);
});
test('counter carryover cannot validate a new session and native deltas never cross connection or session boundaries',()=>{
 const events=realizedEvents(account,baseline),later='2026-10-20T23:00:00.000Z',rows=[row(2,159),row(3,159,50159,{connection:'Changed'}),row(4,159,50159,{capturedAt:later,netAt:later,cashAt:later})],native=reportedAccountSessions(rows,new Map([[account,events]]),Date.parse('2026-10-21T00:00:00Z'));
 assert.equal(native.sessions.some(r=>r.day==='2026-10-21'),false);assert.equal(reportedTradingDelta(account,time(2),time(3),native.readings),null);assert.equal(reportedTradingDelta(account,time(2),later,native.readings),null);
});
test('a checkpoint between native reads uses only clean intervening fills and cannot cross an inventory gap',()=>{
 const events=realizedEvents(account,[...baseline,fill(3,'Buy',1,180,1,3)]),native=reportedAccountSessions([row(2,159),row(4,158.5)],new Map([[account,events]]),Date.parse(time(7)));
 const checkpoint=reportedCheckpoint(account,time(3),native,events)!;assert.equal(checkpoint.net,158.5);assert.equal(checkpoint.afterNet,0);
 const broken=realizedEvents(account,[...baseline,fill(3,'Buy',1,180,3,3)]);assert.equal(reportedCheckpoint(account,time(3),native,broken),null);
});
test('an unvalidated counter reset removes an obsolete native day value until its basis is verified again',()=>{
 const events=realizedEvents(account,baseline),native=reportedAccountSessions([row(2,159),row(3,0,50159)],new Map([[account,events]]),Date.parse(time(7)));
 assert.equal(native.sessions.length,0);assert.equal(reportedCheckpoint(account,time(2),native,events),null);
});
test('a checkpoint newer than the latest account reading never invents a negative after-checkpoint result',()=>{
 const events=realizedEvents(account,[...baseline,fill(3,'Buy',1,180,1,3)]),native=reportedAccountSessions([row(2,159)],new Map([[account,events]]),Date.parse(time(7)));
 assert.equal(reportedCheckpoint(account,time(3),native,events)?.afterNet,0);
});

test('known fills after the latest native read advance its total, while a broken tail stays unresolved',()=>{
 const clean=realizedEvents(account,[...baseline,fill(3,'Buy',20,180,20,3)]),native=reportedAccountSessions([row(2,159)],new Map([[account,clean]]),Date.parse(time(7)));
 assert.equal(native.sessions[0].net,149);assert.equal(flexPayoutDays(account,[],[],Date.parse(time(7)),{sessions:aggregateRealized(clean,'session'),reportedSessions:native.sessions}).days,0);
 const broken=realizedEvents(account,[...baseline,fill(3,'Buy',20,180,22,3)]),partial=reportedAccountSessions([row(2,159)],new Map([[account,broken]]),Date.parse(time(7)));
 assert.equal(partial.sessions.length,0);assert.equal(partial.readings.size,1);assert.equal(flexPayoutDays(account,[],[],Date.parse(time(7)),{sessions:aggregateRealized(broken,'session'),reportedSessions:partial.sessions}).days,null);
});

// A redundant provider position can disagree even when the economic fills and
// both independently observed account quantities/P&L agree. No owner IDs or
// actual records are needed to exercise this source-selection boundary.
const flatAt='2026-10-19T21:50:00.000Z';
function flatRow(at=flatAt,extra:Partial<NativePnlRow>={}):NativePnlRow{return {...row(0,0),capturedAt:at,net:null,netAt:null,cash:null,cashAt:null,positionsAvailable:1,positionsAt:at,positionData:'[]',...extra};}
function positioned(minute:number,net:number,positions:unknown[]=[],extra:Partial<NativePnlRow>={}):NativePnlRow{return {...row(minute,net),positionsAvailable:1,positionsAt:time(minute),positionData:JSON.stringify(positions),...extra};}
function disputed(){return [...baseline,fill(3,'Buy',5,200,7,3),fill(4,'Sell',5,210,2,4)];}
function reconcile(fills=disputed(),rows=[flatRow(),positioned(6,254)]){return reportedAccountSessions(rows,new Map([[account,realizedEvents(account,fills)]]),Date.parse(time(9)),new Map([[account,fills]]));}

test('a late first P&L reading reconciles economic fills from an observed flat inventory without creating missing contracts',()=>{
 const fills=disputed(),rows=[flatRow(),positioned(6,254)],before=JSON.stringify({fills,rows}),native=reconcile(fills,rows),original=realizedEvents(account,fills);
 assert.equal(aggregateRealized(original,'session')[0].net,null);assert.equal(native.sessions[0].net,254);assert.equal(native.projections.size,1);
 const resolved=native.reconciledEvents.get(account)!;assert.equal(resolved.length,original.length);assert.deepEqual(resolved.map(e=>e.fillId),original.map(e=>e.fillId));assert.equal(aggregateRealized([...resolved],'session')[0].net,254);
 assert.equal(flexPayoutDays(account,[],[],Date.parse(time(9)),{sessions:aggregateRealized(original,'session'),reportedSessions:native.sessions}).days,1);
 assert.equal(JSON.stringify({fills,rows}),before);
});
test('position reconciliation requires an earlier fresh flat observation on the same account, connection and provider',()=>{
 for(const anchor of [undefined,flatRow(flatAt,{positionsAvailable:0}),flatRow(flatAt,{positionsAt:time(0)}),flatRow(flatAt,{connection:'Other'}),flatRow(flatAt,{provider:'Other'}),flatRow(flatAt,{currency:'CAD'}),flatRow(flatAt,{connected:0}),flatRow(time(2)),flatRow(time(0)),flatRow(flatAt,{positionData:'not-json'}),flatRow(flatAt,{positionData:JSON.stringify([{instrument:'MNQ 12-26',side:'Long',quantity:1}])})]){
  const native=reconcile(disputed(),[...(anchor?[anchor]:[]),positioned(6,254)]);assert.equal(native.sessions.length,0);assert.equal(native.projections.size,0);
 }
});
test('matching P&L alone cannot certify stale or inconsistent ending inventory, gross-only values, or missing fills',()=>{
 for(const point of [positioned(6,254,[],{positionsAvailable:0}),positioned(6,254,[],{positionsAt:time(5)}),positioned(6,254,[{instrument:'MNQ 12-26',side:'Long',quantity:1}]),positioned(6,260),positioned(6,354)])assert.equal(reconcile(disputed(),[flatRow(),point]).sessions.length,0);
 assert.equal(reconcile(disputed().slice(2)).sessions.length,0);assert.equal(reconcile(disputed().filter(f=>f.id!=='3')).sessions.length,0);
 const exitOnly=disputed();exitOnly[0]={...exitOnly[0],entryFlag:false,side:'Sell'};assert.equal(reconcile(exitOnly).sessions.length,0);
});
test('open positions and partial exits are verified against independent current quantities while fees retain per-fill timing',()=>{
 const fills=disputed().slice(0,3),open=[{instrument:'MNQ 12-26',side:'Long',quantity:5,averagePrice:200}],native=reconcile(fills,[flatRow(),positioned(3,156.5,open)]);
 assert.equal(native.sessions[0].net,156.5);assert.equal(native.reconciledEvents.get(account)!.at(-1)!.net,-2.5);
});
test('the same verified prefix reconciles balance changes and payout checkpoints without changing saved execution evidence',()=>{
 const fills=disputed(),rows=[flatRow(),positioned(3,156.5,[{instrument:'MNQ 12-26',side:'Long',quantity:5}]),positioned(6,254),positioned(7,254,[],{cash:48254})],native=reconcile(fills,rows),original=realizedEvents(account,fills);
 const checkpoint=reportedCheckpoint(account,time(4),native,original)!;assert.equal(checkpoint.net,254);assert.equal(checkpoint.afterNet,0);
 const stateRows=rows.filter(r=>r.net!==null).map(r=>observation(state(r),'0.5.0',true));const changes=deriveBalanceAdjustments(balanceIntervals(stateRows),native.reconciledEvents,[],[],Date.parse(time(12)),[],{nativeReadings:native.readings});
 assert.equal(changes.length,1);assert.equal(changes[0].amount,-2000);assert.equal(changes[0].kind,'payout');assert.equal(aggregateRealized(original,'session')[0].net,null);
});
test('later unresolved fills, future records and counter resets cannot extend a reconciled prefix',()=>{
 const fills=[...disputed(),fill(5,'Buy',5,220,9,7)],native=reconcile(fills,[flatRow(),positioned(6,254)]);
 assert.equal(native.sessions.length,0);assert.equal(native.reconciledEvents.get(account)!.at(-1)!.coverageIssues,1);assert.equal(reportedCheckpoint(account,time(7),native,realizedEvents(account,fills)),null);
 const reset=reconcile(disputed(),[flatRow(),positioned(6,254),positioned(7,0,[],{cash:50250})]);assert.equal(reset.sessions.length,0);
 const future=positioned(10,254);assert.equal(reconcile(disputed(),[flatRow(),future]).sessions.length,0);
});

test('an idle zero counter reset retains the corroborated flat session without verifying the reset as trading P&L',()=>{
 const fills=disputed(),rows=[flatRow(),positioned(6,254),positioned(7,0,[],{cash:50254}),positioned(8,0,[],{cash:50254})],before=JSON.stringify({fills,rows}),native=reconcile(fills,rows);
 assert.deepEqual(native.sessions,[{account,day,net:254,at:time(6),through:time(6)}]);
 assert.equal(flexPayoutDays(account,[],[],Date.parse(time(9)),{sessions:aggregateRealized(realizedEvents(account,fills),'session'),reportedSessions:native.sessions}).days,1);
 assert.equal(reportedTradingDelta(account,time(6),time(7),native.readings),null);
 assert.equal(reportedCheckpoint(account,time(7),native,realizedEvents(account,fills)),null);
 assert.equal(JSON.stringify({fills,rows}),before);
});

test('zero counter resets require unchanged cash, fresh flat positions, no later fills and the same reporting series',()=>{
 for(const patch of [{cash:50253},{netAt:time(6)},{positionsAvailable:0},{positionsAt:time(6)},{positionData:'not-json'},{positionData:JSON.stringify([{instrument:'MNQ 12-26',side:'Long',quantity:1}])},{connection:'Other'},{provider:'Other'}] satisfies Partial<NativePnlRow>[]){
  const native=reconcile(disputed(),[flatRow(),positioned(6,254),positioned(7,0,[],{cash:50254,...patch})]);assert.equal(native.sessions.length,0,JSON.stringify(patch));
 }
 const open=[{instrument:'MNQ 12-26',side:'Long',quantity:1}],fills=[...disputed(),fill(5,'Buy',1,220,1,7)];
 assert.equal(reconcile(fills,[flatRow(),positioned(6,254),positioned(8,0,[],{cash:50254})]).sessions.length,0);
 assert.equal(reconcile(disputed(),[flatRow(),positioned(6,254,open),positioned(7,0,[],{cash:50254})]).sessions.length,0);
 const next='2026-10-20T23:00:00.000Z',native=reportedAccountSessions([flatRow(),positioned(6,254),positioned(7,0,[],{cash:50254,capturedAt:next,cashAt:next,netAt:next,positionsAt:next})],new Map([[account,realizedEvents(account,disputed())]]),Date.parse(next),new Map([[account,disputed()]]));
 assert.equal(native.sessions.some(row=>row.day==='2026-10-21'),false);
 const lower=reconcile(disputed(),[flatRow(),positioned(6,254),positioned(7,10,[],{cash:50010})]);assert.equal(lower.sessions[0].net,10);
 for(const patch of [{cash:50250,netAt:time(6)},{netAt:time(6)},{cashAt:time(6)},{positionsAt:time(6)},{connected:0},{currency:'CAD'},{connection:'Other'},{provider:'Other'}] satisfies Partial<NativePnlRow>[]){
  const interrupted=reconcile(disputed(),[flatRow(),positioned(6,254),positioned(7,0,[],{cash:50254,...patch}),positioned(8,0,[],{cash:50254})]);assert.equal(interrupted.sessions.length,0,JSON.stringify(patch));
 }
 const staleLast=reconcile(disputed(),[flatRow(),positioned(6,254),positioned(7,0,[],{cash:50254}),positioned(8,0,[],{cash:50254,netAt:time(7)})]);assert.equal(staleLast.sessions.length,0);
});
test('independent end-to-end verification can reconstruct an earlier checkpoint, while an as-of read cannot use future verification',()=>{
 const fills=disputed(),native=reconcile(fills),checkpoint=reportedCheckpoint(account,time(3),native,realizedEvents(account,fills))!;
 assert.equal(checkpoint.net,156.5);assert.equal(checkpoint.afterNet,97.5);
 const earlier=reportedAccountSessions([flatRow(),positioned(6,254)],new Map([[account,realizedEvents(account,fills)]]),Date.parse(time(3)),new Map([[account,fills]]));
 assert.equal(reportedCheckpoint(account,time(3),earlier,realizedEvents(account,fills)),null);
});
test('a P&L counter reset coinciding with a cash deduction cannot turn the previous profit into a trading loss or a different payout amount',()=>{
 const events=realizedEvents(account,baseline),rows=[row(2,159),row(3,0,48159)],native=reportedAccountSessions(rows,new Map([[account,events]]),Date.parse(time(7)));
 assert.equal(native.sessions.length,0);
 const adjustments=deriveBalanceAdjustments(balanceIntervals(rows.map(r=>observation(state(r),'0.5.0',true))),new Map([[account,events]]),[],[],Date.parse(time(12)),[],{nativeReadings:native.readings});
 assert.equal(adjustments[0].amount,-2000);assert.equal(adjustments[0].tradingNet,0);assert.equal(adjustments[0].kind,'payout');
 const settledRows=[row(2,159),row(3,0,50159),row(4,0,48159)],settledNative=reportedAccountSessions(settledRows,new Map([[account,events]]),Date.parse(time(7)));
 const later=deriveBalanceAdjustments(balanceIntervals(settledRows.map(r=>observation(state(r),'0.5.0',true))),new Map([[account,events]]),[],[],Date.parse(time(12)),[],{nativeReadings:settledNative.readings});
 assert.equal(later.length,1);assert.equal(later[0].amount,-2000);assert.equal(later[0].tradingActivity,false);
 const realLoss=realizedEvents(account,[...baseline,fill(3,'Buy',1,200,1,3),fill(4,'Sell',1,121,0,4)]),known=reportedAccountSessions([row(2,159),row(5,0,50000)],new Map([[account,realLoss]]),Date.parse(time(7)));
 assert.equal(known.sessions[0].net,0);
});
