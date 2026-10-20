import {env} from 'cloudflare:workers';
import {validatePriceBars,validatePriceRange} from './price-history';
import type {PriceBar} from './recorder';
import {weeklyBoundaryStarts} from './weekly-gaps';

const database=()=>{if(!env.DB)throw new Error('Price storage is unavailable.');return env.DB;};
export async function savePriceBars(input:unknown){
  const bars=validatePriceBars(input),receivedAt=Date.now(),statements=[];
  // Ten rows keep each statement below D1's 100 bound-parameter limit.
  // The batch is atomic, including same-source-time conflicting corrections.
  for(let offset=0;offset<bars.length;offset+=10){
    const chunk=bars.slice(offset,offset+10);
    statements.push(database().prepare(`INSERT INTO price_bars (contract,start,open,high,low,close,volume,captured_at,received_at) VALUES ${chunk.map(()=>'(?,?,?,?,?,?,?,?,?)').join(',')}
      ON CONFLICT(contract,start) DO UPDATE SET
      open=CASE WHEN excluded.captured_at=price_bars.captured_at AND (excluded.open!=price_bars.open OR excluded.high!=price_bars.high OR excluded.low!=price_bars.low OR excluded.close!=price_bars.close OR excluded.volume!=price_bars.volume) THEN NULL ELSE excluded.open END,
      high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume,captured_at=excluded.captured_at,received_at=excluded.received_at
      WHERE excluded.captured_at>price_bars.captured_at OR (excluded.captured_at=price_bars.captured_at AND (excluded.open!=price_bars.open OR excluded.high!=price_bars.high OR excluded.low!=price_bars.low OR excluded.close!=price_bars.close OR excluded.volume!=price_bars.volume))`)
      .bind(...chunk.flatMap(b=>[b.contract,b.start,b.open,b.high,b.low,b.close,b.volume,b.capturedAt,receivedAt])));
  }
  try{await database().batch(statements);}catch(e){if(e instanceof Error&&/NOT NULL.*price_bars.open/i.test(e.message))throw new Error('Conflicting candles have the same source timestamp. The batch was not archived.');throw e;}
  return {confirmed:bars.length};
}
export async function loadPriceBars(contract:string,start:number,end:number){
  validatePriceRange(contract,start,end);
  const rows=await database().prepare('SELECT contract,start,open,high,low,close,volume,captured_at AS capturedAt FROM price_bars WHERE contract=? AND start>=? AND start<=? ORDER BY start').bind(contract,start,end).all<Omit<PriceBar,'id'|'end'>>();
  return rows.results.map(b=>({...b,id:b.contract+'|'+b.start,end:b.start+60000}));
}
export async function loadWeeklyGapBars(contract:string,asOf:number){
  validatePriceRange(contract,asOf,asOf);
  if(asOf<Date.UTC(2026,0,1)||asOf>Date.now()+300000)throw new Error('Choose a recorded trade from 2026 onward.');
  const times=weeklyBoundaryStarts(asOf);if(!times.length)return [];
  // Only the boundary minutes, rather than repeatedly reading 35 days of bars.
  const rows=await database().prepare(`SELECT contract,start,open,high,low,close,volume,captured_at AS capturedAt FROM price_bars WHERE contract=? AND start IN (${times.map(()=>'?').join(',')}) ORDER BY start`).bind(contract,...times).all<Omit<PriceBar,'id'|'end'>>();
  return rows.results.map(b=>({...b,id:b.contract+'|'+b.start,end:b.start+60000}));
}
