import type {Fill,Trade} from './types';
import type {PriceBar} from './recorder';
import {weeklyGapContext} from './weekly-gaps';
import {centralDay} from './analytics';
import {netTradePnl} from './trading-costs';

export const GAP_CONTEXT_VERSION='weekly-gap-context-v1';
export const GAP_CONTEXT_BATCH=20;
export const GAP_CONTEXT_SAMPLE=60;
export const GAP_CONTEXT_MINUTES=20;
export type GapContextTag='near-edge'|'near-midpoint'|'inside-zone';
export const GAP_CONTEXT_LABELS:Record<GapContextTag,string>={
  'near-edge':'Near a recorded edge',
  'near-midpoint':'Near a recorded midpoint',
  'inside-zone':'Inside a recorded gap',
};
export type GapEntryContext={
  id:string;account:string;contract:string;entry:string;
  status:'measured'|'missing-entry-fill'|'insufficient-prices'|'no-known-gaps';
  entryPrice:number|null;atr:number|null;tolerance:number|null;preEntryBars:number;
  knownGaps:number;checkedWeeks:number;unavailableWeeks:number;noGapWeeks:number;tags:GapContextTag[];
  nearest:{sunday:string;kind:'edge'|'midpoint';price:number;distance:number;atrDistance:number|null}|null;
  gross:number;net:number|null;
};
const timeKey=(time:string)=>new Date(time).toISOString().slice(0,19)+'.'+(time.match(/\.(\d+)/)?.[1]||'').padEnd(9,'0');
export function firstEntryFill(trade:Trade,fills:Fill[]):Fill|null{
  // Reconstruction keeps allocations in execution order. Validate that first
  // opening allocation itself; a missing fill must not fall through to a
  // same-clock scale-in. Reversals can allocate only part of a larger raw fill.
  const side=trade.dir==='Long'?'Buy':'Sell',part=trade.parts?.[0];
  if(!part||part[3]!==side||!Number.isFinite(part[1])||part[1]<=0)return null;
  const first=fills.find(f=>f.id===part[0]);
  if(!first||first.side!==side||first.contract!==trade.contract||first.price!==part[2]||!Number.isFinite(first.price)||first.price<=0||!Number.isFinite(first.qty)||first.qty<part[1]||!Number.isFinite(Date.parse(first.time))||!Number.isFinite(Date.parse(trade.entry)))return null;
  return timeKey(first.time)===timeKey(trade.entry)?first:null;
}
export function entryPriceRange(entry:string){
  const end=Math.floor(Date.parse(entry)/60000)*60000;
  return {start:end-GAP_CONTEXT_MINUTES*60000,end};
}
export function measureGapEntry(trade:Trade,fills:Fill[],prices:PriceBar[]):GapEntryContext{
  const asOf=Date.parse(trade.entry),scope=weeklyGapContext(trade.contract,asOf,prices),first=firstEntryFill(trade,fills);
  const result:GapEntryContext={id:trade.id,account:trade.account,contract:trade.contract,entry:trade.entry,status:'missing-entry-fill',entryPrice:first?.price??null,atr:null,tolerance:null,preEntryBars:0,knownGaps:scope.gaps.length,checkedWeeks:scope.checkedWeeks,unavailableWeeks:scope.unavailable,noGapWeeks:scope.noGapWeeks,tags:[],nearest:null,gross:trade.pnl,net:netTradePnl(trade)};
  if(!first)return result;
  const range=entryPriceRange(trade.entry),byMinute=new Map<number,PriceBar>();
  for(const bar of prices){if(bar.contract!==trade.contract||bar.end!==bar.start+60000||bar.start%60000!==0||bar.start<range.start||bar.start>=range.end||bar.end>asOf||![bar.open,bar.high,bar.low,bar.close].every(n=>Number.isFinite(n)&&n>0)||bar.high<Math.max(bar.open,bar.close)||bar.low>Math.min(bar.open,bar.close)||bar.low>bar.high)continue;const old=byMinute.get(bar.start);if(!old||old.capturedAt<bar.capturedAt)byMinute.set(bar.start,bar);}
  const before=[...byMinute.values()].sort((a,b)=>a.start-b.start);result.preEntryBars=before.length;
  if(before.length!==GAP_CONTEXT_MINUTES){result.status='insufficient-prices';return result;}
  const recent=before.slice(-15),atr=recent.slice(1).reduce((sum,b,i)=>sum+Math.max(b.high-b.low,Math.abs(b.high-recent[i].close),Math.abs(b.low-recent[i].close)),0)/14;
  if(!Number.isFinite(atr)){result.status='insufficient-prices';return result;}
  // All supported index contracts use 0.25-point ticks. This is an explicit
  // pilot threshold, not a fitted strategy rule or an owner-confirmed setup.
  result.atr=atr;result.tolerance=Math.max(1,.25*atr);
  if(!scope.gaps.length){result.status='no-known-gaps';return result;}
  result.status='measured';
  const levels=scope.gaps.flatMap(g=>[{sunday:g.sunday,kind:'edge' as const,price:g.low},{sunday:g.sunday,kind:'edge' as const,price:g.high},{sunday:g.sunday,kind:'midpoint' as const,price:g.midpoint}]);
  const nearest=levels.map(level=>({...level,distance:Math.abs(first.price-level.price)})).sort((a,b)=>a.distance-b.distance)[0];
  result.nearest={...nearest,atrDistance:atr>0?nearest.distance/atr:null};
  const tolerance=result.tolerance;
  if(levels.some(level=>level.kind==='edge'&&Math.abs(first.price-level.price)<=tolerance))result.tags.push('near-edge');
  if(levels.some(level=>level.kind==='midpoint'&&Math.abs(first.price-level.price)<=tolerance))result.tags.push('near-midpoint');
  if(scope.gaps.some(g=>first.price>=g.low&&first.price<=g.high))result.tags.push('inside-zone');
  return result;
}
export type GapContextGroup={id:string;label:string;count:number;netKnown:number;netUnknown:number;wins:number;net:number|null;average:number|null;winRate:number|null;days:number};
export function summarizeGapContexts(rows:GapEntryContext[]):GapContextGroup[]{
  const groups=[{id:'measured',label:'All measured first entries',accept:(r:GapEntryContext)=>r.status==='measured'},
    ...(['near-edge','near-midpoint','inside-zone'] as const).map(id=>({id,label:GAP_CONTEXT_LABELS[id],accept:(r:GapEntryContext)=>r.status==='measured'&&r.tags.includes(id)}))];
  return groups.map(group=>{
    const sample=rows.filter(group.accept),known=sample.filter(r=>r.net!==null),net=known.reduce((sum,r)=>sum+r.net!,0),wins=known.filter(r=>r.net!>0).length;
    return {id:group.id,label:group.label,count:sample.length,netKnown:known.length,netUnknown:sample.length-known.length,wins,net:sample.length&&known.length===sample.length?Math.round(net*100)/100:null,average:sample.length&&known.length===sample.length?net/known.length:null,winRate:sample.length&&known.length===sample.length?wins/known.length:null,days:new Set(sample.map(r=>centralDay(r.entry))).size};
  });
}
