import type {AccountState} from './account-state';
import type {AccountProfile,CashRecord} from './types';
import type {FirmReference} from './firm-reference';
import {accountStage} from './lucid-flex';
import type {RealizedEvent} from './realized';
import {addDays,centralDay,round} from './analytics';
import {payoutProceeds} from './payouts';

export type BalanceObservation={id:string;account:string;capturedAt:string;recorderVersion:string;running:boolean;origin:'capture'|'legacy'|'not-seen';state:AccountState;receivedAt?:string};
export type BalanceInterval={before:BalanceObservation;after:BalanceObservation;gap?:boolean};
export type AdjustmentKind='likely-payout'|'payout'|'firm-adjustment'|'unexplained'|'credit'|'ignore';
export type AdjustmentLabel={id:string;kind:'payout'|'firm-adjustment'|'unexplained'|'ignore';note:string;updatedAt:string};
export type BalanceAdjustment={id:string;account:string;date:string;from:string;to:string;before:number;after:number;tradingNet:number|null;amount:number|null;kind:AdjustmentKind;settled:boolean;source:'automatic-estimate'|'firm-record'|'owner';payoutId?:string;possiblePayoutIds:string[];reasons:string[];note:string};
export type BalanceTracking={observations:number;first:string|null;last:string|null};
export type FirmAdjustmentNotice={id:string;date:string;accounts:string[];kind:'hedging-profit-removal';amount:null;source:string};
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
// Compare automatically recorded balances with saved trading results. Payout
// classification does not depend on a firm's eligibility rules, split, recorder
// cadence, flat positions, provenance label or a fixed deduction range.
export type PayoutDetectionContext={profiles?:AccountProfile[];firmReferences?:FirmReference[]};
export function deriveBalanceAdjustments(intervals:BalanceInterval[],eventsByAccount:Map<string,RealizedEvent[]>,cash:CashRecord[],labels:AdjustmentLabel[]=[],now=Date.now(),notices:FirmAdjustmentNotice[]=[],context:PayoutDetectionContext={}):BalanceAdjustment[]{
 const overrides=new Map(labels.map(label=>[label.id,label])),rows:BalanceAdjustment[]=[];
 const profiles=new Map((context.profiles||[]).map(profile=>[profile.account,profile])),references=new Map((context.firmReferences||[]).map(reference=>[reference.account,reference]));
 for(const {before,after} of intervals){
  const left=before.state,right=after.state,a=left.values.CashValue,b=right.values.CashValue;
  if(!a||!b||Date.parse(b.at)<=Date.parse(a.at)||left.currency!==right.currency||right.currency!=='USD')continue;
  const from=Date.parse(a.at),to=Date.parse(b.at),events=eventsByAccount.get(after.account);
  const relevant=(events||[]).filter(event=>Date.parse(event.time)>from&&Date.parse(event.time)<=to);
  const unknown=events===undefined||relevant.some(event=>event.net===null||(event.coverageIssues||0)>0);
  const tradingNet=unknown?null:round(relevant.reduce((sum,event)=>sum+event.net!,0)),amount=tradingNet===null?null:round(b.value-a.value-tradingNet);
  if(amount!==null&&Math.abs(amount)<.01)continue;
  if(amount===null&&Math.abs(b.value-a.value)<.01)continue;
  const reasons:string[]=[];
  if(unknown)reasons.push('Saved trading results are incomplete; the account deduction cannot be separated from trading P&L.');
  const funded=accountStage(after.account,profiles.get(after.account),references.get(after.account))==='Funded';
  if(!funded)reasons.push('The account is not classified as funded.');
  const lastReceived=Math.max(to,Date.parse(before.receivedAt||a.at),Date.parse(after.receivedAt||b.at)),settled=now-lastReceived>=180000;
  if(!settled)reasons.push('Waiting briefly for execution uploads to settle.');
  const id='adjustment:'+before.id+'>'+after.id,label=overrides.get(id),debit=amount!==null&&amount<0?-amount:null;
  const eligible=debit===null?[]:cash.filter(record=>record.kind==='payout'&&record.account===after.account&&payoutDateMatches(record,a.at,b.at));
  const matches=eligible.filter(record=>payoutProceeds(record).gross!==null&&Math.abs(payoutProceeds(record).gross!-debit!)<.01);
  // Legacy share-only source amounts cannot be converted back into account
  // deductions. Keep possible overlap visible without applying an old split.
  const possible=eligible.filter(record=>matches.includes(record)||record.payoutAmountBasis==='trader-share');
  const incident=notices.find(notice=>notice.accounts.includes(after.account)&&notice.date>=centralDay(a.at)&&notice.date<=centralDay(b.at));
  let kind:AdjustmentKind=amount!==null&&amount>0?'credit':incident?'firm-adjustment':debit!==null&&funded?'payout':'unexplained';
  const linked=matches.length===1&&possible.length===1&&settled;
  if(linked&&!incident)kind='payout';
  if(possible.length&&!linked)reasons.push('A saved payout may explain this deduction; it is excluded from additional payout totals.');
  if(label)kind=label.kind;
  rows.push({id,account:after.account,date:centralDay(b.at),from:a.at,to:b.at,before:a.value,after:b.value,tradingNet,amount,kind,settled,source:label?'owner':'automatic-estimate',...(linked&&!incident?{payoutId:matches[0].id}:{}),possiblePayoutIds:possible.map(record=>record.id),reasons,note:label?.note??(incident?incident.source:'')});
 }
 const uses=new Map<string,number>();for(const row of rows)if(row.payoutId)uses.set(row.payoutId,(uses.get(row.payoutId)||0)+1);
 return rows.map(row=>row.payoutId&&(uses.get(row.payoutId)||0)>1?{...row,payoutId:undefined,kind:row.source==='owner'?row.kind:'unexplained' as const,reasons:[...row.reasons,'More than one deduction could match the same payout.']}:row).sort((a,b)=>b.to.localeCompare(a.to)||a.id.localeCompare(b.id));
}
export function unrecordedPayouts(rows:BalanceAdjustment[]){
 return rows.filter(row=>row.settled&&!row.payoutId&&!row.possiblePayoutIds.length&&(row.kind==='likely-payout'||row.kind==='payout')&&row.amount!==null&&row.amount<0);
}
export function inferredPayoutSummary(rows:BalanceAdjustment[]){
 const values=unrecordedPayouts(rows);
 return {count:values.length,gross:round(values.reduce((sum,row)=>sum-row.amount!,0))};
}
