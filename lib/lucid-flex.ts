import type {AccountProfile,CashRecord,Trade} from './types';
import type {FirmReference} from './firm-reference';
import type {RealizedCheckpoint,RealizedDay} from './realized';
import type {ReportedSession} from './account-sessions';
import type {BalanceAdjustment} from './balance-adjustments';
import {round} from './analytics';
import {netTradePnl} from './trading-costs';

export const FLEX_RULES_CHECKED='2026-10-19';
export const FLEX_PAYOUT_URL='https://support.lucidtrading.com/en/articles/12945796-lucidflex-payouts';
export const FLEX_EVAL_URL='https://support.lucidtrading.com/en/articles/12945790-lucidflex-evaluation-account';
export const FLEX_CONSISTENCY_URL='https://support.lucidtrading.com/en/articles/12945805-lucidflex-consistency-percentage';
export const FLEX_BASE_TARGET=3000;
export {FLEX_DAILY_MIN,FLEX_PROFIT_DAYS,flexPayoutDays,latestPayoutDeduction} from './funded-cycle';
export {flexSession} from './trading-session';
import {flexSession} from './trading-session';
export type FlexLedgerOptions={sessions?:RealizedDay[];checkpoints?:RealizedCheckpoint[];adjustments?:BalanceAdjustment[];reportedSessions?:ReportedSession[];reportedCheckpoints?:RealizedCheckpoint[]};
// These exact 50K naming families are confirmed by the owner's Lucid screenshots.
// Explicit classifications override the prefix; other products remain unclassified.
export function flexAccount(account:string){const m=/^LF([EF])050\d+$/i.exec(account);return m?{stage:m[1].toUpperCase()==='E'?'Evaluation' as const:'Funded' as const}:null;}
export function accountStage(account:string,profile?:AccountProfile,reference?:FirmReference){return profile?.stage&&profile.stage!=='Unclassified'?profile.stage:reference?.flex?.stage||flexAccount(account)?.stage||'Unclassified';}
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
