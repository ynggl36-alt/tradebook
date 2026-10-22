import type {HistoricalPriceLevel} from './price-context';
import type {WeeklyGap} from './weekly-gaps';
import type {TrendLine} from './trendlines';
import {trendValueAt} from './trendlines';
import type {Fill,Trade} from './types';
import type {ExecutionMarker} from './recorder';
import {firstEntryFill} from './gap-context';

// Chart presentation only: these choices never feed the entry classifier.
export type ChartHorizontal={id:string;low:number;high:number;distance:number}&(
 {kind:'gap';gap:WeeklyGap}|{kind:'level';level:HistoricalPriceLevel});
export function chartEndpointMarkerIds(trade:Trade,fills:Fill[],markers:readonly ExecutionMarker[]){
 const parts=trade.parts??[],first=firstEntryFill(trade,fills),last=parts.at(-1),exitSide=trade.dir==='Long'?'Sell':'Buy';
 const entryId=first?parts[0][0]+':0':null,exitId=last?.[3]===exitSide?last[0]+':'+(parts.length-1):null;
 return {entryId:markers.some(m=>m.id===entryId&&m.role==='Entry')?entryId:null,exitId:markers.some(m=>m.id===exitId&&m.role==='Exit'&&m.time===Date.parse(trade.exit))?exitId:null};
}
export function chartHorizontals(levels:readonly HistoricalPriceLevel[],gaps:readonly WeeklyGap[],contract:string,entryAt:number,entryPrice:number|null,low:number,high:number,tolerance:number|null):ChartHorizontal[]{
 if(entryPrice===null||!Number.isFinite(entryPrice))return [];
 const cutoff=Math.floor(entryAt/60000)*60000,band=Math.max(.5,tolerance??0);
 const references:ChartHorizontal[]=[
  ...gaps.filter(g=>g.contract===contract&&g.sundayOpenAt+60000<=cutoff&&g.high>=low&&g.low<=high).map(g=>({id:g.id,kind:'gap' as const,gap:g,low:g.low,high:g.high,distance:Math.max(g.low-entryPrice,entryPrice-g.high,0)})),
  ...levels.filter(l=>l.contract===contract&&l.availableAt<=cutoff&&l.price>=low&&l.price<=high).map(l=>({id:l.id,kind:'level' as const,level:l,low:l.price,high:l.price,distance:Math.abs(l.price-entryPrice)})),
 ];
 references.sort((a,b)=>a.distance-b.distance||Number(b.kind==='gap')-Number(a.kind==='gap')||(b.kind==='gap'?b.gap.sundayOpenAt:b.level.availableAt)-(a.kind==='gap'?a.gap.sundayOpenAt:a.level.availableAt)||a.id.localeCompare(b.id));
 const chosen:ChartHorizontal[]=[];
 for(const ref of references){
  if(chosen.some(other=>ref.low<=other.high+band&&ref.high>=other.low-band))continue;
  chosen.push(ref);if(chosen.length===2)break;
 }
 return chosen;
}

export function chartTrendLines(lines:readonly TrendLine[],contract:string,entryAt:number,entryPrice:number|null,tolerance:number|null,preferredId:string|null):TrendLine[]{
 if(entryPrice===null||!Number.isFinite(entryPrice))return [];
 const cutoff=Math.floor(entryAt/60000)*60000,band=Math.max(.5,tolerance??0);
 const candidates=lines.filter(l=>l.family.startsWith(contract+'|')&&!l.broken&&l.asOf===cutoff&&l.availableAt<=cutoff&&Number.isFinite(trendValueAt(l,entryAt)));
 candidates.sort((a,b)=>Number(b.id===preferredId)-Number(a.id===preferredId)||Number(b.structureValid!==false&&b.touches>0)-Number(a.structureValid!==false&&a.touches>0)||Math.abs(trendValueAt(a,entryAt)-entryPrice)-Math.abs(trendValueAt(b,entryAt)-entryPrice)||b.score-a.score||a.id.localeCompare(b.id));
 const chosen:TrendLine[]=[];
 for(const line of candidates){
  if(chosen.some(other=>[entryAt,entryAt-20*60000].every(time=>Math.abs(trendValueAt(line,time)-trendValueAt(other,time))<=band)))continue;
  chosen.push(line);if(chosen.length===2)break;
 }
 return chosen;
}
