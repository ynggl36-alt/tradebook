import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executionLedger,journalExecutionLedger} from '../lib/execution-ledger';
import {mergeFills,reconstruct} from '../lib/reconstruct';
import {aggregateRealized,realizedEvents,summarizeRealized,realizedCheckpoint} from '../lib/realized';
import {centralDay,round} from '../lib/analytics';
import type {Fill} from '../lib/types';

const account='LFF-UNIFIED-SYNTHETIC';
const fill=(id:string,side:'Buy'|'Sell',qty:number,price:number,pos:number|null,minute:number):Fill=>({id,side,qty,price,pos,ordinal:minute,time:new Date(Date.UTC(2026,9,20,14,minute)).toISOString(),contract:'MNQ 2026-12',symbol:'MNQ',pv:2});

test('contradictory position metadata never creates inventory or discards completed executions',async()=>{
 const fills=[fill('a','Buy',3,100,3,0),fill('b','Sell',3,110,0,1),fill('c','Buy',3,100,5,2),fill('d','Sell',1,105,4,3),fill('e','Sell',2,110,2,4)],original=JSON.stringify(fills);
 const ledger=executionLedger(fills),history=await reconstruct(account,fills,ledger),total=summarizeRealized(aggregateRealized(realizedEvents(account,fills,ledger)));
 assert.equal(history.trades.length,2);assert.equal(history.issues.length,0);assert.equal(ledger.positionConflicts.length,3);
 assert.equal(total.gross,110);assert.equal(total.gross,history.trades.reduce((sum,trade)=>sum+trade.pnl,0));assert.equal(total.unmatched,0);assert.equal(total.coverageIssues,0);assert.equal(total.net,104);
 assert.equal(JSON.stringify(fills),original);
 const clean=fills.map((value,index)=>({...value,pos:[3,0,3,2,0][index]}));
 assert.deepEqual((await reconstruct(account,clean)).trades,history.trades);
 assert.deepEqual(realizedEvents(account,clean).map(({positionConflict:_,...event})=>event),realizedEvents(account,fills).map(({positionConflict:_,...event})=>event));
});

test('same-day flat episodes reconcile to signed cash flow under partial exits, scaling, reversals and tied timestamps',async()=>{
 // Deterministic independent cash-flow oracle; metadata is deliberately wrong
 // after the first known-flat entry. Every generated day closes exactly flat.
 let seed=17;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;};
 for(let day=1;day<=12;day++){
  const fills:Fill[]=[];let position=0;
  const add=(side:'Buy'|'Sell',qty:number)=>{position+=side==='Buy'?qty:-qty;const i=fills.length;fills.push({...fill(String(i),side,qty,100+random()%80/4,i===0?position:position+7,i),time:new Date(Date.UTC(2026,9,day,14,Math.floor(i/3))).toISOString()});};
  add('Buy',2);
  for(let step=0;step<50;step++)add(random()%2?'Buy':'Sell',1+random()%4);
  if(position)add(position>0?'Sell':'Buy',Math.abs(position));
  const original=JSON.stringify(fills),ledger=executionLedger([...fills].reverse()),history=await reconstruct(account,fills,ledger),events=realizedEvents(account,fills,ledger),gross=round(fills.reduce((sum,f)=>sum+(f.side==='Sell'?1:-1)*f.qty*f.price*f.pv,0));
  assert.equal(history.issues.length,0);assert.equal(summarizeRealized(aggregateRealized(events)).gross,gross);
  assert.equal(round(history.trades.reduce((sum,t)=>sum+t.pnl,0)),gross);assert.equal(new Set(events.map(e=>centralDay(e.time))).size,1);
  const allocated=new Map<string,number>();for(const trade of history.trades)for(const [id,qty]of trade.parts!)allocated.set(id,(allocated.get(id)||0)+qty);
  for(const f of fills)assert.equal(allocated.get(f.id),f.qty,'Every contract allocated once');
  assert.equal(JSON.stringify(fills),original);assert.deepEqual((await reconstruct(account,fills)).trades,history.trades);
 }
});

test('a missing opening basis is retained as unknown and later clean episodes recover without fake entry prices',async()=>{
 const fills=[fill('a','Sell',2,110,1,0),fill('b','Sell',1,112,0,1),fill('c','Buy',2,100,2,2),fill('d','Sell',2,105,0,3)],ledger=executionLedger(fills),history=await reconstruct(account,fills,ledger),events=realizedEvents(account,fills,ledger);
 assert.equal(events[0].unmatched,2);assert.equal(events[1].unmatched,1);assert.equal(events[0].gross,0);assert.equal(history.trades.length,1);assert.equal(history.trades[0].pnl,20);assert.equal(history.issues.length,1);
 assert.equal(summarizeRealized(aggregateRealized(events)).net,null);
});

test('later exit labels cannot discard economic quantities, and an unbalanced final flat claim stays incomplete',async()=>{
 const fills=[fill('a','Buy',1,100,1,0),fill('b','Sell',1,110,0,1),{...fill('missing','Sell',1,120,0,2),entryFlag:false},fill('c','Buy',1,130,1,3),fill('d','Sell',1,140,0,4)];
 const history=await reconstruct(account,fills),events=realizedEvents(account,fills);
 assert.deepEqual(history.trades.map(t=>[t.dir,t.pnl]),[['Long',20],['Short',-20]]);
 assert.equal(events[2].unmatched,0);assert.equal(events[2].entryFlagConflict,true);assert.equal(events.at(-1)!.coverageIssues,1);assert.equal(history.issues.length,1);
 assert.equal(summarizeRealized(aggregateRealized(events)).net,null);
});

test('balanced entries with contradictory exit labels conserve every real contract and agree with signed cash flow',async()=>{
 const fills=[fill('a','Buy',2,100,2,0),fill('b','Sell',2,110,0,1),{...fill('c','Sell',3,120,4,2),entryFlag:false},{...fill('d','Buy',1,115,null,3),entryFlag:false},{...fill('e','Buy',2,105,0,4),entryFlag:false}],original=JSON.stringify(fills);
 const ledger=journalExecutionLedger(fills,Date.parse('2026-10-21T00:00:00Z')),history=await reconstruct(account,fills,ledger),events=realizedEvents(account,fills,ledger),gross=round(fills.reduce((sum,f)=>sum+(f.side==='Sell'?1:-1)*f.qty*f.price*f.pv,0));
 assert.equal(ledger.issues.length,0);assert.equal(history.trades.length,2);assert.equal(history.trades.reduce((sum,t)=>sum+t.pnl,0),gross);assert.equal(summarizeRealized(aggregateRealized(events)).gross,gross);
 assert.equal(events.filter(e=>e.entryFlagConflict).length,1);assert.equal(events.filter(e=>e.unmatched||e.coverageIssues||e.coverageGapAt).length,0);
 const allocated=new Map<string,number>();for(const trade of history.trades)for(const [id,qty]of trade.parts!)allocated.set(id,(allocated.get(id)||0)+qty);
 for(const f of fills)assert.equal(allocated.get(f.id),f.qty);assert.equal(JSON.stringify(fills),original);
 const firstExit={...fill('first','Sell',1,100,null,0),entryFlag:false},unknown=realizedEvents(account,[firstExit]);assert.equal(unknown[0].unmatched,1);assert.equal(unknown[0].net,null);
});

test('intraday journal isolates a missing close while continuous overnight use remains explicit',async()=>{
 const old={...fill('old','Buy',2,100,2,0),time:'2026-10-19T14:00:00Z'},fresh=[{...fill('new','Buy',2,200,2,0),time:'2026-10-20T14:00:00Z'},{...fill('close','Sell',2,210,0,1),time:'2026-10-20T14:01:00Z'}],fills=[old,...fresh],asOf=Date.parse('2026-10-20T15:00:00Z');
 const ledger=journalExecutionLedger(fills,asOf),events=realizedEvents(account,fills,ledger),days=aggregateRealized(events,'session');
 assert.equal(days.find(row=>row.day==='2026-10-20')!.gross,40);assert.equal(days.find(row=>row.day==='2026-10-20')!.net,38);
 assert.equal(days.find(row=>row.day==='2026-10-19')!.net,null);assert.equal(days.find(row=>row.day==='2026-10-19')!.coverageIssues,1);
 assert.equal((await reconstruct(account,fills,ledger)).trades.length,1);assert.match(ledger.issues[0].reason,/Missing close/);
 assert.equal(executionLedger(fills).events.reduce((sum,event)=>sum+event.gross,0),440);
});
test('current open inventory expires at the session boundary without retroactively changing economic fill values',()=>{
 const fills=[{...fill('open','Buy',2,100,2,0),time:'2026-10-20T14:00:00Z'}],before=journalExecutionLedger(fills,Date.parse('2026-10-20T21:59:59Z')),after=journalExecutionLedger(fills,Date.parse('2026-10-20T22:00:00Z'));
 assert.equal(before.nextUpdateAt,Date.parse('2026-10-20T22:00:00Z'));assert.equal(after.nextUpdateAt,undefined);
 const early=realizedEvents(account,fills,before),late=realizedEvents(account,fills,after);
 assert.equal(aggregateRealized(early)[0].net,-1);assert.equal(aggregateRealized(late)[0].net,null);assert.equal(late[0].net,-1);assert.equal(late[0].gross,0);assert.equal(late[0].coverageGapAt,'2026-10-20T22:00:00.000Z');
 const point=realizedCheckpoint(account,'2026-10-20T14:30:00Z',late);assert.equal(point.net,-1);assert.equal(point.afterNet,null);assert.equal(point.afterCoverageIssues,1);
});
test('a later session gap cannot contaminate a clean earlier checkpoint and missing opening inventory stays unknown',()=>{
 const fills=[{...fill('a','Buy',1,100,1,0),time:'2026-10-20T14:00:00Z'},{...fill('b','Sell',1,110,0,1),time:'2026-10-20T14:01:00Z'},{...fill('orphan','Sell',2,120,0,2),time:'2026-10-27T14:00:00Z'},{...fill('tail','Buy',1,130,1,3),time:'2026-10-28T14:00:00Z'}];
 const ledger=journalExecutionLedger(fills,Date.parse('2026-10-29T16:00:00Z')),events=realizedEvents(account,fills,ledger);
 const checkpoint=realizedCheckpoint(account,'2026-10-20T14:00:30Z',events);assert.equal(checkpoint.net,-.5);assert.equal(checkpoint.afterNet,19.5);assert.equal(checkpoint.afterCoverageIssues,undefined);
 assert.equal(events.find(event=>event.fillId==='orphan')!.unmatched,2);assert.equal(aggregateRealized(events,'session').find(row=>row.day==='2026-10-27')!.net,null);
});
test('intraday grouping follows Chicago sessions across midnight and both DST offsets',()=>{
 for(const [entry,exit,boundary]of [['2026-10-20T23:30:00Z','2026-10-21T05:30:00Z','2026-10-21T22:00:00Z'],['2026-11-02T23:30:00Z','2026-11-03T06:30:00Z','2026-11-03T23:00:00Z']]){
  const fills=[{...fill('a','Buy',1,100,1,0),time:entry},{...fill('b','Sell',1,110,0,1),time:exit}],ledger=journalExecutionLedger(fills,Date.parse(boundary));
  assert.equal(ledger.episodes.length,1);assert.equal(ledger.episodes[0].pnl,20);assert.equal(ledger.issues.length,0);
  assert.equal(journalExecutionLedger(fills.slice(0,1),Date.parse(exit)).nextUpdateAt,Date.parse(boundary));
 }
});
test('capture sequence survives partial import and backfill while preserving original fill ordinals',async()=>{
 const at='2026-10-20T14:00:00Z',fills=[{...fill('a','Buy',1,100,1,1),time:at,sourceSequence:1},{...fill('b','Sell',1,110,0,2),time:at,sourceSequence:2},{...fill('c','Buy',1,120,1,3),time:at,sourceSequence:3},{...fill('d','Sell',1,130,0,4),sourceSequence:4}];
 const partial=mergeFills([],[fills[0],fills[2],fills[3]]),backfill=mergeFills(partial.fills,fills),expected=await reconstruct(account,fills),actual=await reconstruct(account,backfill.fills);
 assert.deepEqual(actual.trades,expected.trades);assert.deepEqual(actual.trades.map(t=>t.pnl),[20,20]);assert.equal(backfill.fills.find(f=>f.id==='c')!.ordinal,2);
 const legacy=partial.fills.map(({sourceSequence:_,...f})=>f),enriched=mergeFills(legacy,[fills[0],fills[2],fills[3]]);assert.equal(enriched.updated,3);assert.deepEqual(enriched.fills.map(f=>f.ordinal),legacy.map(f=>f.ordinal));
});

test('partial source-order enrichment cannot reorder trades while the tied group remains unresolved',async()=>{
 const fills=[fill('a','Buy',1,100,1,1),fill('b','Sell',1,110,0,2),fill('c','Buy',1,120,1,3),fill('d','Sell',1,110,0,4)].map(f=>({...f,time:'2026-10-20T14:00:00Z'}));
 const before=await reconstruct(account,fills),mixed=await reconstruct(account,fills.map(f=>f.id==='b'?{...f,sourceSequence:100}:f));assert.deepEqual(mixed.trades,before.trades);
});
