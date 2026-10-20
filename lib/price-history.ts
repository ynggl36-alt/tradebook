import type {PriceBar} from './recorder';

export const PRICE_BATCH_SIZE=240;
export const PRICE_RANGE_LIMIT=14*86400000;
export function priceValuesFingerprint(bar:PriceBar){return JSON.stringify([bar.contract,bar.start,bar.open,bar.high,bar.low,bar.close,bar.volume]);}
export function priceFingerprint(bar:PriceBar){return priceValuesFingerprint(bar)+'|'+bar.capturedAt;}
export function validatePriceBars(input:unknown,now=Date.now()):PriceBar[]{
  if(!Array.isArray(input)||!input.length||input.length>PRICE_BATCH_SIZE)throw new Error('Send 1 to '+PRICE_BATCH_SIZE+' completed candles at a time.');
  const seen=new Set<string>();
  return input.map(value=>{
    if(!value||typeof value!=='object')throw new Error('Invalid candle.');
    const b=value as PriceBar;
    if(typeof b.contract!=='string'||!/^(NQ|MNQ|ES|MES) 20\d{2}-(0[1-9]|1[0-2])$/.test(b.contract))throw new Error('An exact NQ, MNQ, ES or MES contract is required.');
    if(!Number.isSafeInteger(b.start)||b.start<Date.UTC(2026,0,1)||b.start%60000||b.end!==b.start+60000||!Number.isSafeInteger(b.capturedAt)||b.capturedAt<b.end||b.capturedAt>now+300000||b.end>now)throw new Error('Only completed, minute-aligned candles from 2026 onward can be archived.');
    if(![b.open,b.high,b.low,b.close].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>0)||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close)||b.low>b.high||!Number.isSafeInteger(b.volume)||b.volume<0)throw new Error('A candle has inconsistent prices or volume.');
    const id=b.contract+'|'+b.start;
    if(b.id!==id||seen.has(id))throw new Error('A candle key is invalid or repeated.');
    seen.add(id);return {id,contract:b.contract,start:b.start,end:b.end,open:b.open,high:b.high,low:b.low,close:b.close,volume:b.volume,capturedAt:b.capturedAt};
  });
}
export function validatePriceRange(contract:string,start:number,end:number){
  if(!/^(NQ|MNQ|ES|MES) 20\d{2}-(0[1-9]|1[0-2])$/.test(contract)||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<start||end-start>PRICE_RANGE_LIMIT)throw new Error('Choose an exact contract and a chart window of at most 14 days.');
}
export function mergePriceBars(cloud:PriceBar[],local:PriceBar[]){
  const bars=new Map(cloud.map(b=>[b.id,b]));
  for(const bar of local){const previous=bars.get(bar.id);if(!previous||previous.capturedAt<bar.capturedAt)bars.set(bar.id,bar);}
  return [...bars.values()].sort((a,b)=>a.start-b.start);
}
