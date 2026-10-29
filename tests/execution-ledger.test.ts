import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executionLedger} from '../lib/execution-ledger';
import {reconstruct} from '../lib/reconstruct';
import {aggregateRealized,realizedEvents,summarizeRealized} from '../lib/realized';
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

test('an explicit exit after flat cannot become a synthetic short or consume the next real entry',async()=>{
 const fills=[fill('a','Buy',1,100,1,0),fill('b','Sell',1,110,0,1),{...fill('missing','Sell',1,120,0,2),entryFlag:false},fill('c','Buy',1,130,1,3),fill('d','Sell',1,140,0,4)];
 const history=await reconstruct(account,fills),events=realizedEvents(account,fills);
 assert.deepEqual(history.trades.map(t=>[t.dir,t.pnl]),[['Long',20],['Long',20]]);
 assert.equal(events[2].unmatched,1);assert.equal(events[2].net,null);assert.equal(history.issues.length,1);
});
