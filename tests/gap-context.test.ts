import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Fill,Trade} from '../lib/types';
import type {PriceBar} from '../lib/recorder';
import {entryPriceRange,firstEntryFill,measureGapEntry,summarizeGapContexts} from '../lib/gap-context';
import {weeklyBoundaries} from '../lib/weekly-gaps';

const entry='2026-10-20T15:00:30.123456Z',contract='NQ 2026-12',asOf=Date.parse(entry);
const boundary=weeklyBoundaries(asOf).find(b=>b.sunday==='2026-10-18')!;
function candle(start:number,open=112,close=open,high=Math.max(open,close)+1,low=Math.min(open,close)-1):PriceBar{
  return {id:contract+'|'+start,contract,start,end:start+60000,open,close,high,low,volume:10,capturedAt:asOf+600000};
}
function fixture(price=111){
  const fills:Fill[]=[{id:'first',contract,symbol:'NQ',pv:20,time:entry,ordinal:1,side:'Buy',qty:1,price,pos:1}];
  const trade:Trade={id:'T-GAP-LOCATION',account:'LFF-GAP-SYNTHETIC',contract,symbol:'NQ',dir:'Long',entry,exit:'2026-10-20T15:10:00Z',qty:1,maxQty:1,avgEntry:price,avgExit:price+1,pnl:20,exitOrder:2,parts:[['first',1,price,'Buy'],['exit',1,price+1,'Sell']]};
  const range=entryPriceRange(entry),prices=[candle(boundary.fridayCloseAt-60000,100),candle(boundary.sundayOpenAt,110),...Array.from({length:20},(_,i)=>candle(range.start+i*60000))];
  return {trade,fills,prices};
}
test('first-entry context uses its actual allocation rather than average entry or a later scale-in',()=>{
  const {trade,fills,prices}=fixture();
  fills.push({...fills[0],id:'scale',price:130,qty:3,time:'2026-10-20T15:02:00Z',ordinal:3});
  trade.parts!.splice(1,0,['scale',3,130,'Buy']);trade.qty=4;trade.avgEntry=125.25;
  const result=measureGapEntry(trade,fills,prices);assert.equal(result.entryPrice,111);assert.deepEqual(result.tags,['near-edge']);assert.equal(result.net,6);
  assert.equal(result.atr,2);assert.equal(result.tolerance,1);assert.equal(result.nearest!.distance,1);
});
test('missing or mismatched first fill stays unknown even with a same-clock matching scale-in',()=>{
  const {trade,fills,prices}=fixture();
  const later={...fills[0],id:'scale',price:110,ordinal:2};trade.parts!.splice(1,0,['scale',1,110,'Buy']);
  for(const source of [[later],[{...fills[0],price:112},later],[{...fills[0],contract:'MNQ 2026-12'},later],[{...fills[0],time:'2026-10-20T15:00:30.123457Z'},later]]){
    const result=measureGapEntry(trade,source,prices);assert.equal(result.status,'missing-entry-fill');assert.equal(result.entryPrice,null);assert.deepEqual(result.tags,[]);
  }
  const malformed={...trade,parts:[['first',1,111,'Sell']] as Trade['parts']};assert.equal(firstEntryFill(malformed,fills),null);
});
test('reversal entries use their opening allocation while retaining sub-millisecond timestamp identity',()=>{
  const {trade,fills}=fixture();trade.dir='Short';trade.parts=[['first',2,111,'Sell']];fills[0]={...fills[0],side:'Sell',qty:5,pos:-2};
  assert.equal(firstEntryFill(trade,fills)!.price,111);
  const exact={...fills[0],time:entry.replace('123456','123456000')};assert.equal(firstEntryFill(trade,[exact]),exact);
  assert.equal(firstEntryFill(trade,[{...exact,qty:1}]),null);
});
test('forming entry minute, later candles and outcomes cannot change location labels',()=>{
  const {trade,fills,prices}=fixture(105),range=entryPriceRange(entry);
  assert.equal(range.end,Date.parse('2026-10-20T15:00:00Z'));
  const original=measureGapEntry(trade,fills,prices),changed=measureGapEntry({...trade,pnl:-20000,avgExit:10},fills,[...prices,candle(range.end,105,105,10000,1),candle(range.end+60000,10,10,20000,1)]);
  const location=({gross:_,net:__,...rest}:ReturnType<typeof measureGapEntry>)=>rest;
  assert.deepEqual(location(changed),location(original));assert.deepEqual(original.tags,['near-midpoint','inside-zone']);assert.equal(original.preEntryBars,20);
});
test('twenty unique completed minutes from the exact contract are required for volatility-scaled context',()=>{
  const {trade,fills,prices}=fixture(),last=prices.at(-1)!;
  for(const replacement of [undefined,{...last,contract:'NQ 2027-03'},{...last,start:last.start+1,end:last.end+1},{...last,low:NaN}]){
    const result=measureGapEntry(trade,fills,[...prices.slice(0,-1),...(replacement?[replacement]:[]),prices[2]]);assert.equal(result.status,'insufficient-prices');assert.equal(result.preEntryBars,19);assert.deepEqual(result.tags,[]);assert.equal(result.tolerance,null);
  }
  assert.equal(measureGapEntry(trade,fills,[...prices,last]).preEntryBars,20);
});
test('ATR includes close-to-next-range jumps and proximity has an explicit quarter-ATR/four-tick threshold',()=>{
  const {trade,fills,prices}=fixture(109),start=prices.length-15;
  const before=prices.map((b,i)=>i<start?b:candle(b.start,i===start?200:220));
  const measured=measureGapEntry(trade,fills,before);
  assert.equal(measured.atr,(21+13*2)/14);assert.equal(measured.tolerance,1);
  const wide=prices.map((b,i)=>i<2?b:candle(b.start,112,112,120,104));
  assert.equal(measureGapEntry(trade,fills,wide).tolerance,4);
  const flat=prices.map((b,i)=>i<2?b:candle(b.start,112,112,112,112));const zero=measureGapEntry(trade,fills,flat);assert.equal(zero.tolerance,1);assert.equal(zero.nearest!.atrDistance,null);
});
test('missing weekly boundaries and observed zero gaps remain distinct from a location with no recorded match',()=>{
  const {trade,fills,prices}=fixture(120),known=measureGapEntry(trade,fills,prices);
  assert.equal(known.status,'measured');assert.deepEqual(known.tags,[]);assert.equal(known.knownGaps,1);assert.equal(known.unavailableWeeks,known.checkedWeeks-1);
  const missing=measureGapEntry(trade,fills,prices.slice(1));assert.equal(missing.status,'no-known-gaps');assert.equal(missing.unavailableWeeks,missing.checkedWeeks);assert.equal(missing.noGapWeeks,0);
  const zero=measureGapEntry(trade,fills,[prices[0],{...prices[1],open:100},...prices.slice(2)]);assert.equal(zero.status,'no-known-gaps');assert.equal(zero.noGapWeeks,1);assert.equal(zero.unavailableWeeks,zero.checkedWeeks-1);
  const wrong=measureGapEntry(trade,fills,[{...prices[0],contract:'MNQ 2026-12'},...prices.slice(1)]);assert.equal(wrong.knownGaps,0);
});
test('proximity and inside-zone descriptions overlap without declaring a strategy or using trade direction',()=>{
  const f=fixture(110),long=measureGapEntry(f.trade,f.fills,f.prices);
  const short=measureGapEntry({...f.trade,dir:'Short',parts:[['first',1,110,'Sell']]},[{...f.fills[0],side:'Sell'}],f.prices);
  assert.deepEqual(long.tags,['near-edge','inside-zone']);assert.deepEqual(short.tags,long.tags);
  const inside=fixture(107);assert.deepEqual(measureGapEntry(inside.trade,inside.fills,inside.prices).tags,['inside-zone']);
  const sum=summarizeGapContexts([long]);assert.equal(sum.find(g=>g.id==='measured')!.count,1);assert.equal(sum.find(g=>g.id==='near-edge')!.count,1);assert.equal(sum.find(g=>g.id==='inside-zone')!.count,1);
});
test('unknown commissions never silently turn gross results into net sample statistics, and days use Central time',()=>{
  const f=fixture(105),a=measureGapEntry(f.trade,f.fills,f.prices),unknown={...a,id:'unknown',account:'OTHER-SYNTHETIC',net:null};
  const group=summarizeGapContexts([a,unknown]).find(g=>g.id==='near-midpoint')!;
  assert.equal(group.count,2);assert.equal(group.netKnown,1);assert.equal(group.netUnknown,1);assert.equal(group.net,null);assert.equal(group.average,null);assert.equal(group.winRate,null);
  const sameCentral=summarizeGapContexts([{...a,entry:'2026-10-20T23:30:00Z'},{...a,id:'later',entry:'2026-10-21T00:30:00Z',net:0}])[0];assert.equal(sameCentral.days,1);assert.equal(sameCentral.winRate,.5);
});
test('non-finite volatility cannot produce an infinite tolerance and false proximity',()=>{
  const f=fixture(105),extreme=f.prices.map((b,i)=>i<2?b:{...b,high:1e308,low:1});
  const result=measureGapEntry(f.trade,f.fills,extreme);assert.equal(result.status,'insufficient-prices');assert.equal(result.tolerance,null);assert.deepEqual(result.tags,[]);
});
