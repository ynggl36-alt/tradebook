import type {AccountProfile} from './types';
import type {NativePnlRow} from './account-sessions';
import type {FirmReference} from './firm-reference';
import type {FirmAdjustmentNotice} from './balance-adjustments';
import type {RealizedEvent} from './realized';
import {accountStage,flexAccount} from './lucid-flex';
import {flexSession,flexSessionStart} from './trading-session';
import {round} from './analytics';

const INITIAL_FLOOR=48000,TRAIL=2000,LOCKED_FLOOR=50100;
export type EvaluationObservation=NativePnlRow&{equity?:number|null;equityAt?:string|null;floating?:number|null;floatingAt?:string|null};
export type EvaluationFailure={account:string;at:string;balance:number;floor:number;source:'cash'|'equity'|'cash-and-floating'};
const terminal=new Set(['Failed','Upgraded','Retired']);
export function effectiveAccountStatus(account:string,profile:AccountProfile|undefined,failures:readonly EvaluationFailure[]=[]){
 return terminal.has(profile?.status||'')?profile!.status:failures.some(row=>row.account===account)?'Failed':profile?.status||'Unclassified';
}
function flat(row:EvaluationObservation){
 if(!row.positionsAvailable||row.positionsAt!==row.capturedAt||!row.positionData)return false;
 try{const positions=JSON.parse(row.positionData);return Array.isArray(positions)&&positions.length===0;}catch{return false;}
}
const fresh=(value:number|null|undefined,at:string|null|undefined,row:EvaluationObservation):value is number=>typeof value==='number'&&Number.isFinite(value)&&at===row.capturedAt;
// Cash is decisive when flat. In a position use synchronized cash + floating
// P&L, or a supported positive net liquidation reading. Unsupported zero fields
// and retained values from an earlier capture never establish a breach.
export function observedEvaluationEquity(row:EvaluationObservation):{value:number;source:EvaluationFailure['source']}|null{
 if(!row.connected||row.currency!=='USD')return null;
 const cash=fresh(row.cash,row.cashAt,row)&&row.cash>0?row.cash:null;
 if(cash!==null&&flat(row))return {value:round(cash),source:'cash'};
 if(cash!==null&&fresh(row.floating,row.floatingAt,row))return {value:round(cash+row.floating),source:'cash-and-floating'};
 if(fresh(row.equity,row.equityAt,row)&&row.equity>0)return {value:round(row.equity),source:'equity'};
 return null;
}
type Item={at:number;order:number;event?:RealizedEvent;point?:EvaluationObservation;floor?:number;notice?:boolean};
type Input={rows:readonly EvaluationObservation[];events:ReadonlyMap<string,readonly RealizedEvent[]>;profiles?:readonly AccountProfile[];references?:readonly FirmReference[];notices?:readonly FirmAdjustmentNotice[];asOf?:number};

// Replay immutable observations, never just the latest balance. The first
// captured breach remains available after disappearance or a later higher read.
// This is display state: no profile, execution or financial record is rewritten.
export function evaluationFailures({rows,events,profiles=[],references=[],notices=[],asOf=Date.now()}:Input):EvaluationFailure[]{
 const grouped=new Map<string,EvaluationObservation[]>(),failures:EvaluationFailure[]=[],hours=new Map<number,string>();
 for(const row of rows){const group=grouped.get(row.account)||[];group.push(row);grouped.set(row.account,group);}
 const sessionAt=(at:number)=>{const hour=Math.floor(at/3600000);let day=hours.get(hour);if(!day){day=flexSession(new Date(at).toISOString());hours.set(hour,day);}return day;};
 for(const [account,points] of grouped){
  const profile=profiles.find(row=>row.account===account),reference=references.find(row=>row.account===account);
  if(flexAccount(account)?.stage!=='Evaluation'||accountStage(account,profile,reference)!=='Evaluation')continue;
  const items:Item[]=[];
  for(const event of events.get(account)||[]){const at=Date.parse(event.time);if(Number.isFinite(at)&&at<=asOf)items.push({at,order:1,event});}
  for(const point of points){const at=Date.parse(point.capturedAt);if(point.connected&&point.currency==='USD'&&Number.isFinite(at)&&at<=asOf)items.push({at,order:2,point});}
  // A dated firm floor applies from its recorded time, never retroactively.
  if(reference?.minimumBalance!==null&&reference?.minimumBalance!==undefined){
   const at=Date.parse(reference.flex?.capturedAt||reference.savedAt),floor=reference.minimumBalance;
   if(Number.isFinite(at)&&at<=asOf&&floor>=INITIAL_FLOOR&&floor<=LOCKED_FLOOR)items.push({at,order:0,floor});
  }
  const noticeDays=new Set(notices.filter(row=>row.accounts.includes(account)).map(row=>row.date));
  for(const day of noticeDays){const at=Date.parse(flexSessionStart(day));if(at<=asOf)items.push({at,order:0,notice:true});}
  items.sort((a,b)=>a.at-b.at||a.order-b.order);
  // Compare actual cash endpoints with account-wide execution deltas before
  // trusting modeled closes between them. The cash model starts only when an
  // actual settled reading supplies a basis; future reads never invent one for
  // earlier evidence. Exact session-close snapshots are unnecessary thereafter.
  let prefix=0,issues=0,previousFill=-Infinity;
  let anchor:{at:number;cash:number;prefix:number;issues:number}|undefined;
  const contradictions:{from:number;to:number}[]=[];
  for(const item of items){
   if(item.notice)issues++;
   if(item.event){const e=item.event;previousFill=item.at;if(e.net===null||e.unmatched||e.coverageIssues)issues++;else prefix=round(prefix+e.net);}
   const p=item.point;
   if(p&&p.connected&&p.currency==='USD'&&fresh(p.cash,p.cashAt,p)&&p.cash>0&&item.at-previousFill>=180000){
    // A clean-looking imported suffix can still omit a roundtrip. Contradictory
    // actual cash endpoints invalidate modeled closes between those endpoints;
    // don't classify the later endpoint using that uncorroborated higher floor.
    if(anchor&&(issues!==anchor.issues||round(p.cash-anchor.cash)!==round(prefix-anchor.prefix)))contradictions.push({from:anchor.at,to:item.at});
    anchor={at:item.at,cash:p.cash,prefix,issues};
   }
  }
  let balance:number|null=null,floor=INITIAL_FLOOR,day='',lastFill=-Infinity;
  for(const item of items){
   const session=sessionAt(item.at);
   // Only a completed prior session can advance the trail. Intraday peaks and
   // partial-session snapshot highs never raise it. Unknown fees/inventory stop
   // the model until a subsequent settled cash reading supplies a basis.
   if(day&&session!==day&&balance!==null&&!noticeDays.has(day)){
    const boundary=Date.parse(flexSessionStart(session));
    if(!contradictions.some(gap=>gap.from<boundary&&gap.to>=boundary))floor=round(Math.max(floor,Math.min(LOCKED_FLOOR,balance-TRAIL)));
   }
   day=session;
   if(item.notice)balance=null;
   if(item.floor!==undefined)floor=Math.max(floor,item.floor);
   if(item.event){
    const e=item.event;lastFill=item.at;
    balance=balance===null||e.net===null||e.unmatched||e.coverageIssues?null:round(balance+e.net);
   }
   if(item.point){
    const point=item.point,value=observedEvaluationEquity(point);
    if(value&&value.value<=floor){failures.push({account,at:point.capturedAt,balance:value.value,floor,source:value.source});break;}
    // Do not anchor the cash model to a read that may precede delayed fill/cash
    // posting. Direct breach evidence above does not require this model anchor.
    if(point.connected&&point.currency==='USD'&&fresh(point.cash,point.cashAt,point)&&point.cash>0&&item.at-lastFill>=180000)balance=point.cash;
   }
  }
 }
 return failures.sort((a,b)=>a.at.localeCompare(b.at)||a.account.localeCompare(b.account));
}
