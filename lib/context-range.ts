import {PRICE_RANGE_LIMIT} from './price-history';

export const CONTEXT_LOOKBACK_DAYS=35;
export const CONTEXT_MINUTE=60000;
const DAY=86400000,CHART_PADDING_MINUTES=15;
export type ContextEntryTime={entry:string;exit?:string};
export type ContextPriceRange={start:number;end:number;lookbackDays:number};
export type ContextPriceRequest={start:number;end:number};

export function contextEntryCutoff(asOf:number):number{
  if(!Number.isSafeInteger(asOf)||!Number.isFinite(new Date(asOf).getTime()))throw new Error('A valid recorded entry time is required.');
  return Math.floor(asOf/CONTEXT_MINUTE)*CONTEXT_MINUTE;
}

// This is an elapsed 35-day window ending at the start of the entry minute.
// Consumers still require each source session to fit entirely inside it.
export function contextLookbackStart(asOf:number):number{
  return contextEntryCutoff(asOf)-CONTEXT_LOOKBACK_DAYS*DAY;
}

// Inclusive one-minute bar-start bounds for the existing price archive loader.
// Supplying exits includes the chart's fifteen-minute post-exit view. Those
// candles cannot change context, which always applies its own entry cutoff.
export function contextPriceRange(entries:readonly ContextEntryTime[]):ContextPriceRange|null{
  if(!entries.length)return null;
  let start=Infinity,end=-Infinity;
  for(const entry of entries){
    const at=Date.parse(entry.entry),cutoff=contextEntryCutoff(at);
    start=Math.min(start,contextLookbackStart(at));
    end=Math.max(end,cutoff-CONTEXT_MINUTE);
    if(entry.exit!==undefined){
      const exit=Date.parse(entry.exit);contextEntryCutoff(exit);
      if(exit<at)throw new Error('A chart exit cannot precede its entry.');
      end=Math.max(end,Math.ceil(exit/CONTEXT_MINUTE)*CONTEXT_MINUTE+(CHART_PADDING_MINUTES-1)*CONTEXT_MINUTE);
    }
  }
  return {start,end,lookbackDays:CONTEXT_LOOKBACK_DAYS};
}

// Shared request limits do not shorten the advertised context window. Adjacent
// requests contain no duplicated minute and never exceed the archive limit.
export function contextPriceRequests(range:ContextPriceRange):ContextPriceRequest[]{
  if(!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start%CONTEXT_MINUTE||range.end%CONTEXT_MINUTE||range.end<range.start)throw new Error('Minute-aligned context price bounds are required.');
  const requests:ContextPriceRequest[]=[];
  for(let start=range.start;start<=range.end;start+=PRICE_RANGE_LIMIT){
    requests.push({start,end:Math.min(range.end,start+PRICE_RANGE_LIMIT-CONTEXT_MINUTE)});
  }
  return requests;
}
