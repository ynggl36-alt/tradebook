import type {Fill} from './types';
import {addDays,centralDay,centralHour,round} from './analytics';
import {LUCID_PER_SIDE,LUCID_RATES_AS_OF} from './trading-costs';
import {executionLedger} from './execution-ledger';

export type RealizedDay={account:string;contract:string;symbol:string;day:string;gross:number;commissions:number|null;net:number|null;exits:number;quantity:number;unmatched:number;coverageIssues?:number};
export type RealizedEvent=Omit<RealizedDay,'day'|'coverageIssues'>&{time:string;fillId:string;ordinal:number;coverageIssues:number;positionConflict?:true};
export type RealizedCheckpoint={account:string;capturedAt:string;session:string;net:number|null;afterNet:number|null;coverageIssues?:number;afterCoverageIssues?:number};

// Both Chicago midnight and the 17:00 session boundary occur on UTC hours,
// including across daylight-saving changes. Share this cache across accounts.
const centralHours=new Map<number,{calendar:string;session:string}>();
function fillDates(time:string){
 const hour=Math.floor(Date.parse(time)/3600000),cached=centralHours.get(hour);if(cached)return cached;
 const calendar=centralDay(time),dates={calendar,session:centralHour(time)>=17?addDays(calendar,1):calendar};
 if(centralHours.size>=18000)centralHours.clear();centralHours.set(hour,dates);return dates;
}
function complete(event:Pick<RealizedEvent,'net'|'unmatched'|'coverageIssues'>){return event.net!==null&&event.unmatched===0&&event.coverageIssues===0;}

// FIFO lots realize their result on each exit fill, even while other lots stay
// open. An entry's commission belongs to its own timestamp, never a later exit.
// These events are derived; raw fills and completed Trade identities stay intact.
export function realizedEvents(account:string,fills:Fill[],ledger=executionLedger(fills)):RealizedEvent[]{
 const conflicts=new Set(ledger.positionConflicts.map(conflict=>conflict.fillId));
 return ledger.events.map(({fill,gross,quantity,unmatched,coverageIssues})=>{
  const day=fillDates(fill.time).calendar,rate=/^(LFE|LFF)/i.test(account)&&day>=LUCID_RATES_AS_OF?LUCID_PER_SIDE[fill.symbol]:undefined,commissions=rate===undefined?null:round(rate*fill.qty);
  return {account,contract:fill.contract,symbol:fill.symbol,time:fill.time,fillId:fill.id,ordinal:fill.ordinal,gross,commissions,net:commissions===null||unmatched||coverageIssues?null:round(gross-commissions),exits:quantity?1:0,quantity,unmatched,coverageIssues,...(conflicts.has(fill.id)?{positionConflict:true as const}:{})};
 });
}

export function aggregateRealized(events:RealizedEvent[],basis:'calendar'|'session'='calendar'):RealizedDay[]{
 const days=new Map<string,RealizedDay>();
 for(const event of events){
  const day=fillDates(event.time)[basis],key=JSON.stringify([event.account,event.contract,day]);
  let row=days.get(key);
  if(!row){row={account:event.account,contract:event.contract,symbol:event.symbol,day,gross:0,commissions:0,net:0,exits:0,quantity:0,unmatched:0};days.set(key,row);}
  row.gross+=event.gross;row.commissions=row.commissions===null||event.commissions===null?null:row.commissions+event.commissions;
  row.net=row.net===null||!complete(event)?null:row.net+event.net!;
  row.exits+=event.exits;row.quantity+=event.quantity;row.unmatched+=event.unmatched;
  if(event.coverageIssues)row.coverageIssues=(row.coverageIssues||0)+event.coverageIssues;
 }
 return [...days.values()].map(row=>({...row,gross:round(row.gross),commissions:row.commissions===null?null:round(row.commissions),net:row.net===null?null:round(row.net)})).sort((a,b)=>a.day.localeCompare(b.day)||a.account.localeCompare(b.account)||a.contract.localeCompare(b.contract));
}

// A checkpoint exposes only the capture session's before/after sums, so the
// browser can reconcile a firm baseline without receiving the fill ledger.
export function realizedCheckpoint(account:string,capturedAt:string,events:RealizedEvent[]):RealizedCheckpoint{
 const session=fillDates(capturedAt).session,at=Date.parse(capturedAt),before:RealizedEvent[]=[],after:RealizedEvent[]=[];
 let earlier=false,earlierClean=true;
 for(const event of events){
  if(event.account!==account)continue;
  const time=Date.parse(event.time);
  if(fillDates(event.time).session===session){if(time<=at)before.push(event);else after.push(event);}
  else if(time<=at){earlier=true;earlierClean=earlierClean&&complete(event);}
 }
 const sum=(rows:RealizedEvent[])=>rows.every(complete)?round(rows.reduce((total,event)=>total+event.net!,0)):null;
 const coverageIssues=before.reduce((total,event)=>total+event.coverageIssues,0),afterCoverageIssues=after.reduce((total,event)=>total+event.coverageIssues,0);
 return {account,capturedAt,session,net:before.length?sum(before):earlier&&earlierClean?0:null,afterNet:sum(after),...(coverageIssues?{coverageIssues}:{}),...(afterCoverageIssues?{afterCoverageIssues}:{})};
}

// Retain the existing calendar API for calendar/reporting consumers.
export function realizedDays(account:string,fills:Fill[]):RealizedDay[]{return aggregateRealized(realizedEvents(account,fills));}
export function summarizeRealized(rows:RealizedDay[]){
 const gross=round(rows.reduce((sum,row)=>sum+row.gross,0)),unmatched=rows.reduce((sum,row)=>sum+row.unmatched,0),coverageIssues=rows.reduce((sum,row)=>sum+(row.coverageIssues||0),0),complete=rows.length>0&&rows.every(row=>row.net!==null&&!(row.coverageIssues||0)&&!row.unmatched),costsComplete=rows.length>0&&rows.every(row=>row.commissions!==null);
 return {gross,unmatched,coverageIssues,exits:rows.reduce((sum,row)=>sum+row.exits,0),quantity:rows.reduce((sum,row)=>sum+row.quantity,0),commissions:costsComplete?round(rows.reduce((sum,row)=>sum+row.commissions!,0)):null,net:complete?round(rows.reduce((sum,row)=>sum+row.net!,0)):null};
}
