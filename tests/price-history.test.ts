import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergePriceBars,priceFingerprint,priceValuesFingerprint,validatePriceBars,validatePriceRange} from '../lib/price-history';
import type {PriceBar} from '../lib/recorder';
const start=Date.parse('2026-10-01T14:00:00Z');
const bar:PriceBar={id:'MES 2026-12|'+start,contract:'MES 2026-12',start,end:start+60000,open:6000,high:6002,low:5999,close:6001,volume:23,capturedAt:start+120000};
test('price archive accepts exact-contract completed minutes and rejects invented or malformed data',()=>{
  assert.deepEqual(validatePriceBars([bar]),[bar]);
  for(const change of [{contract:'MES1!'},{contract:'ES 12-26'},{start:start+1},{end:start+120000},{high:5999},{low:6002},{volume:-1},{volume:1.2},{capturedAt:start},{close:NaN},{id:'other'},{start:Date.UTC(2025,0,1)}])assert.throws(()=>validatePriceBars([{...bar,...change}]));
  assert.throws(()=>validatePriceBars([bar,bar]));assert.throws(()=>validatePriceBars([]));assert.throws(()=>validatePriceBars(Array(241).fill(bar)));
  assert.throws(()=>validatePriceBars([{...bar,capturedAt:Date.now()+600000}]));
  assert.doesNotThrow(()=>validatePriceRange(bar.contract,start,start+7*86400000));
  assert.throws(()=>validatePriceRange(bar.contract,start,start+15*86400000));assert.throws(()=>validatePriceRange('MES1!',start,start+60000));
});
test('price fingerprints distinguish fresh observations while chart merging preserves newer exact-contract corrections',()=>{
  const rewritten={...bar,capturedAt:bar.capturedAt+60000},corrected={...rewritten,close:6002};
  assert.equal(priceValuesFingerprint(bar),priceValuesFingerprint(rewritten));assert.notEqual(priceFingerprint(bar),priceFingerprint(rewritten));assert.notEqual(priceFingerprint(bar),priceFingerprint(corrected));
  assert.deepEqual(mergePriceBars([corrected],[bar]),[corrected]);assert.deepEqual(mergePriceBars([bar],[corrected]),[corrected]);
  const es={...bar,contract:'ES 2026-12',id:'ES 2026-12|'+start};assert.equal(mergePriceBars([bar],[es]).length,2);
});
