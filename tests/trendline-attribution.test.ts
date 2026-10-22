import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {PriceBar} from '../lib/recorder';
import {prepareTrends,scanTrends} from '../lib/trendlines';
import type {TrendEntry,TrendLine,TrendSnapshot} from '../lib/trendlines';
import {attributeTrendEntry,calibrationEntries} from '../lib/trendline-attribution';
import type {EntryStyle} from '../lib/trendline-attribution';
const start=Date.parse('2026-10-19T12:00:00Z'),M=60000,contract='NQ 2026-12';
function bar(i:number,o=108,h=109,l=107,c=108):PriceBar{return {id:contract+'|'+(start+i*M),contract,start:start+i*M,end:start+(i+1)*M,open:o,high:h,low:l,close:c,volume:10,capturedAt:start+(i+1)*M+10000000};}
function fixture(style:EntryStyle,resistance=false,prior=true){
  const prices=Array.from({length:120},(_,i)=>bar(i));for(const i of [10,20])prices[i]=bar(i,108,109,100,108);
  if(prior)prices[40]=bar(40,102,103,100.25,102);
  const put=(i:number,c:number)=>prices[i]=bar(i,c,c+.5,c-.5,c);
  if(style==='after-rejection'){
    [105,103,102].forEach((c,i)=>put(94+i,c));prices[97]=bar(97,102,103,100.25,100.4);put(98,101.5);put(99,101.6);
  }else [105,103,102].forEach((c,i)=>put(97+i,c));
  const entryPrice=style==='anticipatory'?100.8:style==='contact'?100.2:101.4;
  if(resistance)for(let i=0;i<prices.length;i++){const b=prices[i];prices[i]={...b,open:200-b.open,high:200-b.low,low:200-b.high,close:200-b.close};}
  const prepared=prepareTrends(prices,contract),at=start+100*M,base=scanTrends(prepared,at).snapshot;
  const line:TrendLine={id:contract+'|fixture|wick',family:contract+'|fixture',minutes:5,polarity:resistance?'resistance':'support',style:'wick',a:{time:start+10.5*M,price:100,edge:'wick',impulse:false,availableAt:start+13*M},b:{time:start+20.5*M,price:100,edge:'wick',impulse:false,availableAt:start+30*M},availableAt:start+30*M,asOf:at,value:100,slope:0,touches:999,wickTouches:999,bodyTouches:0,broken:false,score:100,segmentStart:start,segmentEnd:at};
  const snapshot:TrendSnapshot={...base,lines:[line]},entry:TrendEntry={id:'synthetic',account:'TEST',contract,entry:new Date(at+15000).toISOString(),entryPrice:resistance?200-entryPrice:entryPrice,dir:resistance?'Short':'Long',gross:100,net:95};
  return {prices,prepared,snapshot,line,entry};
}
function result(f:ReturnType<typeof fixture>){return attributeTrendEntry(f.entry,f.snapshot,f.prepared);}

test('all three entry styles are recognized symmetrically without giving anticipation confirmed timing',()=>{
  for(const style of ['anticipatory','contact','after-rejection'] as const)for(const resistance of [false,true]){
    const r=result(fixture(style,resistance));assert.equal(r.style,style,style+' resistance='+resistance);assert.equal(r.status,'matched');
    assert.equal(r.confidence,style==='anticipatory'?'possible':'strong');assert.equal(r.match!.priorTests,1);
    if(style==='anticipatory')assert.ok(r.reasons.includes('inferred-timing'));
    if(style==='contact')assert.ok(r.reasons.includes('intraminute-unknown'));
  }
});

test('only a distinct completed later candle can establish a pre-entry rejection',()=>{
  const f=fixture('after-rejection'),r=result(f);assert.ok(r.match!.contactAt!==null&&r.match!.rejectedAt!==null);
  assert.ok(r.match!.rejectedAt!>=r.match!.contactAt!+2*M);
  f.prices[98]=bar(98,100.2,101,99.8,100.2);f.prices[99]=bar(99,100.2,101,99.8,100.2);f.prepared=prepareTrends(f.prices,contract);
  assert.notEqual(result(f).style,'after-rejection');
});

test('a later recontact supersedes an older completed reaction',()=>{
  const f=fixture('after-rejection');f.prices[99]=bar(99,101.5,102,100.25,100.4);f.prepared=prepareTrends(f.prices,contract);
  assert.notEqual(result(f).style,'after-rejection');
});

test('future OHLC, completed-trade outcomes and later scale-in prices cannot improve attribution',()=>{
  for(const style of ['anticipatory','contact','after-rejection'] as const){
    const f=fixture(style),before=result(f),cutoff=f.snapshot.asOf;
    f.prices=f.prices.map(b=>b.start>=cutoff?{...b,open:500,high:1000,low:1,close:900,capturedAt:b.capturedAt+1}:b).reverse();f.prepared=prepareTrends(f.prices,contract);f.entry={...f.entry,gross:-90000,net:null};
    assert.deepEqual(result(f),before);
  }
});

test('the current setup contact cannot count as an earlier independent line test',()=>{
  for(const style of ['contact','after-rejection'] as const){const f=fixture(style,false,false),r=result(f);assert.equal(f.line.touches,999);assert.equal(r.match,null);assert.equal(r.status,'near-only');assert.ok(r.reasons.includes('weak-structure'));}
});

test('line availability must precede the interaction and its approach for stronger evidence',()=>{
  const f=fixture('after-rejection');f.line.availableAt=start+98*M;assert.notEqual(result(f).style,'after-rejection');
  const contact=fixture('contact');contact.line.availableAt=start+99*M;const r=result(contact);assert.equal(r.style,null);assert.equal(r.status,'near-only');assert.ok(r.reasons.includes('weak-structure'));
  contact.line.availableAt=contact.snapshot.asOf+1;assert.equal(result(contact).status,'unclassified');
});

test('wrong polarity, foreign contract and malformed direction do not become bounce matches',()=>{
  const f=fixture('contact');f.entry.dir='Short';assert.equal(result(f).status,'unclassified');
  f.entry.dir=undefined;assert.equal(result(f).status,'unavailable');assert.deepEqual(result(f).reasons,['missing-direction']);
  f.entry.dir='Long';f.line.family='MES 2026-12|foreign';assert.equal(result(f).status,'unclassified');
});

test('missing first fill, missing minute, stale cutoff and foreign price stream fail closed',()=>{
  const f=fixture('contact');assert.equal(attributeTrendEntry({...f.entry,entryPrice:null},f.snapshot,f.prepared).status,'unavailable');
  const missing=prepareTrends(f.prices.filter(b=>b.start!==start+95*M),contract);assert.equal(attributeTrendEntry(f.entry,f.snapshot,missing).status,'unavailable');
  assert.equal(attributeTrendEntry(f.entry,{...f.snapshot,asOf:f.snapshot.asOf-M},f.prepared).status,'unavailable');
  assert.equal(attributeTrendEntry(f.entry,f.snapshot,{...f.prepared,contract:'MNQ 2026-12'}).status,'unavailable');
});

test('duplicating or adding equivalent paths does not create independent votes or stronger confidence',()=>{
  const f=fixture('anticipatory'),base=result(f);f.snapshot.lines=[f.line,{...f.line,id:'duplicate-1',family:contract+'|other',style:'body'},{...f.line,id:'duplicate-2',minutes:5,style:'mixed'}];
  const r=result(f);assert.equal(r.families,1);assert.equal(r.confidence,base.confidence);assert.equal(r.style,base.style);assert.equal(r.match!.equivalentLineIds.length,3);assert.deepEqual([...r.match!.anchorStyles].sort(),['body','mixed','wick']);
  f.snapshot.lines.reverse();assert.deepEqual(result(f),r);
});

test('an unvalidated alternative timing does not win a candidate vote',()=>{
  const f=fixture('after-rejection'),other={...f.line,id:contract+'|different',family:contract+'|different',a:{...f.line.a,price:100.9},b:{...f.line.b,price:100.9},value:100.9};
  f.snapshot.lines.push(other);const r=result(f);assert.equal(r.style,'after-rejection');assert.equal(r.ambiguous,false);assert.equal(r.confidence,'strong');
});

test('flat proximity without a directional approach stays near-only',()=>{
  const f=fixture('anticipatory');for(let i=97;i<100;i++)f.prices[i]=bar(i,102,102.5,101.5,102);f.prepared=prepareTrends(f.prices,contract);
  const r=result(f);assert.equal(r.status,'near-only');assert.equal(r.style,null);
});

test('calibration selection is outcome-blind, deterministic and deduplicates contract/minute observations',()=>{
  const f=fixture('contact'),attr=result(f);
  const rows=Array.from({length:40},(_,i)=>({...f.entry,id:'review-'+i,entry:new Date(start+(100+i)*M+15000).toISOString(),status:'measured' as const,group:'both' as const,mixed:false,impulse:false,confirmedNear:1,candidateNear:1,nearest:0,lineIds:[],snapshot:f.snapshot,attribution:attr}));
  const first=calibrationEntries(rows),changed=calibrationEntries(rows.map(r=>({...r,gross:-99999,net:null})).reverse());
  assert.equal(first.length,15);assert.deepEqual(changed.map(r=>r.id),first.map(r=>r.id));
  const duplicates=calibrationEntries(rows.flatMap(r=>[r,{...r,id:r.id+'duplicate',account:'OTHER'}]));
  assert.equal(new Set(duplicates.map(r=>r.contract+'|'+Math.floor(Date.parse(r.entry)/M))).size,duplicates.length);
});

test('a materially sloping contact minute cannot produce stronger rejection evidence',()=>{
  const f=fixture('after-rejection'),slope=.75/M,at=f.snapshot.asOf;
  f.prices=f.prices.map(b=>{const shift=slope*((b.start+b.end)/2-at);return {...b,open:b.open+shift,high:b.high+shift,low:b.low+shift,close:b.close+shift};});
  f.line.a.price+=slope*(f.line.a.time-at);f.line.b.price+=slope*(f.line.b.time-at);f.line.slope=slope;f.entry.entryPrice!+=slope*(Date.parse(f.entry.entry)-at);f.prepared=prepareTrends(f.prices,contract);
  const r=result(f);assert.equal(r.status,'near-only');assert.equal(r.match,null);assert.ok(r.reasons.includes('weak-structure'));
});

test('steep prior timeframe candles cannot invent independent validation for a contact-price fill',()=>{
  const f=fixture('contact'),slope=5/M,at=f.snapshot.asOf;
  f.prices=f.prices.map(b=>({...b,open:b.open+1000,high:b.high+1000,low:b.low+1000,close:b.close+1000}));f.prepared=prepareTrends(f.prices,contract);
  f.line.a.price=1100+slope*(f.line.a.time-at);f.line.b.price=1100+slope*(f.line.b.time-at);f.line.slope=slope;
  // Anchor history is irrelevant to this isolated evidence test. Add a prior
  // midpoint-aligned edge whose bar spans far more than the allowed tolerance.
  f.line.minutes=5;const five=f.prepared.streams.find(s=>s.minutes===5)!;
  const prior=five.bars.find(b=>b.start===start+40*M)!;prior.low=1100+slope*((prior.start+prior.end)/2-at);prior.atr=2;
  f.entry.entryPrice=1100+slope*(Date.parse(f.entry.entry)-at)+.2;
  const r=result(f);assert.equal(r.style,null);assert.equal(r.match,null);assert.equal(r.status,'near-only');
});

test('availability at the contact-bar start cannot replace earlier independent validation',()=>{
  const f=fixture('after-rejection');f.line.availableAt=start+97*M;assert.equal(result(f).status,'near-only');
  f.line.availableAt++;assert.notEqual(result(f).style,'after-rejection');
  const c=fixture('contact');c.line.availableAt=c.snapshot.asOf;const r=result(c);assert.equal(r.style,null);assert.equal(r.status,'near-only');assert.ok(r.reasons.includes('weak-structure'));
});

test('an entry beyond the wrong side of the contact band is not a bounce attribution',()=>{
  for(const resistance of [false,true]){const f=fixture('contact',resistance);f.entry.entryPrice=resistance?102:98;assert.equal(result(f).status,'unclassified');}
});

test('a recent wrong-side one-minute close prevents a bounce label even when higher-timeframe geometry is intact',()=>{
  for(const style of ['contact','after-rejection'] as const){const f=fixture(style);f.line.minutes=5;f.prices[95]=bar(95,101,102,98,99);f.prepared=prepareTrends(f.prices,contract);const r=result(f);assert.notEqual(r.status,'matched');assert.ok(r.reasons.includes('recent-break'));}
});

test('equivalent paths retain conflicting equally strong timing labels within their single family',()=>{
  const f=fixture('after-rejection');for(const [i,c] of [[93,105],[94,103],[95,102],[97,102],[98,101.6],[99,101.3]])f.prices[i]=bar(i,c,c+.5,c-.5,c);
  f.prices[96]=bar(96,102,103,100.1,100.2);f.prepared=prepareTrends(f.prices,contract);f.entry.entryPrice=100.7;
  const other={...f.line,id:contract+'|body-variant',style:'body' as const,a:{...f.line.a,price:100.3},b:{...f.line.b,price:100.3},value:100.3};
  assert.equal(result(f).style,'after-rejection');assert.equal(result(f).confidence,'strong');
  assert.equal(attributeTrendEntry(f.entry,{...f.snapshot,lines:[other]},f.prepared).style,'contact');
  assert.equal(attributeTrendEntry(f.entry,{...f.snapshot,lines:[other]},f.prepared).confidence,'strong');
  f.snapshot.lines.push(other);const r=result(f);assert.equal(r.families,1);assert.equal(r.ambiguous,true);assert.equal(r.confidence,'possible');assert.deepEqual(r.alternativeStyles,['contact']);assert.ok(r.alternatives.some(a=>a.style==='contact'));
});


test('a flipped formation retest and its adjacent continuation cannot validate their own new role',()=>{
 const f=fixture('contact');
 for(let i=40;i<50;i++)f.prices[i]=bar(i,102,103,100.25,102);
 f.prepared=prepareTrends(f.prices,contract);f.line.availableAt=start+45*M;
 f.line.flip={from:'resistance',formationAt:start+20*M,breakAt:start+35*M,retestAt:start+40*M,confirmedAt:start+45*M};
 const r=result(f);assert.equal(r.status,'near-only');assert.equal(r.match,null);
});

test('a weak secondary edge needs two independent tests before this approach, with separate validation availability',()=>{
 const f=fixture('contact');f.line.structureBasis='tested-continuation';f.line.structureAt=start+45*M;
 assert.equal(result(f).status,'near-only');
 f.prices[65]=bar(65,102,103,100.25,102);f.prepared=prepareTrends(f.prices,contract);
 const ready=result(f);assert.equal(ready.status,'matched');assert.equal(ready.match!.priorTests,2);
 f.line.structureAt=start+99*M;assert.equal(result(f).status,'near-only');
});

test('an impulse B and its continuing contacts cannot supply their own independent test',()=>{
 const f=fixture('contact',false,false);f.line.b.time=start+22.5*M;f.line.b.impulse=true;f.line.availableAt=start+25*M;f.line.structureBasis='impulse-continuation';
 for(let i=20;i<35;i++)f.prices[i]=bar(i,102,103,100.25,102);
 f.prepared=prepareTrends(f.prices,contract);
 assert.equal(result(f).status,'near-only');assert.equal(result(f).match,null);
 // Two fully separated source bars precede a genuine return.
 f.prices[50]=bar(50,102,103,100.25,102);f.prepared=prepareTrends(f.prices,contract);
 const returned=result(f);assert.equal(returned.status,'matched');assert.equal(returned.match!.priorTests,1);
});
