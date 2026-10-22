import type {AccountProfile} from './types';
import type {FirmReference} from './firm-reference';
import type {RealizedEvent} from './realized';
import type {PerformanceStage} from './performance-scope';
import {accountStage,flexSession} from './lucid-flex';
import {calendarDayRange} from './calendar-accounts';

export const DAILY_LOSS_VERSION='realized-session-v1';
export const DAILY_LOSS_LIMIT=1200;
export const DAILY_LOSS_BATCH=4;
export const DAILY_LOSS_MAX_DAYS=366;
export const DAILY_LOSS_MAX_FILLS=50000;
export const DAILY_LOSS_BATCH_FILLS=100000;
export const DAILY_LOSS_MAX_BYTES=8*1024*1024;
export const DAILY_LOSS_BATCH_BYTES=16*1024*1024;
export const DAILY_LOSS_MAX_ROWS=DAILY_LOSS_BATCH*DAILY_LOSS_MAX_DAYS;
export const DAILY_LOSS_REQUEST_BYTES=8000;
export const DAILY_LOSS_RULES_URL='https://support.lucidtrading.com/en/articles/16226050-lucidflex-customization';
export const DAILY_LOSS_HOURS_URL='https://support.lucidtrading.com/en/articles/11404729-allowed-trading-times';
export type DailyLossRequest={accounts:string[];start:string;end:string;stage:PerformanceStage;markedUpgradedOnly:boolean};
export type DailyLossAccount={stage:string;markedUpgraded:boolean};
export type DailyLossSession=DailyLossAccount&{
 account:string;day:string;fills:number;groups:number;complete:boolean;
 missingFees:number;unmatched:number;coverageIssues:number;
 worstNet:number|null;maxGiveback:number|null;endNet:number|null;
 crossingAt:string|null;crossingNet:number|null;recoveredAboveAt:string|null;afterCrossChange:number|null;
};
export type DailyLossUnavailable={account:string;reason:'missing'|'history-limit'|'invalid-history'|'changed'};
export type DailyLossReport={version:string;asOf:string;start:string;end:string;limit:number;rows:DailyLossSession[];unavailable:DailyLossUnavailable[];excluded:string[]};
export function latestDailyLossSession(rows:readonly {day:string}[],fallback:string){
 return rows.reduce((latest,row)=>row.day>latest?row.day:latest,'')||fallback;
}

export function validateDailyLossRequest(raw:unknown):DailyLossRequest{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Choose accounts and a session date range.');
 const input=raw as Record<string,unknown>;
 if(Object.keys(input).some(key=>!['accounts','start','end','stage','markedUpgradedOnly'].includes(key)))throw new Error('Daily loss uses a fixed $1,200 scenario across all instruments.');
 if(typeof input.start!=='string'||typeof input.end!=='string')throw new Error('Choose a session date range.');
 calendarDayRange(input.start);calendarDayRange(input.end);
 const days=(Date.parse(input.end+'T12:00:00Z')-Date.parse(input.start+'T12:00:00Z'))/86400000+1;
 if(days<1||days>DAILY_LOSS_MAX_DAYS)throw new Error('Choose up to '+DAILY_LOSS_MAX_DAYS+' session dates.');
 if(!Array.isArray(input.accounts)||!input.accounts.length||input.accounts.length>DAILY_LOSS_BATCH||input.accounts.some(value=>typeof value!=='string'||!value.trim()||value.length>150||/[\u0000-\u001f]/.test(value)))throw new Error('Choose 1 to '+DAILY_LOSS_BATCH+' valid accounts per request.');
 const accounts=(input.accounts as string[]).map(value=>value.trim());
 if(new Set(accounts).size!==accounts.length)throw new Error('An account is repeated.');
 if(!['all','funded','evaluation'].includes(input.stage as string))throw new Error('Choose Both, Funded or Evaluations.');
 if(input.markedUpgradedOnly!==undefined&&typeof input.markedUpgradedOnly!=='boolean')throw new Error('Choose a valid upgraded-account filter.');
 return {accounts:accounts.sort(),start:input.start,end:input.end,stage:input.stage as PerformanceStage,markedUpgradedOnly:input.markedUpgradedOnly===true};
}

export function dailyLossAccount(account:string,profile?:AccountProfile,reference?:FirmReference):DailyLossAccount{
 const stage=accountStage(account,profile,reference);
 // A saved status is owner-reported evidence, not a profit-based pass test or
 // an evaluation-to-funded account link. Never relabel the account's stage.
 return {stage,markedUpgraded:stage==='Evaluation'&&profile?.status==='Upgraded'};
}
export function matchesDailyLossAccount(account:DailyLossAccount,request:Pick<DailyLossRequest,'stage'|'markedUpgradedOnly'>){
 return (request.stage==='all'||account.stage===(request.stage==='funded'?'Funded':'Evaluation'))&&(!request.markedUpgradedOnly||account.markedUpgraded);
}

// Call only after FIFO reconstruction of the full history. These are modeled
// realized paths from zero, not account equity, actual DLL enforcement or a
// forced-liquidation replay. Same-time fills form one group: imported ordinal
// values cannot establish the physical sequence of simultaneous executions.
export function dailyLossSessions(account:string,events:readonly RealizedEvent[],start:string,end:string,classification:DailyLossAccount):DailyLossSession[]{
 type Group={time:string;cents:number;complete:boolean};
 type Bucket={groups:Map<number,Group>;fills:number;missingFees:number;unmatched:number;coverageIssues:number};
 const days=new Map<string,Bucket>(),hours=new Map<number,string>();
 for(const event of events){
  if(event.account!==account)continue;
  const at=Date.parse(event.time),hour=Math.floor(at/3600000);
  let day=hours.get(hour);if(!day){day=flexSession(event.time);hours.set(hour,day);}
  if(day<start||day>end)continue;
  let bucket=days.get(day);if(!bucket){bucket={groups:new Map(),fills:0,missingFees:0,unmatched:0,coverageIssues:0};days.set(day,bucket);}
  const group=bucket.groups.get(at)||{time:new Date(at).toISOString(),cents:0,complete:true};
  group.complete=group.complete&&event.net!==null&&Number.isFinite(event.net)&&Number.isSafeInteger(Math.round(event.net*100))&&event.commissions!==null&&event.unmatched===0&&event.coverageIssues===0;
  if(event.net!==null&&Number.isFinite(event.net))group.cents+=Math.round(event.net*100);
  group.complete=group.complete&&Number.isSafeInteger(group.cents);
  bucket.groups.set(at,group);bucket.fills++;bucket.missingFees+=Number(event.commissions===null);bucket.unmatched+=event.unmatched;bucket.coverageIssues+=event.coverageIssues;
 }
 return [...days].sort(([a],[b])=>a.localeCompare(b)).map(([day,bucket])=>{
  const groups=[...bucket.groups].sort(([a],[b])=>a-b).map(([,group])=>group),complete=groups.every(group=>group.complete);
  const row:DailyLossSession={account,day,...classification,fills:bucket.fills,groups:groups.length,complete,missingFees:bucket.missingFees,unmatched:bucket.unmatched,coverageIssues:bucket.coverageIssues,worstNet:null,maxGiveback:null,endNet:null,crossingAt:null,crossingNet:null,recoveredAboveAt:null,afterCrossChange:null};
  // A missing event changes every later cumulative offset. Do not report a
  // complete path from just the known portion or silently drop the session.
  if(!complete)return row;
  let total=0,low=0,peak=0,giveback=0,cross:number|null=null;
  for(const group of groups){
   total+=group.cents;low=Math.min(low,total);peak=Math.max(peak,total);giveback=Math.max(giveback,peak-total);
   if(!Number.isSafeInteger(total)||!Number.isSafeInteger(giveback))return {...row,complete:false,crossingAt:null,crossingNet:null,recoveredAboveAt:null};
   if(cross===null&&total<=-DAILY_LOSS_LIMIT*100){cross=total;row.crossingAt=group.time;row.crossingNet=total/100;}
   else if(cross!==null&&total>-DAILY_LOSS_LIMIT*100&&row.recoveredAboveAt===null)row.recoveredAboveAt=group.time;
  }
  if(cross!==null&&!Number.isSafeInteger(total-cross))return {...row,complete:false,crossingAt:null,crossingNet:null,recoveredAboveAt:null};
  return {...row,worstNet:low/100,maxGiveback:giveback/100,endNet:total/100,afterCrossChange:cross===null?null:(total-cross)/100};
 });
}

export function summarizeDailyLoss(rows:readonly DailyLossSession[]){
 const complete=rows.filter(row=>row.complete),crossed=complete.filter(row=>row.crossingAt!==null);
 return {sessions:rows.length,accounts:new Set(rows.map(row=>row.account)).size,complete:complete.length,unknown:rows.length-complete.length,crossed:crossed.length,recovered:crossed.filter(row=>row.recoveredAboveAt!==null).length,endedBelow:crossed.filter(row=>row.endNet!<=-DAILY_LOSS_LIMIT).length,worstNet:complete.length?Math.min(...complete.map(row=>row.worstNet!)):null,afterCrossChange:crossed.length?crossed.reduce((sum,row)=>sum+Math.round(row.afterCrossChange!*100),0)/100:null};
}
