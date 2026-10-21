import firmNotices from '../data/firm-adjustments.json';
import type {AccountState} from './account-state';
import type {CashRecord} from './types';
import type {RealizedEvent} from './realized';
import {addDays,centralDay,round} from './analytics';
import {payoutProceeds,LUCID_TRADER_SPLIT} from './payouts';

export type BalanceObservation={id:string;account:string;capturedAt:string;recorderVersion:string;running:boolean;origin:'capture'|'legacy'|'not-seen';state:AccountState;receivedAt?:string};
export type BalanceInterval={before:BalanceObservation;after:BalanceObservation;gap?:boolean};
export type AdjustmentKind='likely-payout'|'payout'|'firm-adjustment'|'unexplained'|'credit'|'ignore';
export type AdjustmentLabel={id:string;kind:'payout'|'firm-adjustment'|'unexplained'|'ignore';note:string;updatedAt:string};
export type BalanceAdjustment={id:string;account:string;date:string;from:string;to:string;before:number;after:number;tradingNet:number|null;amount:number|null;kind:AdjustmentKind;settled:boolean;source:'automatic-estimate'|'firm-record'|'owner';payoutId?:string;possiblePayoutIds:string[];expectedShare:number|null;reasons:string[];note:string};
export type BalanceTracking={observations:number;first:string|null;last:string|null};
export type FirmAdjustmentNotice={id:string;date:string;accounts:string[];kind:'hedging-profit-removal';amount:null;source:string};
// Owner-specific notices are private release data, never public source history.
export const KNOWN_FIRM_ADJUSTMENTS:FirmAdjustmentNotice[]=firmNotices as FirmAdjustmentNotice[];
export function canonicalJson(value:unknown):string{
 if(value===null||typeof value!=='object')return JSON.stringify(value)??'null';
 if(Array.isArray(value))return '['+value.map(canonicalJson).join(',')+']';
 return '{'+Object.keys(value).filter(key=>(value as Record<string,unknown>)[key]!==undefined).sort().map(key=>JSON.stringify(key)+':'+canonicalJson((value as Record<string,unknown>)[key])).join(',')+'}';
}
export function observation(state:AccountState,recorderVersion:string,running:boolean,origin:BalanceObservation['origin']='capture'):BalanceObservation{
 return {id:(origin==='legacy'?'legacy:':'')+state.account+'@'+state.capturedAt,account:state.account,capturedAt:state.capturedAt,recorderVersion,running,origin,state};
}
export function balanceIntervals(input:BalanceObservation[]):BalanceInterval[]{
 const groups=new Map<string,Map<string,BalanceObservation>>();
 for(const row of input){const group=groups.get(row.account)||new Map<string,BalanceObservation>(),old=group.get(row.capturedAt);if(old&&old.origin!=='legacy'&&row.origin!=='legacy'&&canonicalJson(old)!==canonicalJson(row))throw new Error('Conflicting balance observations at the same capture time.');if(!old||old.origin==='legacy')group.set(row.capturedAt,row);groups.set(row.account,group);}
 return [...groups.values()].flatMap(group=>{const points=[...group.values()].sort((a,b)=>a.capturedAt.localeCompare(b.capturedAt));return points.slice(1).map((after,i)=>({before:points[i],after}));});
}
function payoutDateMatches(record:CashRecord,from:string,to:string){const day=record.firmPayout?.approvedDate??record.date,start=addDays(centralDay(from),-3),end=record.firmPayout?centralDay(to):addDays(centralDay(to),3);return day>=start&&day<=end;}
// Recorder pauses are ordinary around EOD payouts. Bridge a bounded pause only
// for inferred Lucid 50K payouts; missing saved activity remains a caveat, not
// proof of a cash receipt or of complete activity while the recorder was closed.
export const PAYOUT_CAPTURE_WINDOW_MS=72*60*60000;
export function deriveBalanceAdjustments(intervals:BalanceInterval[],eventsByAccount:Map<string,RealizedEvent[]>,cash:CashRecord[],labels:AdjustmentLabel[]=[],now=Date.now(),notices:FirmAdjustmentNotice[]=KNOWN_FIRM_ADJUSTMENTS):BalanceAdjustment[]{
 const overrides=new Map(labels.map(label=>[label.id,label])),rows:BalanceAdjustment[]=[];
 for(const {before,after,gap} of intervals){
  const left=before.state,right=after.state,a=left.values.CashValue,b=right.values.CashValue;
  if(!a||!b||Date.parse(b.at)<=Date.parse(a.at)||left.currency!==right.currency||right.currency!=='USD')continue;
  const from=Date.parse(a.at),to=Date.parse(b.at);
  const reasons:string[]=[],events=eventsByAccount.get(after.account),relevant=(events||[]).filter(event=>Date.parse(event.time)>from&&Date.parse(event.time)<=to);
  const unknown=!events?.length||relevant.some(event=>event.net===null||(event.coverageIssues||0)>0),tradingNet=unknown?null:round(relevant.reduce((sum,event)=>sum+event.net!,0)),amount=tradingNet===null?null:round(b.value-a.value-tradingNet);
  if(amount!==null&&Math.abs(amount)<.01)continue;
  if(amount===null&&Math.abs(b.value-a.value)<.01)continue;
  if(tradingNet===null)reasons.push('Execution or commission coverage is incomplete.');
  const fresh=from===Date.parse(before.capturedAt)&&to===Date.parse(after.capturedAt);
  if(!fresh)reasons.push('A balance value was retained from an older read.');
  const connected=left.connected&&right.connected&&before.origin!=='not-seen'&&after.origin!=='not-seen';
  if(!connected||gap)reasons.push('The interval includes an account disconnection or absence.');
  const sameProvider=!!left.provider&&left.provider===right.provider&&left.connection===right.connection;
  if(!sameProvider)reasons.push('The provider or connection changed or is unknown.');
  const flat=left.positionsAvailable&&right.positionsAvailable&&Date.parse(left.positionsAt||'')===Date.parse(before.capturedAt)&&Date.parse(right.positionsAt||'')===Date.parse(after.capturedAt)&&!left.positions.length&&!right.positions.length;
  if(!flat)reasons.push('Both interval endpoints are not confirmed flat.');
  if((events||[]).some(event=>Date.parse(event.time)===from||Date.parse(event.time)===to))reasons.push('An execution shares a balance observation timestamp.');
  if(before.origin!=='capture'||after.origin!=='capture')reasons.push('An endpoint is a legacy or synthetic observation.');
  const accountingReady=reasons.length===0,cadenceWarnings:string[]=[];
  if(!before.running||!after.running)cadenceWarnings.push('A snapshot reported the recorder stopped; the estimate uses saved executions and may omit activity during the pause.');
  if(to-from>20*60000)cadenceWarnings.push('The capture gap may include unrecorded activity; the estimate uses the saved execution history.');
  const recognizedFunded=/^LFF050\d+$/i.test(after.account),withinWindow=to-from<=PAYOUT_CAPTURE_WINDOW_MS;
  if(!withinWindow)reasons.push('Balance captures are more than 72 hours apart.');
  reasons.push(...cadenceWarnings);
  const inferenceReady=accountingReady&&withinWindow&&(cadenceWarnings.length===0||recognizedFunded);
  const lastReceived=Math.max(Date.parse(b.at),Date.parse(before.receivedAt||a.at),Date.parse(after.receivedAt||b.at)),settled=now-lastReceived>=180000;
  if(!settled)reasons.push('Waiting briefly for execution uploads to settle.');
  const id='adjustment:'+before.id+'>'+after.id,label=overrides.get(id),debit=amount!==null&&amount<0?-amount:null;
  const eligible=debit===null?[]:cash.filter(record=>record.kind==='payout'&&record.account===after.account&&payoutDateMatches(record,a.at,b.at));
  const matches=eligible.filter(record=>payoutProceeds(record).gross!==null&&Math.abs(payoutProceeds(record).gross!-debit!)<.01);
  const possible=eligible.filter(record=>{const value=payoutProceeds(record);return matches.includes(record)||(value.gross===null&&value.expected!==null&&value.split!==null&&Math.abs(value.expected/value.split-debit!)<.02);});
  const incident=notices.find(incident=>incident.accounts.includes(after.account)&&incident.date>=centralDay(a.at)&&incident.date<=centralDay(b.at));
  const likely=!!debit&&recognizedFunded&&debit>=500&&debit<=2000&&inferenceReady&&settled;
  let kind:AdjustmentKind=amount!==null&&amount>0?'credit':incident?'firm-adjustment':likely?'likely-payout':'unexplained';
  // Linking an existing confirmation keeps the stricter cadence requirement.
  // Paused candidates still exclude possible matches from additional proceeds.
  const linked=matches.length===1&&possible.length===1&&settled&&accountingReady&&cadenceWarnings.length===0;
  if(linked){kind='payout';}
  else if(possible.length)reasons.push('A recorded payout may explain this change; it is excluded from additional payout estimates.');
  if(label)kind=label.kind;
  rows.push({id,account:after.account,date:centralDay(b.at),from:a.at,to:b.at,before:a.value,after:b.value,tradingNet,amount,kind,settled,source:label?'owner':'automatic-estimate',...(linked?{payoutId:matches[0].id}:{}),possiblePayoutIds:possible.map(record=>record.id),expectedShare:debit!==null&&['likely-payout','payout'].includes(kind)?Math.round(Math.round(debit*100)*LUCID_TRADER_SPLIT)/100:null,reasons,note:label?.note??(incident?incident.source:'')});
 }
 // One known payout cannot explain two separate deductions. Keep ambiguous
 // candidates visible, but exclude them from inferred proceeds to avoid doubles.
 const uses=new Map<string,number>();for(const row of rows)if(row.payoutId)uses.set(row.payoutId,(uses.get(row.payoutId)||0)+1);
 return rows.map(row=>row.payoutId&&(uses.get(row.payoutId)||0)>1?{...row,payoutId:undefined,kind:row.source==='owner'?row.kind:'unexplained' as const,source:row.source==='owner'?'owner' as const:'automatic-estimate' as const,expectedShare:row.source==='owner'?row.expectedShare:null,reasons:[...row.reasons,'More than one deduction could match the same payout.']}:row).sort((a,b)=>b.to.localeCompare(a.to)||a.id.localeCompare(b.id));
}
export function unrecordedPayouts(rows:BalanceAdjustment[]){
 return rows.filter(row=>row.settled&&!row.payoutId&&!row.possiblePayoutIds.length&&(row.kind==='likely-payout'||(row.kind==='payout'&&row.source==='owner'))&&row.amount!==null&&row.amount<0);
}
export function inferredPayoutSummary(rows:BalanceAdjustment[]){
 const values=unrecordedPayouts(rows);
 return {count:values.length,gross:round(values.reduce((sum,row)=>sum-row.amount!,0)),expected:round(values.reduce((sum,row)=>sum+(row.expectedShare||0),0))};
}
