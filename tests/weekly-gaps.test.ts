import {test} from 'node:test';
import assert from 'node:assert/strict';
import {weeklyBoundaries,weeklyGapContext} from '../lib/weekly-gaps';
import type {PriceBar} from '../lib/recorder';

const asOf=Date.parse('2026-10-20T15:00:00Z');
const boundary=weeklyBoundaries(asOf).find(b=>b.sunday==='2026-10-18')!;
function bar(start:number,open=100,close=101,contract='NQ 2026-12'):PriceBar{
  return {id:contract+'|'+start,contract,start,end:start+60000,open,close,high:Math.max(open,close)+1,low:Math.min(open,close)-1,volume:10,capturedAt:asOf};
}
const pair=()=>[bar(boundary.fridayCloseAt-60000,101,100),bar(boundary.sundayOpenAt,95,96)];
test('weekly gaps use the Friday final-minute close and Sunday first-minute open, not settlement or adjacent prices',()=>{
  assert.equal(boundary.fridayCloseAt,Date.parse('2026-10-16T21:00:00Z'));assert.equal(boundary.sundayOpenAt,Date.parse('2026-10-18T22:00:00Z'));
  const result=weeklyGapContext('NQ 2026-12',asOf,pair()),gap=result.gaps[0];
  assert.equal(gap.fridayClose,100);assert.equal(gap.sundayOpen,95);assert.equal(gap.low,95);assert.equal(gap.high,100);assert.equal(gap.midpoint,97.5);assert.equal(result.unavailable,result.checkedWeeks-1);
  const up=pair();up[1]=bar(boundary.sundayOpenAt,110,109);const positive=weeklyGapContext('NQ 2026-12',asOf,up).gaps[0];assert.equal(positive.low,100);assert.equal(positive.high,110);
});
test('missing, holiday/early-close and other-expiry boundaries remain unavailable instead of becoming invented levels',()=>{
  const [close,open]=pair();
  for(const input of [[close],[open],[{...close,start:close.start-60000,end:close.end-60000},open],[close,{...open,start:open.start+60000,end:open.end+60000}],[close,{...open,contract:'NQ 2027-03'}],[close,{...open,contract:'MNQ 2026-12'}]]){
    const result=weeklyGapContext('NQ 2026-12',asOf,input);assert.equal(result.gaps.length,0);assert.equal(result.unavailable,result.checkedWeeks);
  }
});
test('Central-time boundaries follow spring and autumn DST changes without assuming a 49-hour weekend',()=>{
  const spring=weeklyBoundaries(Date.parse('2026-03-10T14:00:00Z')).find(b=>b.sunday==='2026-03-08')!;
  assert.equal(spring.sundayOpenAt,Date.parse('2026-03-08T22:00:00Z'));assert.equal(spring.sundayOpenAt-spring.fridayCloseAt,48*3600000);
  const autumn=weeklyBoundaries(Date.parse('2026-11-03T14:00:00Z')).find(b=>b.sunday==='2026-11-01')!;
  assert.equal(autumn.sundayOpenAt,Date.parse('2026-11-01T23:00:00Z'));assert.equal(autumn.sundayOpenAt-autumn.fridayCloseAt,50*3600000);
});
test('a Sunday gap cannot appear in a trade review before its first minute completes',()=>{
  const early=boundary.sundayOpenAt+59999,complete=boundary.sundayOpenAt+60000;
  assert.equal(weeklyGapContext('NQ 2026-12',early,pair()).gaps.length,0);
  assert.equal(weeklyGapContext('NQ 2026-12',complete,pair()).gaps.length,1);
  const old=Date.parse('2026-10-16T20:00:00Z');assert.equal(weeklyGapContext('NQ 2026-12',old,pair()).gaps.length,0);
});
test('historical zones persist after partial/full traversal while zero-width weeks are distinct from missing history',()=>{
  const source=pair(),crossings=[bar(boundary.sundayOpenAt+60000,97,99),bar(boundary.sundayOpenAt+120000,99,104)];
  assert.deepEqual(weeklyGapContext('NQ 2026-12',asOf,[...source,...crossings]).gaps,weeklyGapContext('NQ 2026-12',asOf,source).gaps);
  const zero=weeklyGapContext('NQ 2026-12',asOf,[source[0],bar(boundary.sundayOpenAt,100,101)]);assert.equal(zero.gaps.length,0);assert.equal(zero.noGapWeeks,1);assert.equal(zero.unavailable,zero.checkedWeeks-1);
});
test('newer boundary corrections win without mutating inputs or rounding half-tick midpoints',()=>{
  const source=pair(),changed={...source[1],open:95.25,capturedAt:asOf+1};
  const original=structuredClone(source),result=weeklyGapContext('NQ 2026-12',asOf,[changed,...source]);
  assert.equal(result.gaps[0].midpoint,97.625);assert.deepEqual(source,original);
  assert.ok(result.checkedWeeks<=6);
});
