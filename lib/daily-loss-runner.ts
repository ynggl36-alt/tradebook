import {DAILY_LOSS_BATCH,DAILY_LOSS_MAX_ROWS,DAILY_LOSS_VERSION,DAILY_LOSS_LIMIT} from './daily-loss';
import type {DailyLossRequest,DailyLossReport,DailyLossSession,DailyLossUnavailable} from './daily-loss';

export const DAILY_LOSS_CLIENT_ACCOUNTS=500,DAILY_LOSS_CLIENT_ROWS=20000;
export type DailyLossRun={rows:DailyLossSession[];unavailable:DailyLossUnavailable[];excluded:string[];checkedAccounts:number;requestedAccounts:number;limited:boolean;asOf:string|null};
export type DailyLossTransport=(request:DailyLossRequest,signal:AbortSignal)=>Promise<DailyLossReport>;
export async function runDailyLoss(request:DailyLossRequest,transport:DailyLossTransport,signal:AbortSignal,progress?:(checked:number,total:number)=>void):Promise<DailyLossRun>{
 const unique=[...new Set(request.accounts)].sort(),accounts=unique.slice(0,DAILY_LOSS_CLIENT_ACCOUNTS);
 const result:DailyLossRun={rows:[],unavailable:[],excluded:[],checkedAccounts:0,requestedAccounts:unique.length,limited:unique.length>accounts.length,asOf:null};
 for(let offset=0;offset<accounts.length;offset+=DAILY_LOSS_BATCH){
  signal.throwIfAborted();
  const chunk=accounts.slice(offset,offset+DAILY_LOSS_BATCH),report=await transport({...request,accounts:chunk},signal);
  // Some transports finish after cancellation. Never accept a replaced task's
  // result, start its next batch or mix responses from a different scope.
  signal.throwIfAborted();
  if(report.version!==DAILY_LOSS_VERSION||report.limit!==DAILY_LOSS_LIMIT||report.start!==request.start||report.end!==request.end||!Number.isFinite(Date.parse(report.asOf))||!Array.isArray(report.rows)||report.rows.length>DAILY_LOSS_MAX_ROWS||!Array.isArray(report.unavailable)||!Array.isArray(report.excluded)||report.rows.some(row=>!chunk.includes(row.account)||row.day<request.start||row.day>request.end)||new Set(report.rows.map(row=>JSON.stringify([row.account,row.day]))).size!==report.rows.length)throw new Error('Unexpected daily loss response. Refresh saved data and retry.');
  if(result.rows.length+report.rows.length>DAILY_LOSS_CLIENT_ROWS){result.limited=true;break;}
  result.rows.push(...report.rows);result.unavailable.push(...report.unavailable);result.excluded.push(...report.excluded);result.checkedAccounts+=chunk.length;result.asOf=report.asOf;
  progress?.(result.checkedAccounts,accounts.length);
 }
 result.rows.sort((a,b)=>b.day.localeCompare(a.day)||a.account.localeCompare(b.account));
 return result;
}
