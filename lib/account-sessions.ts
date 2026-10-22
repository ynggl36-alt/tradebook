import {round} from './analytics';
import {flexSession} from './trading-session';
import {realizedEvents} from './realized';
import type {RealizedCheckpoint,RealizedEvent} from './realized';
import type {Fill} from './types';
import {normalizeContract} from './csv';

export type ReportedSession={account:string;day:string;net:number;at:string;through?:string};
export type NativePnlReading={account:string;at:string;net:number;cash:number;connection:string;provider:string};
export type NativePnlRow={account:string;capturedAt:string;net:number|null;netAt:string|null;cash:number|null;cashAt:string|null;connected:number;currency:string;connection:string;provider:string;positionsAvailable?:number;positionsAt?:string|null;positionData?:string|null};
export const nativeReadingKey=(account:string,at:string)=>account+'@'+at;
const series=(r:NativePnlReading)=>JSON.stringify([r.account,r.connection,r.provider,flexSession(r.at)]);
const clean=(event:RealizedEvent)=>event.net!==null&&!event.unmatched&&!event.coverageIssues;
const connectionKey=(row:{account:string;connection:string;provider:string})=>JSON.stringify([row.account,row.connection,row.provider]);
function currentPositions(row:NativePnlRow):Map<string,number>|null{
 if(!row.positionsAvailable||row.positionsAt!==row.capturedAt||typeof row.positionData!=='string')return null;
 try{
  const raw=JSON.parse(row.positionData);if(!Array.isArray(raw)||raw.length>100)return null;
  const positions=new Map<string,number>();
  for(const position of raw){
   if(!position||typeof position.instrument!=='string'||!['Long','Short'].includes(position.side)||!Number.isSafeInteger(position.quantity)||position.quantity<=0||position.quantity>100000)return null;
   const contract=normalizeContract(position.instrument).contract;if(positions.has(contract))return null;
   positions.set(contract,position.quantity*(position.side==='Long'?1:-1));
  }
  return positions;
 }catch{return null;}
}
type Projection={events:RealizedEvent[];fills:readonly Fill[];from:string;through?:string};
function positionsAgree(projection:Projection,point:NativePnlRow){
 const observed=currentPositions(point);if(!observed)return false;
 const expected=new Map<string,number>();
 for(const fill of projection.fills)if(Date.parse(fill.time)<=Date.parse(point.capturedAt))expected.set(fill.contract,(expected.get(fill.contract)||0)+(fill.side==='Buy'?fill.qty:-fill.qty));
 for(const [contract,quantity]of expected)if(quantity!==(observed.get(contract)||0))return false;
 return [...observed].every(([contract,quantity])=>quantity===(expected.get(contract)||0));
}

// A provider's realized field is not assumed to be net or to reset at our
// session boundary. Verify each account/connection/session against a clean
// execution prefix that includes fees. Later broken execution Position metadata
// cannot overwrite the independently observed account result.
export function reportedAccountSessions(rows:readonly NativePnlRow[],eventsByAccount:ReadonlyMap<string,readonly RealizedEvent[]>,asOf=Date.now(),fillsByAccount:ReadonlyMap<string,readonly Fill[]>=new Map()){
 const readings=new Map<string,NativePnlReading>(),sessions=new Map<string,ReportedSession>(),latest=new Map<string,string>();
 const groups=new Map<string,NativePnlReading[]>(),snapshots=new Map<string,NativePnlRow>(),flat=new Map<string,NativePnlRow[]>(),candidates=new Map<string,Projection|null>(),projections=new Map<string,Projection>();
 for(const row of rows){
  if(row.connected&&row.currency==='USD'&&Number.isFinite(Date.parse(row.capturedAt))&&Date.parse(row.capturedAt)<=asOf){
   snapshots.set(nativeReadingKey(row.account,row.capturedAt),row);
   const positions=currentPositions(row);if(positions?.size===0){const key=connectionKey(row),group=flat.get(key)||[];group.push(row);flat.set(key,group);}
  }
  if(!row.connected||row.currency!=='USD'||row.netAt!==row.capturedAt||row.cashAt!==row.capturedAt||row.net===null||row.cash===null||!Number.isFinite(row.net)||!Number.isFinite(row.cash)||!Number.isFinite(Date.parse(row.capturedAt))||Date.parse(row.capturedAt)>asOf)continue;
  const dayKey=row.account+'|'+flexSession(row.capturedAt),latestAt=latest.get(dayKey);if(!latestAt||Date.parse(row.capturedAt)>Date.parse(latestAt))latest.set(dayKey,row.capturedAt);
  const reading:NativePnlReading={account:row.account,at:row.capturedAt,net:row.net,cash:row.cash,connection:row.connection,provider:row.provider},key=series(reading),group=groups.get(key)||[];group.push(reading);groups.set(key,group);
 }
 const eventGroups=new Map<string,RealizedEvent[]>();
 for(const [account,events]of eventsByAccount)for(const event of events){if(Date.parse(event.time)>asOf)continue;const key=JSON.stringify([account,flexSession(event.time)]),group=eventGroups.get(key)||[];group.push(event);eventGroups.set(key,group);}
 for(const group of flat.values())group.sort((a,b)=>Date.parse(a.capturedAt)-Date.parse(b.capturedAt));
 const projectionFor=(point:NativePnlReading,events:readonly RealizedEvent[])=>{
  const key=series(point);if(candidates.has(key))return candidates.get(key)!;
  const first=events.length?Math.min(...events.map(e=>Date.parse(e.time))):NaN,anchor=flat.get(connectionKey(point))?.filter(row=>Date.parse(row.capturedAt)<first).at(-1),source=fillsByAccount.get(point.account);
  let projection:Projection|null=null;
  if(anchor&&source){
   const fills=source.filter(fill=>Date.parse(fill.time)>Date.parse(anchor.capturedAt)&&Date.parse(fill.time)<=asOf);
   // Position is corroborating metadata, never a missing economic execution.
   // A recorded flat inventory supplies the opening basis. The same FIFO/fee
   // engine then projects immutable fills without that redundant position field.
   projection={fills,from:anchor.capturedAt,events:realizedEvents(point.account,fills.map(fill=>({...fill,pos:null}))).filter(event=>flexSession(event.time)===flexSession(point.at))};
  }
  candidates.set(key,projection);return projection;
 };
 for(const points of groups.values()){
  points.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));const first=points[0],day=flexSession(first.at),events=[...(eventGroups.get(JSON.stringify([first.account,day]))||[])].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
  let index=0,total=0,fees=0,complete=true,verified=false,previous:NativePnlReading|undefined;
  for(const point of points){
   while(index<events.length&&Date.parse(events[index].time)<=Date.parse(point.at)){const event=events[index++];complete=complete&&clean(event);total+=event.net??0;fees+=event.commissions??0;}
   if(previous&&point.net===0&&previous.net!==0)verified=false;
   if(complete&&fees>0&&Math.abs(round(total)-point.net)<.01)verified=true;
   if(!verified||projections.has(series(point))){
    const projection=projectionFor(point,events),snapshot=snapshots.get(nativeReadingKey(point.account,point.at)),prefix=projection?.events.filter(event=>Date.parse(event.time)<=Date.parse(point.at));
    if(projection&&snapshot&&prefix?.length&&prefix.every(clean)&&prefix.some(event=>(event.commissions??0)>0)&&Math.abs(round(prefix.reduce((sum,event)=>sum+event.net!,0))-point.net)<.01&&positionsAgree(projection,snapshot)){verified=true;projections.set(series(point),{...projection,through:point.at});}
   }
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
 // Reconcile only the independently checked prefix. Later fills and all other
 // sessions keep their original coverage state; nothing is added or persisted.
 const replacements=new Map<string,RealizedEvent>();
 for(const projection of projections.values())for(const event of projection.events)if(Date.parse(event.time)<=Date.parse(projection.through!))replacements.set(JSON.stringify([event.account,event.fillId]),event);
 const reconciledEvents=new Map([...eventsByAccount].map(([account,events])=>[account,events.map(event=>replacements.get(JSON.stringify([account,event.fillId]))||event)]));
 return {sessions:currentSessions.sort((a,b)=>a.day.localeCompare(b.day)||a.account.localeCompare(b.account)),readings,projections,reconciledEvents};
}

// Use fresh, verified values at both cash endpoints. A different connection or
// session never supplies a native delta; the execution ledger remains fallback.
export function reportedTradingDelta(account:string,from:string,to:string,readings?:ReadonlyMap<string,NativePnlReading>){
 const before=readings?.get(nativeReadingKey(account,from)),after=readings?.get(nativeReadingKey(account,to));
 return before&&after&&series(before)===series(after)?round(after.net-before.net):null;
}

export function reportedCheckpoint(account:string,capturedAt:string,reported:{sessions:ReportedSession[];readings:ReadonlyMap<string,NativePnlReading>;projections?:ReadonlyMap<string,Projection|null>},events:readonly RealizedEvent[]):RealizedCheckpoint|null{
 const day=flexSession(capturedAt),at=Date.parse(capturedAt),session=reported.sessions.find(r=>r.account===account&&r.day===day),points=[...reported.readings.values()].filter(r=>r.account===account&&flexSession(r.at)===day).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
 const before=points.filter(r=>Date.parse(r.at)<=at).at(-1),last=points.find(r=>r.at===session?.at);
 if(!last||Date.parse(session?.through??last.at)<at||(before&&series(before)!==series(last)))return null;
 const projection=reported.projections?.get(series(last));
 if(projection&&at>=Date.parse(projection.from)&&at<=Date.parse(projection.through!)){
  const prefix=projection.events.filter(event=>Date.parse(event.time)<=at);if(prefix.some(event=>!clean(event)))return null;
  const net=round(prefix.reduce((sum,event)=>sum+event.net!,0));return {account,capturedAt,session:day,net,afterNet:round(session!.net-net)};
 }
 if(!before)return null;
 const source=events;
 const between=source.filter(e=>e.account===account&&Date.parse(e.time)>Date.parse(before.at)&&Date.parse(e.time)<=at);
 if(between.some(e=>!clean(e)))return null;
 const net=round(before.net+between.reduce((sum,e)=>sum+e.net!,0));
 return {account,capturedAt,session:day,net,afterNet:round(session!.net-net)};
}
