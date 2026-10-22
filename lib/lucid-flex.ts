import type {AccountProfile,CashRecord,Trade} from './types';
import type {FirmReference} from './firm-reference';
import type {RealizedCheckpoint,RealizedDay} from './realized';
import type {BalanceAdjustment} from './balance-adjustments';
import {addDays,centralDay,centralHour,round} from './analytics';
import {netTradePnl} from './trading-costs';

export const FLEX_RULES_CHECKED='2026-10-19';
export const FLEX_PAYOUT_URL='https://support.lucidtrading.com/en/articles/12945796-lucidflex-payouts';
export const FLEX_EVAL_URL='https://support.lucidtrading.com/en/articles/12945790-lucidflex-evaluation-account';
export const FLEX_CONSISTENCY_URL='https://support.lucidtrading.com/en/articles/12945805-lucidflex-consistency-percentage';
export const FLEX_DAILY_MIN=150,FLEX_PROFIT_DAYS=5,FLEX_BASE_TARGET=3000;
export type FlexLedgerOptions={sessions?:RealizedDay[];checkpoints?:RealizedCheckpoint[];adjustments?:BalanceAdjustment[]};
type FlexReason='checkpoint'|'payout'|'possible-payout'|'costs'|'coverage'|'baseline'|'approval-time'|null;
// These exact 50K naming families are confirmed by the owner's Lucid screenshots.
// Explicit classifications override the prefix; other products remain unclassified.
export function flexAccount(account:string){const m=/^LF([EF])050\d+$/i.exec(account);return m?{stage:m[1].toUpperCase()==='E'?'Evaluation' as const:'Funded' as const}:null;}
export function accountStage(account:string,profile?:AccountProfile,reference?:FirmReference){return profile?.stage&&profile.stage!=='Unclassified'?profile.stage:reference?.flex?.stage||flexAccount(account)?.stage||'Unclassified';}
// A Sunday evening and the following Monday belong to one futures session.
// Lucid reopens at 18:00 Eastern / 17:00 Central, not local midnight.
export function flexSession(time:string){const day=centralDay(time);return centralHour(time)>=17?addDays(day,1):day;}
// Supplied session rows are authoritative, including an explicitly empty ledger.
// Evaluation callers pass rows for the same account(s) as their trade selection.
export function flexDaily(trades:Trade[],options?:FlexLedgerOptions){
 const days=new Map<string,{day:string;net:number|null}>();
 const add=(day:string,pnl:number|null)=>{const previous=days.get(day);days.set(day,{day,net:pnl===null||previous?.net===null?null:round((previous?.net||0)+pnl)});};
 if(options?.sessions!==undefined){for(const row of options.sessions)add(row.day,row.unmatched||(row.coverageIssues||0)?null:row.net);}
 else for(const trade of trades)add(flexSession(trade.exit),netTradePnl(trade));
 return [...days.values()].sort((a,b)=>a.day.localeCompare(b.day));
}
export function flexEvaluation(trades:Trade[],consistencyPercent:40|50|null,options?:FlexLedgerOptions){
 const days=flexDaily(trades,options),complete=days.length>0&&days.every(d=>d.net!==null);
 const net=complete?round(days.reduce((s,d)=>s+d.net!,0)):null,bestDay=complete?Math.max(0,...days.map(d=>d.net!)):null;
 // Use the strict published ratio. Lucid's small cushion is not a fixed dollar allowance.
 const target=bestDay!==null&&consistencyPercent!==null?Math.max(FLEX_BASE_TARGET,Math.ceil(bestDay/(consistencyPercent/100)*100)/100):FLEX_BASE_TARGET;
 return {net,bestDay,target,remaining:net===null?null:round(Math.max(0,target-net)),consistency:net!==null&&net>0&&bestDay!==null?bestDay/net*100:null,consistencyPercent,complete,days:days.length};
}
function tradeNet(trades:Trade[]){const values=trades.map(netTradePnl);return values.some(value=>value===null)?null:round(values.reduce<number>((sum,value)=>sum+value!,0));}
export function flexPayoutDays(account:string,trades:Trade[],reference:FirmReference|undefined,cash:CashRecord[],now=Date.now(),options?:FlexLedgerOptions){
 trades=trades.filter(trade=>trade.account===account&&Date.parse(trade.exit)<=now);
 const nowTime=new Date(now).toISOString(),day=flexSession(nowTime),sessions=options?.sessions?.filter(row=>row.account===account&&row.day<=day),ledger=options?.sessions!==undefined,checkpoint=reference?.flex;
 const daily=flexDaily(trades,{sessions}),today=daily.find(row=>row.day===day)?.net??null;
 const result={days:null as number|null,remaining:null as number|null,estimated:false,today,checkpointDate:reference?.date||null,reason:'checkpoint' as FlexReason};
 if(!checkpoint||checkpoint.stage!=='Funded'||checkpoint.qualifyingDays===null)return result;
 const at=Date.parse(checkpoint.capturedAt),checkpointDay=flexSession(checkpoint.capturedAt),checkpointDate=centralDay(checkpoint.capturedAt);
 // A detected debit does not establish approval or an exact cycle reset. Avoid
 // carrying an older ready-for-payout count through a possible new payout.
 if(options?.adjustments?.some(row=>row.account===account&&row.settled&&!row.settlementOffsetId&&row.amount!==null&&row.amount<0&&(row.kind==='likely-payout'||row.kind==='payout')&&Date.parse(row.to)>at&&Date.parse(row.to)<=now))return {...result,reason:'possible-payout' as const};
 // Received cash and deductions do not establish payout approval. A date-only
 // confirmation on the capture date cannot establish which happened first.
 let ambiguousApproval=false;
 for(const payout of cash){
  if(payout.account!==account||payout.kind!=='payout'||checkpoint.coveredPayoutIds?.includes(payout.id))continue;
  if(payout.payoutApprovalAt){const approvedAt=Date.parse(payout.payoutApprovalAt);if(approvedAt>at&&approvedAt<=now)return {...result,reason:'payout' as const};continue;}
  const approved=payout.firmPayout?.approvedDate;
  if(!approved||approved>centralDay(nowTime))continue;
  if(approved>checkpointDate)return {...result,reason:'payout' as const};
  if(approved===checkpointDate)ambiguousApproval=true;
 }
 if(ambiguousApproval)return {...result,reason:'approval-time' as const};
 const capture=options?.checkpoints?.find(row=>row.account===account&&Date.parse(row.capturedAt)===at&&row.session===checkpointDay);
 const before=trades.filter(trade=>Date.parse(trade.exit)<=at),sameBefore=before.filter(trade=>flexSession(trade.exit)===checkpointDay),sameAfter=trades.filter(trade=>Date.parse(trade.exit)>at&&flexSession(trade.exit)===checkpointDay);
 let baseline=reference?.sessionPnl??null,afterNet:number|null=0,changed=false,afterReason:FlexReason='costs';
 if(capture){
  if(baseline===null)baseline=capture.coverageIssues?null:capture.net;
  afterNet=capture.afterCoverageIssues?null:capture.afterNet;changed=afterNet!==0;
  if(capture.afterCoverageIssues)afterReason='coverage';
 }else if(ledger){
  // A daily total cannot split a session at an intraday checkpoint. Keep that
  // uncertainty visible if the server's compact checkpoint is unavailable.
  changed=!!sessions?.some(row=>row.day===checkpointDay)||sameAfter.length>0;
  afterNet=changed?null:0;afterReason='baseline';
 }else{
  if(baseline===null)baseline=sameBefore.length?tradeNet(sameBefore):before.length&&tradeNet(before)!==null?0:null;
  afterNet=tradeNet(sameAfter);changed=sameAfter.length>0;
 }
 const current=checkpointDay===day?baseline!==null&&afterNet!==null?round(baseline+afterNet):changed?null:result.today:result.today;
 let lower=checkpoint.qualifyingDays,upper=checkpoint.qualifyingDays,uncertainty:FlexReason=null;
 if(changed){
  let minimum=0,maximum=0;
  if(baseline!==null){
   const wasQualified=Number(baseline>=FLEX_DAILY_MIN);
   if(afterNet!==null)minimum=maximum=Number(round(baseline+afterNet)>=FLEX_DAILY_MIN)-wasQualified;
   else{minimum=-wasQualified;maximum=1-wasQualified;uncertainty=afterReason;}
  }else if(afterNet!==null){
   if(afterNet>0)maximum=1;
   else if(afterNet<0)minimum=-1;
   if(minimum!==maximum)uncertainty='baseline';
  }else{minimum=-1;maximum=1;uncertainty=afterReason;}
  lower=Math.max(0,Math.min(FLEX_PROFIT_DAYS,lower+minimum));upper=Math.max(0,Math.min(FLEX_PROFIT_DAYS,upper+maximum));
 }
 const later=daily.filter(row=>row.day>checkpointDay);
 for(const row of later){
  if(row.net===null){
   upper=Math.min(FLEX_PROFIT_DAYS,upper+1);
   if(uncertainty===null)uncertainty=sessions?.some(value=>value.day===row.day&&(value.unmatched||(value.coverageIssues||0)))?'coverage':'costs';
  }else if(row.net>=FLEX_DAILY_MIN){lower=Math.min(FLEX_PROFIT_DAYS,lower+1);upper=Math.min(FLEX_PROFIT_DAYS,upper+1);}
 }
 if(lower!==upper)return {...result,today:current,estimated:changed||later.length>0,reason:uncertainty||'baseline'};
 return {...result,today:current,days:lower,remaining:FLEX_PROFIT_DAYS-lower,estimated:changed||later.length>0,reason:null};
}
