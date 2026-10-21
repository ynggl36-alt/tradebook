import {addDays,centralDay} from './analytics';
import {parseTimestamp} from './csv';
import type {PriceBar} from './recorder';

export const WEEKLY_GAP_LOOKBACK_DAYS=35;
export type WeeklyBoundary={sunday:string;fridayCloseAt:number;sundayOpenAt:number};
export type WeeklyGap=WeeklyBoundary&{id:string;contract:string;fridayClose:number;sundayOpen:number;low:number;high:number;midpoint:number};
export type WeeklyGapContext={gaps:WeeklyGap[];checkedWeeks:number;unavailable:number;noGapWeeks:number};

// Regular CME equity-index weekend boundaries. Require those exact one-minute
// candles: holiday/early closes and missing history remain unavailable.
// https://www.cmegroup.com/articles/faqs/micro-e-mini-equity-index-futures-frequently-asked-questions.html
export function weeklyBoundaries(asOf:number):WeeklyBoundary[]{
  if(!Number.isSafeInteger(asOf))throw new Error('Invalid weekly-gap time.');
  const today=centralDay(new Date(asOf).toISOString()),result:WeeklyBoundary[]=[];
  for(let offset=WEEKLY_GAP_LOOKBACK_DAYS;offset>=0;offset--){
    const sunday=addDays(today,-offset);
    if(new Date(sunday+'T12:00:00Z').getUTCDay()!==0)continue;
    const sundayOpenAt=Date.parse(parseTimestamp(sunday+' 17:00:00','America/Chicago'));
    // The opening minute must have completed before the trade being reviewed.
    if(sundayOpenAt+60000>asOf)continue;
    const fridayCloseAt=Date.parse(parseTimestamp(addDays(sunday,-2)+' 16:00:00','America/Chicago'));
    result.push({sunday,fridayCloseAt,sundayOpenAt});
  }
  return result;
}
export function weeklyBoundaryStarts(asOf:number){return weeklyBoundaries(asOf).flatMap(b=>[b.fridayCloseAt-60000,b.sundayOpenAt]);}
export function weeklyGapContext(contract:string,asOf:number,input:PriceBar[]):WeeklyGapContext{
  const boundaries=weeklyBoundaries(asOf),bars=new Map<number,PriceBar>();
  for(const bar of input){if(bar.contract!==contract||bar.end!==bar.start+60000)continue;const prior=bars.get(bar.start);if(!prior||prior.capturedAt<bar.capturedAt)bars.set(bar.start,bar);}
  const result:WeeklyGapContext={gaps:[],checkedWeeks:boundaries.length,unavailable:0,noGapWeeks:0};
  for(const boundary of boundaries){
    const close=bars.get(boundary.fridayCloseAt-60000),open=bars.get(boundary.sundayOpenAt);
    if(!close||!open||![close.close,open.open].every(n=>Number.isFinite(n)&&n>0)){result.unavailable++;continue;}
    if(close.close===open.open){result.noGapWeeks++;continue;}
    const low=Math.min(close.close,open.open),high=Math.max(close.close,open.open);
    result.gaps.push({...boundary,id:contract+'|'+boundary.sunday,contract,fridayClose:close.close,sundayOpen:open.open,low,high,midpoint:(low+high)/2});
  }
  // Later price touches, partial fills and full fills do not delete a zone.
  return result;
}
