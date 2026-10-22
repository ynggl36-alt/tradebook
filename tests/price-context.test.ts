import {test} from 'node:test';
import assert from 'node:assert/strict';
import {addDays} from '../lib/analytics';
import {parseTimestamp} from '../lib/csv';
import {contextLookbackStart,contextPriceRange,contextPriceRequests} from '../lib/context-range';
import {PRICE_RANGE_LIMIT} from '../lib/price-history';
import {matchPriceContext,preparePriceContext,priceContext} from '../lib/price-context';
import type {PriceBar} from '../lib/recorder';

const M=60000,DAY=86400000,contract='NQ 2026-12';
const chicago=(time:string)=>Date.parse(parseTimestamp(time,'America/Chicago'));
function bar(start:number,open=100,high=102,low=98,close=101,instrument=contract):PriceBar{
  return {id:instrument+'|'+start,contract:instrument,start,end:start+M,open,high,low,close,volume:10,capturedAt:start+M+10*DAY};
}
function session(source:string):PriceBar[]{
  const start=chicago(addDays(source,-1)+' 17:00:00');
  return Array.from({length:1380},(_,i)=>bar(start+i*M));
}
const sourceLevels=(context:ReturnType<typeof priceContext>,source:string)=>context.levels.filter(level=>level.source===source);

test('historical highs and lows require all 1,380 regular-session minutes from the exact contract',()=>{
  const prices=session('2026-10-19'),asOf=prices.at(-1)!.end;
  prices[500]=bar(prices[500].start,101,115,99,110);prices[1000]=bar(prices[1000].start,99,101,87,98);
  const full=priceContext(contract,asOf,prices),levels=sourceLevels(full,'2026-10-19');
  assert.deepEqual(levels.map(level=>[level.type,level.price]),[['session-open',100],['session-high',115],['session-low',87]]);
  assert.equal(levels[1].availableAt,asOf);assert.equal(full.sources.find(source=>source.source==='2026-10-19')!.status,'complete');
  for(const missing of [prices.slice(1),prices.slice(0,-1),prices.filter((_,i)=>i!==500),prices.map((p,i)=>i===500?{...p,contract:'MNQ 2026-12',id:'MNQ 2026-12|'+p.start}:p)]){
    const partial=priceContext(contract,asOf,missing);
    assert.ok(sourceLevels(partial,'2026-10-19').every(level=>level.type==='session-open'));
    assert.notEqual(partial.sources.find(source=>source.source==='2026-10-19')!.status,'complete');
  }
});

test('entry-minute and later prices cannot establish the current session high, low or open',()=>{
  const prices=session('2026-10-19'),start=prices[0].start,end=prices.at(-1)!.end;
  assert.equal(sourceLevels(priceContext(contract,start+59999,prices),'2026-10-19').length,0);
  const justOpen=sourceLevels(priceContext(contract,start+M,prices),'2026-10-19');
  assert.deepEqual(justOpen.map(level=>level.type),['session-open']);assert.equal(justOpen[0].availableAt,start+M);
  const beforeClose=priceContext(contract,end-1,prices);
  assert.deepEqual(sourceLevels(beforeClose,'2026-10-19').map(level=>level.type),['session-open']);
  const asOf=start+500*M+15000,base=priceContext(contract,asOf,prices);
  const changed=prices.map(p=>p.start>=Math.floor(asOf/M)*M?{...p,open:500,high:1000,low:1,close:900}:p).reverse();
  assert.deepEqual(priceContext(contract,asOf,changed),base);
  assert.deepEqual(priceContext(contract,asOf,prices.filter(p=>p.end<=Math.floor(asOf/M)*M)),base);
});

test('completed source sessions use Chicago boundaries across both DST changes',()=>{
  for(const [source,open,end] of [
    ['2026-03-06','2026-03-05T23:00:00Z','2026-03-06T22:00:00Z'],
    ['2026-03-09','2026-03-08T22:00:00Z','2026-03-09T21:00:00Z'],
    ['2026-10-30','2026-10-29T22:00:00Z','2026-10-30T21:00:00Z'],
    ['2026-11-02','2026-11-01T23:00:00Z','2026-11-02T22:00:00Z'],
  ]){
    const levels=sourceLevels(priceContext(contract,Date.parse(end),session(source)),source);
    assert.equal(levels.length,3);assert.equal(levels[0].start,Date.parse(open));assert.equal(levels[0].end,Date.parse(end));assert.equal(levels[0].end-levels[0].start,1380*M);
  }
});

test('weekends, daily closure bars and early closes cannot become invented full sessions',()=>{
  const prices=session('2026-10-19'),end=prices.at(-1)!.end;
  const extra=[bar(end,100,999,1,100),bar(chicago('2026-10-17 12:00:00'),100,999,1,100)];
  assert.deepEqual(priceContext(contract,end,prices.concat(extra)),priceContext(contract,end,prices));
  const early=priceContext(contract,end,prices.slice(0,1000)),source=early.sources.find(s=>s.source==='2026-10-19')!;
  assert.equal(source.status,'partial');assert.equal(source.observedBars,1000);assert.equal(source.expectedBars,1380);
  assert.ok(sourceLevels(early,'2026-10-19').every(level=>level.type==='session-open'));
  assert.ok(early.sources.every(s=>![0,6].includes(new Date(s.source+'T12:00:00Z').getUTCDay())));
});

test('newest source corrections win, while conflicting tied observations remain unavailable',()=>{
  const prices=session('2026-10-19'),asOf=prices.at(-1)!.end,correction={...prices[500],high:125,capturedAt:prices[500].capturedAt+1};
  const input=prices.concat(correction),expected=priceContext(contract,asOf,input);
  assert.equal(sourceLevels(expected,'2026-10-19').find(level=>level.type==='session-high')!.price,125);
  assert.deepEqual(priceContext(contract,asOf,input.slice().reverse()),expected);
  const tied={...correction,high:126},conflicted=priceContext(contract,asOf,input.concat(tied));
  assert.ok(sourceLevels(conflicted,'2026-10-19').every(level=>level.type==='session-open'));
  assert.deepEqual(priceContext(contract,asOf,input.concat(tied).reverse()),conflicted);
  const snapshot=structuredClone(input);preparePriceContext(input,contract);assert.deepEqual(input,snapshot);
});

test('older highs and prior lows coexist as location context without inferring intent',()=>{
  const older=session('2026-09-28'),prior=session('2026-10-19'),asOf=chicago('2026-10-20 09:00:00');
  older[100]=bar(older[100].start,101,130,99,110);prior[900]=bar(prior[900].start,100,101,83,99);
  const context=priceContext(contract,asOf,older.concat(prior));
  const high=matchPriceContext(context,129.5,1),low=matchPriceContext(context,83.25,.5);
  assert.equal(high.status,'partial');assert.ok(high.matches.some(match=>match.level.source==='2026-09-28'&&match.level.type==='session-high'));
  assert.ok(low.matches.some(match=>match.level.source==='2026-10-19'&&match.level.type==='session-low'));
  const noMatch=matchPriceContext(context,500,.5);assert.equal(noMatch.status,'partial');assert.deepEqual(noMatch.matches,[]);assert.ok(noMatch.nearest);
});

test('source coverage distinguishes missing history from a measured lack of proximity',()=>{
  const asOf=chicago('2026-10-20 09:00:00'),empty=priceContext(contract,asOf,[]);
  assert.equal(empty.status,'unavailable');assert.equal(matchPriceContext(empty,100,1).status,'unavailable');
  assert.ok(empty.sources.length>0);assert.ok(empty.sources.every(source=>source.status==='unavailable'));
  const all=empty.sources.flatMap(source=>session(source.source)),context=priceContext(contract,asOf,all);
  assert.equal(context.status,'complete');assert.equal(matchPriceContext(context,500,1).status,'measured');assert.deepEqual(matchPriceContext(context,500,1).matches,[]);
  assert.equal(matchPriceContext(context,null,1).reason,'missing-entry-fill');assert.equal(matchPriceContext(context,100,null).reason,'missing-tolerance');
  const foreign=preparePriceContext(all,'MNQ 2026-12');assert.equal(priceContext(contract,asOf,foreign).status,'unavailable');
});

test('preparing a shared archive never changes causal context or expands its 35-day scope',()=>{
  const asOf=chicago('2026-10-20 09:00:00'),old=session('2026-09-14'),prior=session('2026-10-19'),future=session('2026-10-21'),input=old.concat(prior,future);
  const result=priceContext(contract,asOf,input),prepared=preparePriceContext(input,contract);
  assert.deepEqual(priceContext(contract,asOf,prepared),result);
  assert.equal(result.lookbackStart,Math.floor(asOf/M)*M-35*DAY);
  assert.ok(result.levels.every(level=>level.start>=result.lookbackStart&&level.availableAt<=result.asOf));
  assert.ok(result.levels.every(level=>level.source!=='2026-09-14'&&level.source!=='2026-10-21'));assert.ok(result.levels.length<=105);
});

test('the exact 35-day edge includes a full source session and never substitutes a partial older one',()=>{
  const prices=session('2026-09-15'),asOf=prices[0].start+35*DAY;
  assert.equal(sourceLevels(priceContext(contract,asOf,prices),'2026-09-15').length,3);
  assert.equal(sourceLevels(priceContext(contract,asOf+M,prices),'2026-09-15').length,0);
  const malformed=prices.map((p,i)=>i===200?{...p,high:1}:p);
  assert.ok(sourceLevels(priceContext(contract,asOf,malformed),'2026-09-15').every(level=>level.type==='session-open'));
});

test('context ranges share exactly 35 entry days and bounded contiguous archive requests',()=>{
  const first='2026-10-07T15:03:23Z',last='2026-10-20T15:59:59Z',range=contextPriceRange([{entry:first},{entry:last}])!;
  assert.equal(range.start,contextLookbackStart(Date.parse(first)));assert.equal(range.end,Math.floor(Date.parse(last)/M)*M-M);assert.equal(range.lookbackDays,35);
  const requests=contextPriceRequests(range);assert.equal(requests[0].start,range.start);assert.equal(requests.at(-1)!.end,range.end);
  requests.forEach((request,i)=>{assert.ok(request.end-request.start<PRICE_RANGE_LIMIT);if(i)assert.equal(request.start,requests[i-1].end+M);});
  const chart=contextPriceRange([{entry:first,exit:'2026-10-07T15:10:42Z'}])!;
  assert.equal(chart.start,range.start);assert.equal(chart.end,Date.parse('2026-10-07T15:25:00Z'));
  assert.equal(contextPriceRange([]),null);assert.throws(()=>contextPriceRange([{entry:'invalid'}]));assert.throws(()=>contextPriceRange([{entry:last,exit:first}]));
  assert.throws(()=>contextPriceRequests({...range,start:range.start+1}));
});
