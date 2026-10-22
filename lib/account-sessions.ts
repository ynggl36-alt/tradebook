import {round} from './analytics';
import {flexSession} from './trading-session';
import type {RealizedCheckpoint,RealizedEvent} from './realized';

export type ReportedSession={account:string;day:string;net:number;at:string;through?:string};
export type NativePnlReading={account:string;at:string;net:number;cash:number;connection:string;provider:string};
export type NativePnlRow={account:string;capturedAt:string;net:number|null;netAt:string|null;cash:number|null;cashAt:string|null;connected:number;currency:string;connection:string;provider:string};
export const nativeReadingKey=(account:string,at:string)=>account+'@'+at;
const series=(r:NativePnlReading)=>JSON.stringify([r.account,r.connection,r.provider,flexSession(r.at)]);
const clean=(event:RealizedEvent)=>event.net!==null&&!event.unmatched&&!event.coverageIssues;

// A provider's realized field is not assumed to be net or to reset at our
// session boundary. Verify each account/connection/session against a clean
// execution prefix that includes fees. Later broken execution Position metadata
// cannot overwrite the independently observed account result.
export function reportedAccountSessions(rows:readonly NativePnlRow[],eventsByAccount:ReadonlyMap<string,readonly RealizedEvent[]>,asOf=Date.now()){
 const readings=new Map<string,NativePnlReading>(),sessions=new Map<string,ReportedSession>(),latest=new Map<string,string>();
 const groups=new Map<string,NativePnlReading[]>();
 for(const row of rows){
  if(!row.connected||row.currency!=='USD'||row.netAt!==row.capturedAt||row.cashAt!==row.capturedAt||row.net===null||row.cash===null||!Number.isFinite(row.net)||!Number.isFinite(row.cash)||!Number.isFinite(Date.parse(row.capturedAt))||Date.parse(row.capturedAt)>asOf)continue;
  const dayKey=row.account+'|'+flexSession(row.capturedAt),latestAt=latest.get(dayKey);if(!latestAt||Date.parse(row.capturedAt)>Date.parse(latestAt))latest.set(dayKey,row.capturedAt);
  const reading:NativePnlReading={account:row.account,at:row.capturedAt,net:row.net,cash:row.cash,connection:row.connection,provider:row.provider},key=series(reading),group=groups.get(key)||[];group.push(reading);groups.set(key,group);
 }
 const eventGroups=new Map<string,RealizedEvent[]>();
 for(const [account,events]of eventsByAccount)for(const event of events){if(Date.parse(event.time)>asOf)continue;const key=JSON.stringify([account,flexSession(event.time)]),group=eventGroups.get(key)||[];group.push(event);eventGroups.set(key,group);}
 for(const points of groups.values()){
  points.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));const first=points[0],day=flexSession(first.at),events=[...(eventGroups.get(JSON.stringify([first.account,day]))||[])].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
  let index=0,total=0,fees=0,complete=true,verified=false,previous:NativePnlReading|undefined;
  for(const point of points){
   while(index<events.length&&Date.parse(events[index].time)<=Date.parse(point.at)){const event=events[index++];complete=complete&&clean(event);total+=event.net??0;fees+=event.commissions??0;}
   if(previous&&point.net===0&&previous.net!==0&&Math.abs(point.cash-previous.cash)<.01)verified=false;
   if(complete&&fees>0&&Math.abs(round(total)-point.net)<.01)verified=true;
   if(verified){readings.set(nativeReadingKey(point.account,point.at),point);const key=point.account+'|'+day,old=sessions.get(key);if(!old||Date.parse(point.at)>Date.parse(old.at))sessions.set(key,{account:point.account,day,net:round(point.net),at:point.at});}
   previous=point;
  }
 }
 const currentSessions=[...sessions.values()].filter(row=>row.at===latest.get(row.account+'|'+row.day)).flatMap(row=>{
  const events=eventGroups.get(JSON.stringify([row.account,row.day]))||[],tail=events.filter(e=>Date.parse(e.time)>Date.parse(row.at));
  if(tail.length&&events.some(e=>!clean(e)))return [];
  const through=tail.length?new Date(Math.max(...tail.map(e=>Date.parse(e.time)))).toISOString():row.at;
  return [{...row,net:round(row.net+tail.reduce((sum,e)=>sum+e.net!,0)),through}];
 });
 return {sessions:currentSessions.sort((a,b)=>a.day.localeCompare(b.day)||a.account.localeCompare(b.account)),readings};
}

// Use fresh, verified values at both cash endpoints. A different connection or
// session never supplies a native delta; the execution ledger remains fallback.
export function reportedTradingDelta(account:string,from:string,to:string,readings?:ReadonlyMap<string,NativePnlReading>){
 const before=readings?.get(nativeReadingKey(account,from)),after=readings?.get(nativeReadingKey(account,to));
 return before&&after&&series(before)===series(after)?round(after.net-before.net):null;
}

export function reportedCheckpoint(account:string,capturedAt:string,reported:{sessions:ReportedSession[];readings:ReadonlyMap<string,NativePnlReading>},events:readonly RealizedEvent[]):RealizedCheckpoint|null{
 const day=flexSession(capturedAt),at=Date.parse(capturedAt),session=reported.sessions.find(r=>r.account===account&&r.day===day),points=[...reported.readings.values()].filter(r=>r.account===account&&flexSession(r.at)===day).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 const before=points.filter(r=>Date.parse(r.at)<=at).at(-1),last=points.find(r=>r.at===session?.at);
 if(!before||!last||Date.parse(session?.through??last.at)<at||series(before)!==series(last))return null;
 const between=events.filter(e=>e.account===account&&Date.parse(e.time)>Date.parse(before.at)&&Date.parse(e.time)<=at);
 if(between.some(e=>!clean(e)))return null;
 const net=round(before.net+between.reduce((sum,e)=>sum+e.net!,0));
 return {account,capturedAt,session:day,net,afterNet:round(session!.net-net)};
}
