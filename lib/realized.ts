import type {Fill} from './types';
import {addDays,centralDay,centralHour,round} from './analytics';
import {LUCID_PER_SIDE,LUCID_RATES_AS_OF} from './trading-costs';

export type RealizedDay={account:string;contract:string;symbol:string;day:string;gross:number;commissions:number|null;net:number|null;exits:number;quantity:number;unmatched:number;coverageIssues?:number};
export type RealizedEvent=Omit<RealizedDay,'day'|'coverageIssues'>&{time:string;fillId:string;ordinal:number;coverageIssues:number};
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
export function realizedEvents(account:string,fills:Fill[]):RealizedEvent[]{
 const streams=new Map<string,Fill[]>(),events:RealizedEvent[]=[];
 for(const fill of fills){const stream=streams.get(fill.contract)||[];stream.push(fill);streams.set(fill.contract,stream);}
 for(const source of streams.values()){
  const sorted=[...source].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time)||a.ordinal-b.ordinal||a.id.localeCompare(b.id));
  let position=0,lots:{qty:number;price:number|null}[]=[],head=0;
  for(const fill of sorted){
   const sign=fill.side==='Buy'?1:-1,day=fillDates(fill.time).calendar;
   const rate=/^(LFE|LFF)/i.test(account)&&day>=LUCID_RATES_AS_OF?LUCID_PER_SIDE[fill.symbol]:undefined;
   const event:RealizedEvent={account,contract:fill.contract,symbol:fill.symbol,time:fill.time,fillId:fill.id,ordinal:fill.ordinal,gross:0,commissions:rate===undefined?null:round(rate*fill.qty),net:null,exits:0,quantity:0,unmatched:0,coverageIssues:0};
   if(fill.pos!==null){
    const before=fill.pos-sign*fill.qty;
    if(before!==position){
     // A discrepancy can discard inventory without this fill closing any of
     // it. Keep a separate coverage marker even when unmatched remains zero.
     event.coverageIssues++;position=before;lots=before?[{qty:Math.abs(before),price:null}]:[];head=0;
    }
   }
   if(position===0&&fill.pos===null&&fill.entryFlag===false){
    event.unmatched=fill.qty;event.coverageIssues++;event.exits=1;event.quantity=fill.qty;
   }else{
    let remaining=fill.qty;
    while(remaining>0){
     if(position===0||position*sign>0){lots.push({qty:remaining,price:fill.price});position+=sign*remaining;remaining=0;}
     else{
      event.exits=1;const lot=lots[head];
      if(!lot)throw new Error('Realized inventory is inconsistent.');
      const quantity=Math.min(remaining,lot.qty);
      if(lot.price===null)event.unmatched+=quantity;else event.gross+=(fill.price-lot.price)*(position>0?1:-1)*quantity*fill.pv;
      event.quantity+=quantity;lot.qty-=quantity;position+=sign*quantity;remaining-=quantity;if(lot.qty===0)head++;
      if(position===0){lots=[];head=0;}
     }
    }
   }
   if(event.unmatched>0&&event.coverageIssues===0)event.coverageIssues++;
   event.gross=round(event.gross);
   event.net=event.commissions===null||event.unmatched>0||event.coverageIssues>0?null:round(event.gross-event.commissions);
   events.push(event);
  }
 }
 return events.sort((a,b)=>Date.parse(a.time)-Date.parse(b.time)||a.ordinal-b.ordinal||a.contract.localeCompare(b.contract)||a.fillId.localeCompare(b.fillId));
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
