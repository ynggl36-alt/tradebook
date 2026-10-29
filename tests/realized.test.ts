import {test} from 'node:test';
import assert from 'node:assert/strict';
import {aggregateRealized,realizedCheckpoint,realizedDays,realizedEvents,summarizeRealized} from '../lib/realized';
import {reconstruct} from '../lib/reconstruct';
import type {Fill} from '../lib/types';
const account='LFF-REALIZED-TEST';
function fill(id:string,side:'Buy'|'Sell',qty:number,price:number,pos:number|null,time='2026-10-19T15:00:00Z',contract='NQ 2026-12'):Fill{return {id,side,qty,price,pos,time,contract,symbol:contract.startsWith('MNQ')?'MNQ':contract.startsWith('MES')?'MES':'NQ',pv:contract.startsWith('MNQ')?2:contract.startsWith('MES')?5:20,ordinal:Number(id.replace(/\D/g,''))||1};}
test('partial exits realize FIFO profit immediately while completed-trade identities remain unchanged',async()=>{
 const fills=[fill('1','Buy',2,100,2),fill('2','Buy',2,110,4),fill('3','Sell',1,120,3)],snapshot=JSON.stringify(fills),partial=realizedDays(account,fills),before=await reconstruct(account,fills);
 assert.equal(before.trades.length,0);assert.equal(partial[0].gross,400);assert.equal(partial[0].exits,1);assert.equal(partial[0].quantity,1);assert.equal(partial[0].commissions,8.75);assert.equal(partial[0].net,391.25);assert.equal(JSON.stringify(fills),snapshot);
 const closedFills=[...fills,fill('4','Sell',3,130,0)],closed=await reconstruct(account,closedFills),ledger=summarizeRealized(realizedDays(account,closedFills));
 assert.equal(closed.trades.length,1);assert.equal(ledger.gross,closed.trades[0].pnl);assert.equal(ledger.gross,1800);assert.equal(ledger.commissions,14);assert.equal(ledger.net,1786);assert.deepEqual((await reconstruct(account,closedFills)).trades,closed.trades);
});
test('short positions and reversals split closing and opening quantities without realizing floating profit',()=>{
 const total=summarizeRealized(realizedDays(account,[fill('1','Sell',3,120,-3),fill('2','Buy',4,110,1),fill('3','Sell',1,115,0)]));
 assert.equal(total.gross,700);assert.equal(total.quantity,4);assert.equal(total.exits,2);assert.equal(total.unmatched,0);assert.equal(total.commissions,14);
});
test('Central-day exits and per-fill commissions stay on their actual dates across a midnight holding',()=>{
 const rows=realizedDays(account,[fill('1','Buy',2,100,2,'2026-10-20T04:59:00Z'),fill('2','Sell',1,110,1,'2026-10-20T05:01:00Z')]);
 assert.equal(rows.length,2);assert.equal(rows[0].day,'2026-10-19');assert.equal(rows[0].gross,0);assert.equal(rows[0].net,-3.5);assert.equal(rows[1].day,'2026-10-20');assert.equal(rows[1].gross,200);assert.equal(rows[1].net,198.25);
});
test('missing starting inventory and a final flat claim on unbalanced fills remain incomplete',()=>{
 const missing=realizedDays(account,[fill('1','Sell',2,110,1)]);assert.equal(missing[0].unmatched,2);assert.equal(missing[0].gross,0);assert.equal(missing[0].net,null);
 const mismatch=realizedDays(account,[fill('1','Buy',1,100,1),fill('2','Sell',3,110,0)]);assert.equal(mismatch[0].gross,200);assert.equal(mismatch[0].coverageIssues,1);assert.equal(mismatch[0].net,null);
 const exitOnly=fill('1','Sell',1,110,null);exitOnly.entryFlag=false;const skipped=realizedDays(account,[exitOnly]);assert.equal(skipped[0].unmatched,1);assert.equal(skipped[0].net,null);
});
test('MES and separate expiries remain separate inventories, and unsupported fee coverage stays unknown',()=>{
 const fills=[fill('1','Buy',2,7700,2,undefined,'MES 2026-12'),fill('2','Sell',1,7710,1,undefined,'MES 2026-12'),fill('3','Buy',1,100,1,undefined,'NQ 2027-03')],total=summarizeRealized(realizedDays(account,fills));
 assert.equal(total.gross,50);assert.equal(total.commissions,3.25);assert.equal(total.net,46.75);assert.equal(summarizeRealized(realizedDays('OTHER-FIRM',fills)).net,null);assert.equal(realizedDays(account,[fill('1','Buy',1,100,1,'2026-08-01T15:00:00Z')])[0].commissions,null);
});
test('FIFO scale-ins after partial exits use remaining lots and input ordering respects timestamp and ordinal',()=>{
 const entries=[fill('1','Buy',2,100,2),fill('2','Sell',1,110,1),fill('3','Buy',1,120,2),fill('4','Sell',1,130,1)];
 assert.equal(summarizeRealized(realizedDays(account,entries)).gross,800);assert.deepEqual(realizedDays(account,[entries[3],entries[1],entries[0],entries[2]]),realizedDays(account,entries));
});
test('per-fill ledger retains identity, entry fees and immediately realized partial-exit profit',()=>{
 const fills=[fill('1','Buy',2,100,2,'2026-10-19T14:00:00Z'),fill('2','Buy',2,110,4,'2026-10-19T14:01:00Z'),fill('3','Sell',1,120,3,'2026-10-19T15:00:00Z')],snapshot=JSON.stringify(fills),events=realizedEvents(account,fills);
 assert.equal(events.length,3);assert.deepEqual(events.map(event=>[event.fillId,event.ordinal,event.time]),fills.map(value=>[value.id,value.ordinal,value.time]));
 assert.deepEqual(events.map(event=>event.net),[-3.5,-3.5,398.25]);assert.equal(events[2].gross,400);assert.equal(events[2].quantity,1);assert.equal(events[2].exits,1);
 assert.deepEqual(aggregateRealized(events),realizedDays(account,fills));assert.equal(JSON.stringify(fills),snapshot);
 const checkpoint=realizedCheckpoint(account,'2026-10-19T14:17:43Z',events);assert.equal(checkpoint.net,-7);assert.equal(checkpoint.afterNet,398.25);assert.equal(checkpoint.session,'2026-10-19');
});
test('calendar and session ledgers separate at 17:00 Central while midnight remains in one session',()=>{
 const boundary=realizedEvents(account,[fill('1','Buy',1,100,1,'2026-10-19T21:59:59Z'),fill('2','Sell',1,110,0,'2026-10-19T22:00:00Z')]);
 const calendar=aggregateRealized(boundary),sessions=aggregateRealized(boundary,'session');
 assert.equal(calendar.length,1);assert.equal(calendar[0].day,'2026-10-19');assert.equal(calendar[0].net,196.5);
 assert.deepEqual(sessions.map(row=>[row.day,row.net]),[['2026-10-19',-1.75],['2026-10-20',198.25]]);
 const midnight=realizedEvents(account,[fill('1','Buy',1,100,1,'2026-10-20T04:59:59Z'),fill('2','Sell',1,110,0,'2026-10-20T05:00:00Z')]);
 assert.equal(aggregateRealized(midnight).length,2);assert.deepEqual(aggregateRealized(midnight,'session').map(row=>[row.day,row.net]),[['2026-10-20',196.5]]);
});
test('session aggregation follows the Chicago DST boundary in spring and fall',()=>{
 for(const [before,after,day,next] of [['2026-03-08T21:59:59Z','2026-03-08T22:00:00Z','2026-03-08','2026-03-09'],['2026-11-01T22:59:59Z','2026-11-01T23:00:00Z','2026-11-01','2026-11-02']]){
  const events=realizedEvents(account,[fill('1','Buy',1,100,1,before),fill('2','Sell',1,110,0,after)]);
  assert.deepEqual(aggregateRealized(events,'session').map(row=>row.day),[day,next]);assert.equal(aggregateRealized(events).length,1);
 }
});
test('position metadata cannot erase inventory, while an unresolved final flat claim stays incomplete',()=>{
 const events=realizedEvents(account,[fill('1','Buy',1,100,1),fill('2','Sell',1,110,-1),fill('3','Buy',1,100,0)]);
 assert.equal(events[1].gross,200);assert.equal(events[1].unmatched,0);assert.equal(events[1].coverageIssues,0);
 assert.equal(events[2].gross,0);assert.equal(events[2].coverageIssues,1);assert.equal(events[2].net,null);
 const total=summarizeRealized(aggregateRealized(events));assert.equal(total.gross,200);assert.equal(total.coverageIssues,1);assert.equal(total.net,null);assert.equal(total.commissions,5.25);
});

test('checkpoint sums keep pre-ledger baselines unknown and empty clean after-deltas zero',()=>{
 const empty=realizedCheckpoint(account,'2026-10-19T14:17:43Z',[]);assert.equal(empty.net,null);assert.equal(empty.afterNet,0);
 const firstAfter=realizedEvents(account,[fill('1','Buy',1,100,1,'2026-10-19T15:00:00Z')]),after=realizedCheckpoint(account,'2026-10-19T14:17:43Z',firstAfter);
 assert.equal(after.net,null);assert.equal(after.afterNet,-1.75);
 const earlier=realizedEvents(account,[fill('1','Buy',1,100,1,'2026-10-18T15:00:00Z')]),covered=realizedCheckpoint(account,'2026-10-19T14:17:43Z',earlier);
 assert.equal(covered.net,0);assert.equal(covered.afterNet,0);
 const gap=realizedEvents(account,[fill('1','Buy',1,100,2,'2026-10-18T15:00:00Z')]);assert.equal(realizedCheckpoint(account,'2026-10-19T14:17:43Z',gap).net,null);
});
test('checkpoint after-coverage reports unknown inventory carried in from before capture independently of known fees',()=>{
 const events=realizedEvents(account,[fill('1','Buy',1,100,2,'2026-10-19T14:00:00Z'),fill('2','Sell',1,110,1,'2026-10-19T15:00:00Z')]),checkpoint=realizedCheckpoint(account,'2026-10-19T14:17:43Z',events);
 assert.equal(checkpoint.net,null);assert.equal(checkpoint.coverageIssues,1);assert.equal(checkpoint.afterNet,null);assert.equal(checkpoint.afterCoverageIssues,1);assert.equal(events[1].commissions,1.75);
 const unknown=realizedEvents('OTHER', [fill('1','Buy',1,100,1,'2026-10-19T15:00:00Z')]),costs=realizedCheckpoint('OTHER','2026-10-19T14:17:43Z',unknown);
 assert.equal(costs.afterNet,null);assert.equal(costs.afterCoverageIssues,undefined);
});
