import type {CashRecord,Trade} from './types';
import type {FirmReference} from './firm-reference';
import type {BalanceAdjustment} from './balance-adjustments';
import type {FlexLedgerOptions} from './lucid-flex';
import {centralDay,round} from './analytics';
import {netTradePnl} from './trading-costs';
import {flexSession,flexSessionStart} from './trading-session';

export const FLEX_DAILY_MIN=150,FLEX_PROFIT_DAYS=5;
type Reason='payout'|'costs'|'coverage'|'baseline'|'approval-time'|'payout-time'|null;
type Day={day:string;net:number|null;reason:Reason};
function deductions(account:string,adjustments:readonly BalanceAdjustment[]=[],now=Date.now()){
 return adjustments.filter(row=>row.account===account&&row.settled&&!row.settlementOffsetId&&row.amount!==null&&Number.isFinite(row.amount)&&row.amount<0&&(row.kind==='payout'||row.kind==='likely-payout')&&Number.isFinite(Date.parse(row.to))&&Date.parse(row.to)<=now);
}
export function latestPayoutDeduction(account:string,adjustments:readonly BalanceAdjustment[]=[],now=Date.now()){
 return deductions(account,adjustments,now).sort((a,b)=>Date.parse(b.to)-Date.parse(a.to)||a.id.localeCompare(b.id))[0];
}
function unobservedPayout(account:string,cash:CashRecord[],at:string,now:number,options?:FlexLedgerOptions,covered:string[]=[]):Reason{
 const baseline=Date.parse(at),date=centralDay(at),today=centralDay(new Date(now).toISOString());
 const linked=new Set(deductions(account,options?.adjustments,baseline).flatMap(row=>[...(row.payoutId?[row.payoutId]:[]),...row.possiblePayoutIds]));let ambiguous=false;
 for(const row of cash){
  if(row.kind!=='payout'||row.account!==account||covered.includes(row.id))continue;
  if(row.payoutApprovalAt){const time=Date.parse(row.payoutApprovalAt);if(time>baseline&&time<=now)return 'payout';continue;}
  if(linked.has(row.id))continue;
  const approved=row.firmPayout?.approvedDate;if(!approved||approved>today)continue;
  if(approved>date)return 'payout';if(approved===date)ambiguous=true;
 }
 return ambiguous?'approval-time':null;
}
// Exactly one result per trading day: verified platform data replaces the
// modeled total. Entry commissions and partial exits remain in the model.
function sessionDays(account:string,trades:Trade[],now:number,options?:FlexLedgerOptions){
 const rows=new Map<string,Day>(),add=(day:string,net:number|null,reason:Reason)=>{const old=rows.get(day);rows.set(day,{day,net:net===null||old?.net===null?null:round((old?.net||0)+net),reason:old?.reason||reason});};
 if(options?.sessions!==undefined)for(const row of options.sessions.filter(r=>r.account===account)){const missing=!!row.unmatched||!!row.coverageIssues;add(row.day,missing?null:row.net,missing?'coverage':row.net===null?'costs':null);}
 else for(const trade of trades){const net=netTradePnl(trade);add(flexSession(trade.exit),net,net===null?'costs':null);}
 for(const row of options?.reportedSessions||[])if(row.account===account&&Date.parse(row.at)<=now)rows.set(row.day,{day:row.day,net:row.net,reason:null});
 const current=flexSession(new Date(now).toISOString());return [...rows.values()].filter(row=>row.day<=current).sort((a,b)=>a.day.localeCompare(b.day));
}
function checkpointAt(account:string,at:string,options?:FlexLedgerOptions){return [...(options?.reportedCheckpoints||[]),...(options?.checkpoints||[])].find(row=>row.account===account&&Date.parse(row.capturedAt)===Date.parse(at)&&row.session===flexSession(at));}
function countDays(rows:Day[],lower=0,upper=lower,reason:Reason=null){
 for(const row of rows){if(row.net===null){upper=Math.min(FLEX_PROFIT_DAYS,upper+1);reason=reason||row.reason;}else if(row.net>=FLEX_DAILY_MIN){lower=Math.min(FLEX_PROFIT_DAYS,lower+1);upper=Math.min(FLEX_PROFIT_DAYS,upper+1);}}
 return {confirmedDays:lower,days:lower===upper?lower:null,remaining:lower===upper?FLEX_PROFIT_DAYS-lower:null,reason:lower===upper?null:reason||'baseline'};
}
function sum(trades:Trade[]){const values=trades.map(netTradePnl);return values.some(n=>n===null)?null:round(values.reduce<number>((s,n)=>s+n!,0));}
// An optional firm count preserves earlier history; only its own session can
// move between qualifying/nonqualifying after the recorded checkpoint.
function firmBaseline(account:string,trades:Trade[],reference:FirmReference,options?:FlexLedgerOptions){
 const checkpoint=reference.flex!,at=Date.parse(checkpoint.capturedAt),day=flexSession(checkpoint.capturedAt),capture=checkpointAt(account,checkpoint.capturedAt,options);
 let before=reference.sessionPnl,after:number|null=0,changed=false,reason:Reason='costs';
 if(capture){before=before??(capture.coverageIssues?null:capture.net);after=capture.afterCoverageIssues?null:capture.afterNet;changed=after!==0;if(capture.afterCoverageIssues)reason='coverage';}
 else if(options?.sessions!==undefined){changed=options.sessions.some(r=>r.account===account&&r.day===day);after=changed?null:0;reason='baseline';}
 else {const earlier=trades.filter(t=>Date.parse(t.exit)<=at),sameBefore=earlier.filter(t=>flexSession(t.exit)===day),later=trades.filter(t=>Date.parse(t.exit)>at&&flexSession(t.exit)===day);before=before??(sameBefore.length?sum(sameBefore):earlier.length&&sum(earlier)!==null?0:null);after=sum(later);changed=later.length>0;}
 let minimum=0,maximum=0;
 if(changed){
  if(before!==null){const was=Number(before>=FLEX_DAILY_MIN);if(after!==null)minimum=maximum=Number(round(before+after)>=FLEX_DAILY_MIN)-was;else {minimum=-was;maximum=1-was;}}
  else if(after!==null){if(after>0)maximum=1;if(after<0)minimum=-1;reason='baseline';}
  else {minimum=-1;maximum=1;}
 }
 return {day,changed,current:before!==null&&after!==null?round(before+after):null,lower:Math.max(0,Math.min(FLEX_PROFIT_DAYS,checkpoint.qualifyingDays!+minimum)),upper:Math.max(0,Math.min(FLEX_PROFIT_DAYS,checkpoint.qualifyingDays!+maximum)),reason};
}

function cycleRows(account:string,reset:BalanceAdjustment|undefined,rows:Day[],options?:FlexLedgerOptions):Day[]{
 if(!reset)return rows;
 const capture=checkpointAt(account,reset.to,options),day=flexSession(reset.to);
 const tail:Day={day,net:capture?(capture.afterCoverageIssues?null:capture.afterNet):rows.some(r=>r.day===day)?null:0,reason:capture?.afterCoverageIssues?'coverage':capture?'costs':'baseline'};
 return [tail,...rows.filter(r=>r.day>day)];
}
export function flexPayoutDays(account:string,trades:Trade[],reference:FirmReference|undefined,cash:CashRecord[],now=Date.now(),options?:FlexLedgerOptions){
 trades=trades.filter(t=>t.account===account&&Date.parse(t.exit)<=now);
 const currentDate=centralDay(new Date(now).toISOString());
 cash=cash.filter(row=>row.kind!=='payout'||(row.payoutApprovalAt?Date.parse(row.payoutApprovalAt)<=now:(row.firmPayout?.approvedDate??row.date)<=currentDate));
 const rows=sessionDays(account,trades,now,options),todayDay=flexSession(new Date(now).toISOString()),today=rows.find(r=>r.day===todayDay)?.net??null;
 const reset=latestPayoutDeduction(account,options?.adjustments,now),firm=reference?.flex,candidate=firm?.stage==='Funded'&&firm.qualifyingDays!==null?Date.parse(firm.capturedAt):NaN,firmAt=Number.isFinite(candidate)&&candidate<=now?candidate:null;
 const cycle=cycleRows(account,reset,rows,options),profitBaselineKnown=reset?unobservedPayout(account,cash,reset.to,now,options)===null:!cash.some(row=>row.account===account&&row.kind==='payout');
 const uncertainReset=!!reset&&(reset.tradingActivity??(reset.tradingNet!==null&&reset.tradingNet!==0));
 const cycleProfit=!profitBaselineKnown||uncertainReset||cycle.some(row=>row.net===null)?null:round(cycle.reduce((sum,row)=>sum+row.net!,0));
 const result={cycleProfit,confirmedDays:0,days:null as number|null,remaining:null as number|null,estimated:true,today,checkpointDate:reference?.date||null,payoutResetAt:null as string|null,source:'funded-start' as 'funded-start'|'payout'|'firm-checkpoint',reason:null as Reason};
 if(reset&&(firmAt===null||Date.parse(reset.to)>firmAt)){
  const reason=unobservedPayout(account,cash,reset.to,now,options);
  const counted=countDays(cycle);
  return {...result,source:'payout' as const,payoutResetAt:reset.to,today:cycle[0].day===todayDay?cycle[0].net:today,...(reason?{reason,cycleProfit:null}:uncertainReset&&counted.confirmedDays<FLEX_PROFIT_DAYS?{...counted,days:null,remaining:null,reason:'payout-time' as const}:counted)};
 }
 if(firmAt!==null&&reference){
  const reason=unobservedPayout(account,cash,firm!.capturedAt,now,options,firm!.coveredPayoutIds),base=firmBaseline(account,trades,reference,options),later=rows.filter(r=>r.day>base.day);
  return {...result,source:'firm-checkpoint' as const,estimated:base.changed||later.length>0,today:base.day===todayDay&&base.changed?base.current:today,...(reason?{reason,cycleProfit:null}:countDays(later,base.lower,base.upper,base.reason))};
 }
 // A fresh funded account starts at zero. A manual day-count record is never
 // required. Historical evidence of an unobserved later payout stays explicit.
 const first=rows[0]?.day,start=first?new Date(Date.parse(flexSessionStart(first))-1).toISOString():new Date(0).toISOString();
 const reason=unobservedPayout(account,cash,start,now,options)||(!first&&cash.some(row=>row.account===account&&row.kind==='payout')?'payout':null);
 return {...result,...(reason?{reason,cycleProfit:null}:countDays(rows))};
}
