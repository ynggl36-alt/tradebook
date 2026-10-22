import {env} from 'cloudflare:workers';
import type {AccountHistory,AccountProfile} from './types';
import type {FirmReference} from './firm-reference';
import type {RealizedEvent} from './realized';
import {realizedEvents} from './realized';
import {cachedRealizedEvents} from './server-journal';
import {DAILY_LOSS_VERSION,DAILY_LOSS_LIMIT,DAILY_LOSS_MAX_FILLS,DAILY_LOSS_BATCH_FILLS,DAILY_LOSS_MAX_BYTES,DAILY_LOSS_BATCH_BYTES,DAILY_LOSS_MAX_ROWS,validateDailyLossRequest,dailyLossAccount,matchesDailyLossAccount,dailyLossSessions} from './daily-loss';
import type {DailyLossAccount,DailyLossReport} from './daily-loss';

type Metadata={account:string;revision:number;bytes:number;fills:number|null;profile:string|null;reference:string|null};
export async function loadDailyLoss(input:unknown,asOf=Date.now()):Promise<DailyLossReport>{
 const request=validateDailyLossRequest(input);
 if(!env.DB)throw new Error('Daily loss history is unavailable.');
 const report:DailyLossReport={version:DAILY_LOSS_VERSION,asOf:new Date(asOf).toISOString(),start:request.start,end:request.end,limit:DAILY_LOSS_LIMIT,rows:[],unavailable:[],excluded:[]};
 // At most four account blobs, two SELECTs and eight bound account/revision
 // parameters. Check byte size before asking SQLite to parse large JSON.
 const metadata=await env.DB.prepare(`SELECT h.account,h.revision,length(CAST(h.data AS BLOB)) AS bytes,
  CASE WHEN length(CAST(h.data AS BLOB))<=? THEN json_array_length(h.data,'$.fills') ELSE NULL END AS fills,
  p.data AS profile,r.data AS reference FROM account_history h
  LEFT JOIN account_profiles p ON p.account=h.account LEFT JOIN firm_references r ON r.account=h.account
  WHERE h.account IN (${request.accounts.map(()=>'?').join(',')}) ORDER BY h.account`)
  .bind(DAILY_LOSS_MAX_BYTES,...request.accounts).all<Metadata>();
 const found=new Set(metadata.results.map(row=>row.account));
 for(const account of request.accounts)if(!found.has(account))report.unavailable.push({account,reason:'missing'});
 const pending:{metadata:Metadata;classification:DailyLossAccount;events:readonly RealizedEvent[]|null}[]=[];
 let fills=0,bytes=0;
 for(const row of metadata.results){
  let classification:DailyLossAccount;
  try{classification=dailyLossAccount(row.account,row.profile?JSON.parse(row.profile)as AccountProfile:undefined,row.reference?JSON.parse(row.reference)as FirmReference:undefined);}
  catch{report.unavailable.push({account:row.account,reason:'invalid-history'});continue;}
  if(!matchesDailyLossAccount(classification,request)){report.excluded.push(row.account);continue;}
  if(row.bytes>DAILY_LOSS_MAX_BYTES||row.fills!==null&&row.fills>DAILY_LOSS_MAX_FILLS){report.unavailable.push({account:row.account,reason:'history-limit'});continue;}
  if(row.fills===null||!Number.isSafeInteger(row.fills)||row.fills<0){report.unavailable.push({account:row.account,reason:'invalid-history'});continue;}
  if(fills+row.fills>DAILY_LOSS_BATCH_FILLS||bytes+row.bytes>DAILY_LOSS_BATCH_BYTES){report.unavailable.push({account:row.account,reason:'history-limit'});continue;}
  fills+=row.fills;bytes+=row.bytes;
  pending.push({metadata:row,classification,events:cachedRealizedEvents(row.account,row.revision,asOf)});
 }
 const needed=pending.filter(row=>row.events===null),histories=new Map<string,{data:string;revision:number}>();
 if(needed.length){
  const result=await env.DB.prepare(`SELECT account,data,revision FROM account_history WHERE ${needed.map(()=>'(account=? AND revision=?)').join(' OR ')}`)
   .bind(...needed.flatMap(row=>[row.metadata.account,row.metadata.revision])).all<{account:string;data:string;revision:number}>();
  for(const row of result.results)histories.set(row.account,row);
 }
 for(const row of pending){
  const {account}=row.metadata;
  try{
   let events=row.events;
   if(events===null){
    const saved=histories.get(account);
    if(!saved){report.unavailable.push({account,reason:'changed'});continue;}
    const history=JSON.parse(saved.data)as AccountHistory;
    if(history.account!==account||!Array.isArray(history.fills)||history.fills.length!==row.metadata.fills||history.fills.some(fill=>!fill||typeof fill.id!=='string'||!fill.id||typeof fill.contract!=='string'||!fill.contract||typeof fill.symbol!=='string'||!fill.symbol||!Number.isFinite(Date.parse(fill.time))||!['Buy','Sell'].includes(fill.side)||!Number.isSafeInteger(fill.qty)||fill.qty<=0||!Number.isFinite(fill.price)||!Number.isFinite(fill.pv)||fill.pv<=0||!Number.isSafeInteger(fill.ordinal)||fill.pos!==null&&!Number.isSafeInteger(fill.pos)))throw new Error('Invalid account history.');
    // Earlier fills establish FIFO inventory even if their session is outside
    // the requested dates. Future executions never enter a retrospective path.
    events=realizedEvents(account,history.fills.filter(fill=>Date.parse(fill.time)<=asOf));
   }
   report.rows.push(...dailyLossSessions(account,events,request.start,request.end,row.classification));
  }catch{report.unavailable.push({account,reason:'invalid-history'});}
 }
 if(report.rows.length>DAILY_LOSS_MAX_ROWS)throw new Error('Daily loss response limit exceeded. Choose a shorter range.');
 return report;
}
