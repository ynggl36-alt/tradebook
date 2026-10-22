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
 assert.deepEqual(adjustments,[]);const progress=flexPayoutDays(account,[],undefined,[],Date.parse(time(7)),{sessions:aggregateRealized(events,'session'),reportedSessions:native.sessions});assert.equal(progress.days,1);assert.equal(progress.today,280);
 assert.equal(JSON.stringify({fills,rows}),before);
});
test('a real same-session payout remains a full deduction and resets only post-payout qualifying profit',()=>{
 const events=realizedEvents(account,baseline),rows=[row(2,159),row(3,159,48159)],native=reportedAccountSessions(rows,new Map([[account,events]]),Date.parse(time(7)));
 const adjustments=deriveBalanceAdjustments(balanceIntervals(rows.map(r=>observation(state(r),'0.5.0',true))),new Map([[account,events]]),[],[],Date.parse(time(12)),[],{nativeReadings:native.readings});
 assert.equal(adjustments.length,1);assert.equal(adjustments[0].amount,-2000);assert.equal(adjustments[0].kind,'payout');
 const checkpoint=reportedCheckpoint(account,time(3),native,events)!;assert.equal(checkpoint.net,159);assert.equal(checkpoint.afterNet,0);
 const progress=flexPayoutDays(account,[],undefined,[],Date.parse(time(7)),{sessions:aggregateRealized(events,'session'),reportedSessions:native.sessions,reportedCheckpoints:[checkpoint],adjustments});assert.equal(progress.days,0);
});
test('stale, disconnected, non-USD, future and gross-only reporting cannot masquerade as verified session net',()=>{
 const events=realizedEvents(account,baseline);
 for(const r of [row(2,160),row(2,159,50159,{netAt:time(1)}),row(2,159,50159,{cashAt:time(1)}),row(2,159,50159,{connected:0}),row(2,159,50159,{currency:'CAD'}),row(9,159),row(2,NaN),row(2,159,Infinity)])assert.equal(reportedAccountSessions([r],new Map([[account,events]]),Date.parse(time(7))).sessions.length,0);
});
test('reported days use the latest value, never a peak, and do not double-count contracts or native plus model',()=>{
 const events=realizedEvents(account,baseline),native=reportedAccountSessions([row(2,159),row(3,149)],new Map([[account,events]]),Date.parse(time(7)));
 const progress=flexPayoutDays(account,[],undefined,[],Date.parse(time(7)),{sessions:aggregateRealized(events,'session'),reportedSessions:native.sessions});assert.equal(progress.days,0);assert.equal(progress.today,149);
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
 assert.equal(native.sessions[0].net,149);assert.equal(flexPayoutDays(account,[],undefined,[],Date.parse(time(7)),{sessions:aggregateRealized(clean,'session'),reportedSessions:native.sessions}).days,0);
 const broken=realizedEvents(account,[...baseline,fill(3,'Buy',20,180,22,3)]),partial=reportedAccountSessions([row(2,159)],new Map([[account,broken]]),Date.parse(time(7)));
 assert.equal(partial.sessions.length,0);assert.equal(partial.readings.size,1);assert.equal(flexPayoutDays(account,[],undefined,[],Date.parse(time(7)),{sessions:aggregateRealized(broken,'session'),reportedSessions:partial.sessions}).days,null);
});
