import {addDays,centralDay,centralHour} from './analytics';
import {parseTimestamp} from './csv';
import {CONTEXT_LOOKBACK_DAYS,CONTEXT_MINUTE,contextEntryCutoff,contextLookbackStart} from './context-range';
import type {PriceBar} from './recorder';

export const PRICE_CONTEXT_VERSION='historical-price-context-v1';
export type HistoricalPriceLevelType='session-high'|'session-low'|'session-open';
export type HistoricalPriceLevel={id:string;contract:string;type:HistoricalPriceLevelType;source:string;start:number;end:number;availableAt:number;price:number};
export type PriceSourceCoverage={source:string;start:number;end:number;expectedBars:number;elapsedBars:number;observedBars:number;closed:boolean;openAvailable:boolean;status:'complete'|'developing'|'partial'|'unavailable'};
export type PriceContext={version:string;contract:string;asOf:number;lookbackStart:number;status:'complete'|'partial'|'unavailable';sources:PriceSourceCoverage[];levels:HistoricalPriceLevel[]};
type PriceSession={source:string;start:number;end:number};
type PreparedPriceSource=PriceSession&{minutes:number[];open:number|null;high:number|null;low:number|null;complete:boolean};
export type PreparedPriceContext={contract:string;sessions:ReadonlyMap<number,PreparedPriceSource>};
export type PriceLevelMatch={level:HistoricalPriceLevel;distance:number};
export type PriceContextMatch={status:'measured'|'partial'|'unavailable';reason:'missing-entry-fill'|'missing-tolerance'|'no-source-levels'|null;entryPrice:number|null;tolerance:number|null;matches:PriceLevelMatch[];nearest:PriceLevelMatch|null};
const SESSION_MINUTES=23*60,HOUR=60*CONTEXT_MINUTE;
const sessionCache=new Map<string,PriceSession|null>();

function sessionBoundary(source:string):PriceSession|null{
  if(sessionCache.has(source))return sessionCache.get(source)!;
  const weekday=new Date(source+'T12:00:00Z').getUTCDay();
  const result=weekday===0||weekday===6?null:{source,start:Date.parse(parseTimestamp(addDays(source,-1)+' 17:00:00','America/Chicago')),end:Date.parse(parseTimestamp(source+' 16:00:00','America/Chicago'))};
  if(sessionCache.size>=128)sessionCache.delete(sessionCache.keys().next().value!);
  sessionCache.set(source,result);return result;
}

function boundaries(asOf:number):PriceSession[]{
  const start=contextLookbackStart(asOf),firstDay=centralDay(new Date(start).toISOString()),result:PriceSession[]=[];
  for(let i=0;i<=CONTEXT_LOOKBACK_DAYS+2;i++){
    const boundary=sessionBoundary(addDays(firstDay,i));
    if(boundary&&boundary.start>=start&&boundary.start+CONTEXT_MINUTE<=asOf&&boundary.end-boundary.start===SESSION_MINUTES*CONTEXT_MINUTE)result.push(boundary);
  }
  return result;
}

function validBar(bar:PriceBar,contract:string):boolean{
  return bar.contract===contract&&bar.id===contract+'|'+bar.start&&Number.isSafeInteger(bar.start)&&Number.isFinite(new Date(bar.start).getTime())&&bar.start%CONTEXT_MINUTE===0&&bar.end===bar.start+CONTEXT_MINUTE&&Number.isSafeInteger(bar.capturedAt)&&bar.capturedAt>=bar.end&&[bar.open,bar.high,bar.low,bar.close].every(n=>Number.isFinite(n)&&n>0)&&bar.high>=Math.max(bar.open,bar.close)&&bar.low<=Math.min(bar.open,bar.close)&&bar.low<=bar.high;
}

// Prepare once per exact contract in the worker. Source observation timestamps
// choose corrections; they do not claim these backfilled prices were known live.
export function preparePriceContext(input:readonly PriceBar[],contract:string):PreparedPriceContext{
  const unique=new Map<number,{bar:PriceBar;fingerprint:string;conflict:boolean}>();
  for(const bar of input){
    if(!validBar(bar,contract))continue;
    const old=unique.get(bar.start),fingerprint=JSON.stringify([bar.open,bar.high,bar.low,bar.close]);
    if(!old||bar.capturedAt>old.bar.capturedAt)unique.set(bar.start,{bar,fingerprint,conflict:false});
    else if(bar.capturedAt===old.bar.capturedAt&&fingerprint!==old.fingerprint)old.conflict=true;
  }
  const groups=new Map<number,{session:PriceSession;bars:PriceBar[]}>(),hours=new Map<number,PriceSession|null>();
  for(const {bar,conflict} of [...unique.values()].sort((a,b)=>a.bar.start-b.bar.start)){
    if(conflict)continue;
    const hour=Math.floor(bar.start/HOUR)*HOUR;
    let session=hours.get(hour);
    if(session===undefined){
      const time=new Date(bar.start).toISOString(),day=centralDay(time);
      session=sessionBoundary(centralHour(time)>=17?addDays(day,1):day);hours.set(hour,session);
    }
    if(!session||bar.start<session.start||bar.end>session.end)continue;
    const group=groups.get(session.start)||{session,bars:[]};group.bars.push(bar);groups.set(session.start,group);
  }
  const sessions=new Map<number,PreparedPriceSource>();
  for(const {session,bars} of groups.values()){
    const complete=bars.length===SESSION_MINUTES&&bars.every((b,i)=>b.start===session.start+i*CONTEXT_MINUTE)&&bars.at(-1)!.end===session.end;
    sessions.set(session.start,{...session,minutes:bars.map(b=>b.start),open:bars[0].start===session.start?bars[0].open:null,high:complete?bars.reduce((high,b)=>Math.max(high,b.high),-Infinity):null,low:complete?bars.reduce((low,b)=>Math.min(low,b.low),Infinity):null,complete});
  }
  return {contract,sessions};
}

function completedMinutes(minutes:number[],cutoff:number):number{
  let low=0,high=minutes.length;
  while(low<high){const mid=(low+high)>>>1;if(minutes[mid]+CONTEXT_MINUTE<=cutoff)low=mid+1;else high=mid;}
  return low;
}

// Only regular 17:00→16:00 Chicago sessions are supported. A holiday/early close
// or missing minute leaves its high/low unavailable; no adjacent bar is a proxy.
export function priceContext(contract:string,asOf:number,input:readonly PriceBar[]|PreparedPriceContext):PriceContext{
  const cutoff=contextEntryCutoff(asOf),prepared=Array.isArray(input)?preparePriceContext(input,contract):input as PreparedPriceContext;
  const result:PriceContext={version:PRICE_CONTEXT_VERSION,contract,asOf:cutoff,lookbackStart:contextLookbackStart(cutoff),status:'unavailable',sources:[],levels:[]};
  for(const session of boundaries(cutoff)){
    const source=prepared.contract===contract?prepared.sessions.get(session.start):undefined;
    const closed=session.end<=cutoff,elapsedBars=Math.min(SESSION_MINUTES,Math.floor((cutoff-session.start)/CONTEXT_MINUTE)),observedBars=source?completedMinutes(source.minutes,cutoff):0;
    const openAvailable=source?.open!==null&&source?.open!==undefined;
    const status:PriceSourceCoverage['status']=observedBars===0?'unavailable':observedBars<elapsedBars?'partial':closed?'complete':'developing';
    result.sources.push({...session,expectedBars:SESSION_MINUTES,elapsedBars,observedBars,closed,openAvailable,status});
    const level=(type:HistoricalPriceLevelType,price:number,availableAt:number)=>result.levels.push({...session,id:[contract,session.source,type].join('|'),contract,type,price,availableAt});
    if(openAvailable)level('session-open',source!.open!,session.start+CONTEXT_MINUTE);
    if(closed&&source?.complete){level('session-high',source.high!,session.end);level('session-low',source.low!,session.end);}
  }
  if(result.levels.length)result.status=result.sources.every(s=>s.status==='complete'||s.status==='developing')?'complete':'partial';
  return result;
}

// Measured location only. A matching level is neither an interaction sequence
// nor an intended strategy, and incomplete coverage survives even a positive hit.
export function matchPriceContext(context:PriceContext,entryPrice:number|null,tolerance:number|null):PriceContextMatch{
  const result:PriceContextMatch={status:'unavailable',reason:null,entryPrice,tolerance,matches:[],nearest:null};
  if(entryPrice===null||!Number.isFinite(entryPrice)||entryPrice<=0){result.entryPrice=null;result.reason='missing-entry-fill';return result;}
  if(tolerance===null||!Number.isFinite(tolerance)||tolerance<0){result.tolerance=null;result.reason='missing-tolerance';return result;}
  if(!context.levels.length||context.status==='unavailable'){result.reason='no-source-levels';return result;}
  const distances=context.levels.map(level=>({level,distance:Math.abs(entryPrice-level.price)})).sort((a,b)=>a.distance-b.distance||b.level.availableAt-a.level.availableAt||a.level.id.localeCompare(b.level.id));
  result.nearest=distances[0];result.matches=distances.filter(match=>match.distance<=tolerance);result.status=context.status==='complete'?'measured':'partial';
  return result;
}
