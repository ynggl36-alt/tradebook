import { env } from 'cloudflare:workers';
import type { AccountHistory, AccountProfile, CashRecord, Fill, Journal, TradeNote } from './types';
import { mergeFills, reconstruct } from './reconstruct';
import { normalizeContract } from './csv';
import {validateAccountState} from './account-state';
import {validateFirmReference} from './firm-reference';
import type {FirmReference} from './firm-reference';
import {planFirmPayoutImport,payoutSummary,validateFirmPayout} from './payouts';
import type {AccountMonitor,AccountState,AccountStateData} from './account-state';
import {aggregateRealized,realizedEvents,realizedCheckpoint} from './realized';
import {latestPayoutDeduction} from './lucid-flex';
import {reportedAccountSessions,reportedCheckpoint} from './account-sessions';
import {evaluationFailures,observedEvaluationEquity} from './evaluation-failures';
import type {EvaluationObservation} from './evaluation-failures';
import type {RealizedDay,RealizedEvent} from './realized';
import firmNotices from '../data/firm-adjustments.json';
import {canonicalJson,observation,deriveBalanceAdjustments} from './balance-adjustments';
import type {FirmAdjustmentNotice} from './balance-adjustments';
export const KNOWN_FIRM_ADJUSTMENTS=firmNotices as FirmAdjustmentNotice[];
import type {BalanceObservation,BalanceInterval,AdjustmentLabel,BalanceTracking} from './balance-adjustments';

const realizedCache=new Map<string,{revision:number;rows:RealizedDay[];sessions:RealizedDay[];events:RealizedEvent[];nextFutureAt?:number;fills?:Fill[]}>();
// Read-only access for bounded diagnostics. A caller must verify history size
// and revision first; a due future execution invalidates this cached ledger.
// This never warms the cache or updates journal metadata.
export function cachedRealizedEvents(account:string,revision:number,asOf:number):readonly RealizedEvent[]|null{
 const cached=realizedCache.get(account);
 if(!cached||cached.revision!==revision||(cached.nextFutureAt!==undefined&&cached.nextFutureAt<=asOf))return null;
 return cached.events.filter(event=>Date.parse(event.time)<=asOf);
}
export async function bumpJournalRevision(){await db().prepare("INSERT INTO journal_meta(key,value) VALUES ('change_revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)").run();}
export async function loadJournalVersion(asOf=Date.now()){
 const [changes,last]=await Promise.all([db().prepare("SELECT key,value FROM journal_meta WHERE key IN ('change_revision','last_balance_change','next_future_fill')").all<{key:string;value:string}>(),db().prepare('SELECT MAX(updated) AS updated FROM account_history').first<{updated:string}>()]);
 const change=changes.results.find(row=>row.key==='change_revision')?.value||'0',balance=changes.results.find(row=>row.key==='last_balance_change')?.value;
 // A deduction settles after uploads catch up. Advance only these first few
 // minutes; unchanged balance heartbeats do not reload the whole journal.
 const settling=balance?Math.max(0,Math.min(3,Math.floor((asOf-Date.parse(balance))/60000))):3;
 const future=changes.results.find(row=>row.key==='next_future_fill')?.value,arrival=future?(asOf>=Date.parse(future)?'ready':'pending'):'';
 return {revision:change+'|'+(last?.updated||'')+'|'+settling+'|'+arrival};
}

export function db(){ if(!env.DB)throw new Error('Online storage is unavailable. Please try again shortly.');return env.DB; }
async function indexExecutionTimes(fills:{account:string;time:string}[]){
 const normalized=fills.map(fill=>({...fill,time:new Date(fill.time).toISOString()}));
 const unique=[...new Map(normalized.map(fill=>[fill.account+'|'+fill.time,fill])).values()];
 for(let offset=0;offset<unique.length;offset+=40){const chunk=unique.slice(offset,offset+40);await db().prepare(`INSERT INTO execution_times(account,time) VALUES ${chunk.map(()=>'(?,?)').join(',')} ON CONFLICT(account,time) DO NOTHING`).bind(...chunk.flatMap(fill=>[fill.account,fill.time])).run();}
}
export async function loadAccountState():Promise<AccountStateData>{
  const [monitor,rows]=await Promise.all([
    db().prepare("SELECT data FROM recorder_status WHERE id='latest'").first<{data:string}>(),
    db().prepare('SELECT data FROM account_status ORDER BY account').all<{data:string}>(),
  ]);
  return {monitor:monitor?JSON.parse(monitor.data)as AccountMonitor:null,accounts:rows.results.map(r=>JSON.parse(r.data)as AccountState)};
}
export async function saveAccountState(input:unknown){
  const capture=validateAccountState(input);
  const prior=await loadAccountState(),priorAccounts=new Map(prior.accounts.map(account=>[account.account,account]));
  const existing=await db().prepare('SELECT account,MIN(CASE WHEN cash_value IS NOT NULL THEN captured_at END) AS first FROM account_observations GROUP BY account').all<{account:string;first:string|null}>(),archived=new Set(existing.results.map(row=>row.account)),earliest=new Map(existing.results.filter(row=>row.first!==null).map(row=>[row.account,row.first!]));
  const receivedAt=new Date().toISOString(),raw=capture.accounts.map(account=>observation(account,capture.recorderVersion,capture.running));
  const baselines=capture.accounts.flatMap(account=>{const old=priorAccounts.get(account.account);return old&&!archived.has(account.account)?[observation(old,'legacy-last-known',false,'legacy')]:[];});
  // Only the newly observed portion needs a time index. Existing raw execution
  // history remains untouched; later imports index their own timestamps.
  const firstAccounts=capture.accounts.filter(account=>!earliest.has(account.account)||Date.parse(account.values.CashValue?.at??capture.capturedAt)<Date.parse(earliest.get(account.account)!));
  for(let offset=0;offset<firstAccounts.length;offset+=30){const chunk=firstAccounts.slice(offset,offset+30),histories=await db().prepare(`SELECT account,data FROM account_history WHERE account IN (${chunk.map(()=>'?').join(',')})`).bind(...chunk.map(account=>account.account)).all<{account:string;data:string}>();
   await indexExecutionTimes(histories.results.flatMap(row=>{const incoming=chunk.find(account=>account.account===row.account)!,first=Math.min(...[priorAccounts.get(row.account)?.values.CashValue?.at,incoming.values.CashValue?.at??capture.capturedAt].filter((value):value is string=>!!value).map(value=>Date.parse(value))),end=earliest.get(row.account),history=JSON.parse(row.data)as AccountHistory;return history.fills.filter(fill=>Date.parse(fill.time)>=first&&(!end||Date.parse(fill.time)<=Date.parse(end))).map(fill=>({account:row.account,time:fill.time}));}));
  }
  const seen=new Set(capture.accounts.map(account=>account.account));
  if(prior.monitor&&capture.capturedAt>prior.monitor.capturedAt){for(const name of prior.monitor.accountsSeen){if(seen.has(name))continue;const old=priorAccounts.get(name);if(old)raw.push(observation({...old,capturedAt:capture.capturedAt,connected:false,values:{},positions:[],positionsAvailable:false,positionsAt:null},capture.recorderVersion,capture.running,'not-seen'));}}
  const header=canonicalJson({schemaVersion:capture.schemaVersion,mode:capture.mode,recorderVersion:capture.recorderVersion,capturedAt:capture.capturedAt,running:capture.running,scopePrefixes:capture.scopePrefixes,accountsSeen:[...seen].sort()});
  const monitor:AccountMonitor={capturedAt:capture.capturedAt,running:capture.running,recorderVersion:capture.recorderVersion,scopePrefixes:capture.scopePrefixes,accountsSeen:capture.accounts.map(a=>a.account)};
  const statements=[db().prepare("INSERT INTO recorder_status(id,captured_at,data) VALUES ('latest',?,?) ON CONFLICT(id) DO UPDATE SET captured_at=excluded.captured_at,data=excluded.data WHERE excluded.captured_at>recorder_status.captured_at").bind(capture.capturedAt,JSON.stringify(monitor))];
  // A conflicting replay aborts the atomic batch through the NOT NULL guard;
  // identical replays never overwrite immutable source observations.
  statements.push(db().prepare('INSERT INTO recorder_captures(captured_at,data,received_at) VALUES (?,?,?) ON CONFLICT(captured_at) DO UPDATE SET data=NULL WHERE recorder_captures.data<>excluded.data').bind(capture.capturedAt,header,receivedAt));
  const observations=[...baselines,...raw];
  for(let offset=0;offset<observations.length;offset+=12){const chunk=observations.slice(offset,offset+12);statements.push(db().prepare(`INSERT INTO account_observations(id,account,captured_at,origin,cash_value,data,received_at) VALUES ${chunk.map(()=>'(?,?,?,?,?,?,?)').join(',')} ON CONFLICT(id) DO UPDATE SET data=NULL WHERE account_observations.data<>excluded.data`).bind(...chunk.flatMap(row=>[row.id,row.account,row.capturedAt,row.origin,row.state.values.CashValue?.value??null,canonicalJson(row),receivedAt])));}
  // Retain the last reported values and positions through disconnects. Their own
  // timestamps remain unchanged; current availability is checked against the heartbeat.
  // Batch 30 rows to stay under D1's bound-parameter and per-request query limits.
  for(let offset=0;offset<capture.accounts.length;offset+=30){
    const rows=capture.accounts.slice(offset,offset+30);
    const sql=`INSERT INTO account_status(account,captured_at,data) VALUES ${rows.map(()=>'(?,?,?)').join(',')}
      ON CONFLICT(account) DO UPDATE SET captured_at=excluded.captured_at,
      data=json_set(excluded.data,
        '$.currency',CASE WHEN json_extract(excluded.data,'$.currency')='Unknown' THEN json_extract(account_status.data,'$.currency') ELSE json_extract(excluded.data,'$.currency') END,
        '$.values',CASE WHEN json_extract(excluded.data,'$.currency')=json_extract(account_status.data,'$.currency') OR json_extract(excluded.data,'$.currency')='Unknown' THEN json_patch(json_extract(account_status.data,'$.values'),json_extract(excluded.data,'$.values')) ELSE json_extract(excluded.data,'$.values') END,
        '$.positions',CASE WHEN json_extract(excluded.data,'$.positionsAvailable') THEN json_extract(excluded.data,'$.positions') ELSE json_extract(account_status.data,'$.positions') END,
        '$.positionsAt',CASE WHEN json_extract(excluded.data,'$.positionsAvailable') THEN json_extract(excluded.data,'$.positionsAt') ELSE json_extract(account_status.data,'$.positionsAt') END)
      WHERE excluded.captured_at>account_status.captured_at`;
    statements.push(db().prepare(sql).bind(...rows.flatMap(a=>[a.account,capture.capturedAt,JSON.stringify(a)])));
  }
  let results;try{results=await db().batch(statements);}catch(e){if(String(e).includes('NOT NULL'))throw new Error('Conflicting account snapshot at the same time. Saved observations were not replaced.');throw e;}
  const pnlChanged=capture.accounts.some(account=>{const old=priorAccounts.get(account.account);return account.values.RealizedProfitLoss&&account.values.RealizedProfitLoss.value!==old?.values.RealizedProfitLoss?.value;});
  const equity=(state:AccountState|undefined)=>state?observedEvaluationEquity({account:state.account,capturedAt:state.capturedAt,connected:Number(state.connected),currency:state.currency,connection:state.connection,provider:state.provider,cash:state.values.CashValue?.value??null,cashAt:state.values.CashValue?.at??null,net:null,netAt:null,equity:state.values.NetLiquidation?.value,equityAt:state.values.NetLiquidation?.at,floating:state.values.UnrealizedProfitLoss?.value,floatingAt:state.values.UnrealizedProfitLoss?.at,positionsAvailable:Number(state.positionsAvailable),positionsAt:state.positionsAt,positionData:JSON.stringify(state.positions)})?.value:null;
  // Cash may stay unchanged during an equity breach. Refresh the journal when
  // an evaluation's observed equity changes within the possible loss-floor band.
  const riskChanged=capture.accounts.some(account=>{if(!/^LFE050\d+$/i.test(account.account))return false;const value=equity(account);return value!==null&&value!==undefined&&value<=50100&&value!==equity(priorAccounts.get(account.account));});
  const balanceChanged=capture.accounts.some(account=>{const old=priorAccounts.get(account.account);return account.values.CashValue&&account.values.CashValue.value!==old?.values.CashValue?.value;}),availabilityChanged=capture.accounts.some(account=>priorAccounts.get(account.account)?.connected!==account.connected)||raw.some(row=>row.origin==='not-seen');
  const late=!!prior.monitor&&capture.capturedAt<prior.monitor.capturedAt&&results[1].meta.changes>0;
  const newlyArchived=results[1].meta.changes>0;
  if(newlyArchived&&(balanceChanged||pnlChanged||riskChanged||availabilityChanged||late)){await bumpJournalRevision();if(balanceChanged||pnlChanged||late)await db().prepare("INSERT INTO journal_meta(key,value) VALUES ('last_balance_change',?) ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)").bind(receivedAt).run();}
  const latest=await db().prepare("SELECT captured_at AS capturedAt FROM recorder_status WHERE id='latest'").first<{capturedAt:string}>();
  return {accepted:results[0].meta.changes===1,capturedAt:latest?.capturedAt||capture.capturedAt};
}
async function loadBalanceData(cash:CashRecord[],profiles:AccountProfile[],firmReferences:FirmReference[],asOf:number){
 const [pairs,labels,tracking,nativeRows]=await Promise.all([
  db().prepare(`WITH retained AS (
   SELECT id,account,captured_at,cash_value,json_extract(data,'$.state.values.CashValue.at') AS cash_at,COALESCE(json_extract(data,'$.state.values.RealizedProfitLoss.value'),0) AS realized
   FROM account_observations o WHERE origin<>'legacy' OR NOT EXISTS (SELECT 1 FROM account_observations r WHERE r.account=o.account AND r.captured_at=o.captured_at AND r.origin<>'legacy')
  ), adjacent AS (
   SELECT *,LAG(id) OVER (PARTITION BY account ORDER BY captured_at,id) AS previous_id,LAG(captured_at) OVER (PARTITION BY account ORDER BY captured_at,id) AS previous_capture,LAG(cash_at) OVER (PARTITION BY account ORDER BY captured_at,id) AS previous_cash_at,LAG(realized) OVER (PARTITION BY account ORDER BY captured_at,id) AS previous_realized,LAG(cash_value) OVER (PARTITION BY account ORDER BY captured_at,id) AS previous_cash
   FROM retained
  ) SELECT current.data,previous.data AS previous,current.received_at,previous.received_at AS previous_received,EXISTS(SELECT 1 FROM recorder_captures c WHERE c.captured_at>adjacent.previous_capture AND c.captured_at<adjacent.captured_at AND NOT EXISTS (SELECT 1 FROM json_each(c.data,'$.accountsSeen') seen WHERE seen.value=adjacent.account)) AS gap
   FROM adjacent JOIN account_observations current ON current.id=adjacent.id JOIN account_observations previous ON previous.id=adjacent.previous_id
   WHERE adjacent.previous_id IS NOT NULL AND adjacent.cash_value IS NOT NULL AND adjacent.previous_cash IS NOT NULL AND (ABS(adjacent.cash_value-adjacent.previous_cash)>=.001 OR EXISTS(SELECT 1 FROM execution_times e WHERE e.account=adjacent.account AND e.time>adjacent.previous_cash_at AND e.time<=adjacent.cash_at) OR adjacent.realized<>adjacent.previous_realized)`).all<{data:string;previous:string;gap:number;received_at:string;previous_received:string}>(),
  db().prepare('SELECT data FROM balance_adjustment_labels').all<{data:string}>(),
  db().prepare('SELECT COUNT(*) AS observations,MIN(captured_at) AS first,MAX(captured_at) AS last FROM account_observations').first<BalanceTracking>(),
  db().prepare(`SELECT account,captured_at AS capturedAt,json_extract(data,'$.state.values.RealizedProfitLoss.value') AS net,json_extract(data,'$.state.values.RealizedProfitLoss.at') AS netAt,cash_value AS cash,json_extract(data,'$.state.values.CashValue.at') AS cashAt,json_extract(data,'$.state.values.NetLiquidation.value') AS equity,json_extract(data,'$.state.values.NetLiquidation.at') AS equityAt,json_extract(data,'$.state.values.UnrealizedProfitLoss.value') AS floating,json_extract(data,'$.state.values.UnrealizedProfitLoss.at') AS floatingAt,json_extract(data,'$.state.connected') AS connected,json_extract(data,'$.state.currency') AS currency,json_extract(data,'$.state.connection') AS connection,json_extract(data,'$.state.provider') AS provider,json_extract(data,'$.state.positionsAvailable') AS positionsAvailable,json_extract(data,'$.state.positionsAt') AS positionsAt,json_extract(data,'$.state.positions') AS positionData FROM account_observations o WHERE captured_at<=? AND (origin<>'legacy' OR NOT EXISTS (SELECT 1 FROM account_observations r WHERE r.account=o.account AND r.captured_at=o.captured_at AND r.origin<>'legacy')) ORDER BY account,captured_at`).bind(new Date(asOf).toISOString()).all<EvaluationObservation>(),
 ]);
 const intervals:BalanceInterval[]=pairs.results.map(row=>({before:{...JSON.parse(row.previous),receivedAt:row.previous_received},after:{...JSON.parse(row.data),receivedAt:row.received_at},gap:!!row.gap}));
 const events=new Map([...realizedCache].map(([account,cache])=>[account,cache.events])),reported=reportedAccountSessions(nativeRows.results,events,asOf,new Map([...realizedCache].flatMap(([account,cache])=>cache.fills?[[account,cache.fills] as const]:[])));
 return {reported,evaluationFailures:evaluationFailures({rows:nativeRows.results,events:reported.reconciledEvents,profiles,references:firmReferences,notices:KNOWN_FIRM_ADJUSTMENTS,asOf}),adjustments:deriveBalanceAdjustments(intervals,reported.reconciledEvents,cash,labels.results.map(row=>JSON.parse(row.data)as AdjustmentLabel),Date.now(),KNOWN_FIRM_ADJUSTMENTS,{profiles,firmReferences,nativeReadings:reported.readings}),balanceTracking:tracking??{observations:0,first:null,last:null},firmAdjustments:KNOWN_FIRM_ADJUSTMENTS};
}
export async function saveAdjustmentLabel(input:Record<string,unknown>){
 const id=text(input.id,500),kind=text(input.kind,30);if(!['automatic','payout','firm-adjustment','unexplained','ignore'].includes(kind))throw new Error('Choose a payout, firm adjustment, unexplained change or ignored change.');
 const journal=await loadJournal();if(!journal.adjustments?.some(row=>row.id===id))throw new Error('This balance change was superseded or is no longer present. Refresh the journal.');
 if(kind==='automatic'){await db().prepare('DELETE FROM balance_adjustment_labels WHERE id=?').bind(id).run();await bumpJournalRevision();return {removed:true};}
 const label:AdjustmentLabel={id,kind:kind as AdjustmentLabel['kind'],note:text(input.note??'',1000),updatedAt:new Date().toISOString()};
 await db().prepare('INSERT INTO balance_adjustment_labels(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').bind(id,JSON.stringify(label)).run();await bumpJournalRevision();return label;
}
async function knownAccount(account:string){
  return !!(await db().prepare('SELECT account FROM account_history WHERE account=? UNION SELECT account FROM account_status WHERE account=? LIMIT 1').bind(account,account).first());
}
export async function loadFirmReferences():Promise<FirmReference[]>{const rows=await db().prepare('SELECT data FROM firm_references ORDER BY account').all<{data:string}>();return rows.results.map(row=>JSON.parse(row.data));}
export async function saveFirmReference(input:Record<string,unknown>){
 const ref=validateFirmReference(input);if(!await knownAccount(ref.account))throw new Error('Choose an account already present in your journal.');
 await db().prepare('INSERT INTO firm_references(account,data) VALUES (?,?) ON CONFLICT(account) DO UPDATE SET data=excluded.data').bind(ref.account,JSON.stringify(ref)).run();await bumpJournalRevision();return ref;
}
export async function initialSeed(){return (await import('../data/initial-history.json')).default as {version:string;source:string;accounts:{account:string;data:string;trades:string;summary:string}[];expected:{fills:number;closed_account_trades:number;gross_pnl:number}};}
export async function isReady(){return !!(await db().prepare("SELECT value FROM journal_meta WHERE key='seed_version'").first());}
export async function bootstrap(offset:number){
  const seed=await initialSeed();
  if(await isReady())return {ready:true,next:seed.accounts.length,total:seed.accounts.length};
  if(!Number.isInteger(offset)||offset<0||offset>seed.accounts.length)throw new Error('Invalid history offset.');
  const portion=seed.accounts.slice(offset,offset+30),now=new Date().toISOString();
  if(portion.length)await db().batch(portion.map(h=>db().prepare('INSERT INTO account_history(account,data,trades_data,summary_data,revision,updated) VALUES (?,?,?,?,1,?) ON CONFLICT(account) DO NOTHING').bind(h.account,h.data,h.trades,h.summary,now)));
  const next=offset+portion.length;
  if(next>=seed.accounts.length){
    const count=await db().prepare('SELECT COUNT(*) AS n FROM account_history').first<{n:number}>();
    if(!count||count.n<seed.accounts.length)throw new Error('History transfer is incomplete. Reload to resume safely.');
    await db().batch([
      db().prepare("INSERT INTO journal_meta(key,value) VALUES ('seed_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(seed.version),
      db().prepare('INSERT INTO journal_imports(id,source,added,duplicates,imported_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING').bind('initial-'+seed.version,seed.source,seed.expected.fills,0,now),
    ]);
  }
  return {ready:next>=seed.accounts.length,next,total:seed.accounts.length};
}
export async function histories(){const result=await db().prepare('SELECT data FROM account_history ORDER BY account').all<{data:string}>();return result.results.map(r=>JSON.parse(r.data) as AccountHistory);}
export async function loadJournal():Promise<Journal>{
  if(!await isReady())return {ready:false,trades:[],accounts:[],profiles:[],notes:[],cash:[],imports:[],lastSaved:'',seedVersion:''};
  const asOf=Date.now();
  // Tag with the version observed before these reads. A concurrent mutation
  // therefore always triggers another lightweight version check and refresh.
  const readingVersion=await loadJournalVersion(asOf);
  const [hs,ps,ns,cs,im,last,version,firmReferences]=await Promise.all([
    db().prepare('SELECT account,revision,trades_data,summary_data FROM account_history ORDER BY account').all<{account:string;revision:number;trades_data:string;summary_data:string}>(),db().prepare('SELECT data FROM account_profiles').all<{data:string}>(),db().prepare('SELECT data FROM trade_notes').all<{data:string}>(),db().prepare('SELECT data FROM cash_records').all<{data:string}>(),
    db().prepare('SELECT id,source,added,duplicates,imported_at AS importedAt FROM journal_imports ORDER BY imported_at DESC LIMIT 30').all(),
    db().prepare('SELECT MAX(updated) AS updated FROM account_history').first<{updated:string}>(),
    db().prepare("SELECT value FROM journal_meta WHERE key='seed_version'").first<{value:string}>(),loadFirmReferences(),
  ]);
  const changed=hs.results.filter(h=>{const cached=realizedCache.get(h.account);return cached?.revision!==h.revision||(cached.nextFutureAt!==undefined&&cached.nextFutureAt<=asOf);});
  // Read original execution payloads only for changed accounts, in bounded chunks.
  for(let offset=0;offset<changed.length;offset+=30){
    const chunk=changed.slice(offset,offset+30);
    const records=await db().prepare(`SELECT account,data,revision FROM account_history WHERE account IN (${chunk.map(()=>'?').join(',')})`).bind(...chunk.map(h=>h.account)).all<{account:string;data:string;revision:number}>();
    for(const record of records.results){const history=JSON.parse(record.data)as AccountHistory,events=realizedEvents(record.account,history.fills.filter(fill=>Date.parse(fill.time)<=asOf)),rows=aggregateRealized(events);if(realizedCache.size>5000)realizedCache.clear();
      // A concurrent import is reflected on the next revision check. Only cache
      // the exact revision actually read, never label new data with an older one.
      const future=history.fills.map(fill=>Date.parse(fill.time)).filter(time=>time>asOf);
      realizedCache.set(record.account,{revision:record.revision,rows,events,sessions:aggregateRealized(events,'session'),...(events.some(event=>event.unmatched||event.coverageIssues)?{fills:history.fills.filter(fill=>Date.parse(fill.time)<=asOf)}:{}),...(future.length?{nextFutureAt:Math.min(...future)}:{})});
    }
  }
  const realized=hs.results.flatMap(h=>realizedCache.get(h.account)?.rows||[]);
  const futureTimes=[...realizedCache.values()].flatMap(cache=>cache.nextFutureAt!==undefined?[cache.nextFutureAt]:[]),nextFuture=futureTimes.length?new Date(Math.min(...futureTimes)).toISOString():null;
  if(nextFuture)await db().prepare("INSERT INTO journal_meta(key,value) VALUES ('next_future_fill',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value").bind(nextFuture).run();
  else await db().prepare("DELETE FROM journal_meta WHERE key='next_future_fill'").run();
  const cash=cs.results.map(r=>JSON.parse(r.data)as CashRecord),balanceData=await loadBalanceData(cash,ps.results.map(row=>JSON.parse(row.data)as AccountProfile),firmReferences,asOf);
  const resetSources=[...new Set(balanceData.adjustments.map(row=>row.account))].flatMap(account=>{const reset=latestPayoutDeduction(account,balanceData.adjustments,asOf);return reset?[{account,capturedAt:reset.to}]:[];});
  const checkpointSources=resetSources;
  const uniqueCheckpoints=checkpointSources.filter((row,i,all)=>all.findIndex(other=>other.account===row.account&&other.capturedAt===row.capturedAt)===i);
  const reportedCheckpoints=uniqueCheckpoints.flatMap(row=>{const point=reportedCheckpoint(row.account,row.capturedAt,balanceData.reported,realizedCache.get(row.account)?.events||[]);return point?[point]:[];});
  const {reported,...balanceSummary}=balanceData;
  const realizedSessions=hs.results.flatMap(h=>realizedCache.get(h.account)?.sessions||[]),realizedCheckpoints=uniqueCheckpoints.map(row=>realizedCheckpoint(row.account,row.capturedAt,realizedCache.get(row.account)?.events||[]));
  return {ready:true,firmReferences,realized,realizedSessions,realizedCheckpoints,reportedSessions:reported.sessions,reportedCheckpoints,...balanceSummary,revision:readingVersion.revision,trades:hs.results.flatMap(h=>JSON.parse(h.trades_data)).filter(trade=>Date.parse(trade.exit)<=asOf),accounts:hs.results.map(h=>JSON.parse(h.summary_data)),
    profiles:ps.results.map(r=>JSON.parse(r.data)),notes:ns.results.map(r=>JSON.parse(r.data)),cash,imports:im.results as unknown as Journal['imports'],lastSaved:last?.updated||'',seedVersion:version?.value||''};
}
function text(v:unknown,max=1000){if(typeof v!=='string')throw new Error('A text field is missing.');if(v.length>max)throw new Error('Text is too long.');return v.trim();}
function money(v:unknown){if(v===null||v===undefined||v==='')return null;if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>100000000)throw new Error('Amounts must be non-negative numbers.');return Math.round(v*100)/100;}
function validDate(value:unknown){const s=text(value,10);if(!/^20\d{2}-\d{2}-\d{2}$/.test(s)||new Date(s+'T12:00:00Z').toISOString().slice(0,10)!==s)throw new Error('Enter a valid date.');return s;}
export async function saveCash(input:Record<string,unknown>){
  const kind=text(input.kind,20);if(!['payout','evaluation','reset','activation','other'].includes(kind))throw new Error('Choose a valid transaction type.');
  const record:CashRecord={id:text(input.id,100),kind:kind as CashRecord['kind'],date:validDate(input.date),account:text(input.account??'',150),deduction:money(input.deduction),received:money(input.received),expense:money(input.expense),note:text(input.note??'',2000)};
  if(!record.id)throw new Error('Missing transaction identifier.');
  const previous=await db().prepare('SELECT data FROM cash_records WHERE id=?').bind(record.id).first<{data:string}>(),saved=previous?JSON.parse(previous.data)as CashRecord:undefined;
  if(saved?.firmPayout&&(record.kind!=='payout'||record.account!==saved.account))throw new Error('A firm payout stays attached to its original account.');
  if(record.account&&!await knownAccount(record.account))throw new Error('Choose an account from your journal.');
  if(kind==='payout'){
    if(!record.account)throw new Error('Select the funded account.');
    if(input.firmPayout!==undefined)record.firmPayout=validateFirmPayout(input.firmPayout);else if(saved?.firmPayout)record.firmPayout=saved.firmPayout;
    if(saved?.firmPayout&&canonicalJson(saved.firmPayout)!==canonicalJson(record.firmPayout))throw new Error('The original firm payout confirmation cannot be replaced by an edit.');
    const basis=input.payoutAmountBasis??saved?.payoutAmountBasis;if(basis!==undefined){if(!['gross-request','trader-share','unknown'].includes(String(basis)))throw new Error('Invalid payout amount basis.');record.payoutAmountBasis=basis as CashRecord['payoutAmountBasis'];}
    const split=input.payoutSplit??saved?.payoutSplit;if(split!==undefined){if(typeof split!=='number'||!Number.isFinite(split)||split<=0||split>1)throw new Error('Invalid trader profit split.');record.payoutSplit=split;}
    const approved=input.payoutApprovalAt??saved?.payoutApprovalAt;if(approved!==undefined){
      if(typeof approved!=='string'||!/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?(?:Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/.test(approved)||!Number.isFinite(Date.parse(approved))||new Date(approved.slice(0,19)+'Z').toISOString().slice(0,19)!==approved.slice(0,19))throw new Error('Use a valid payout approval time with an explicit timezone.');
      record.payoutApprovalAt=new Date(approved).toISOString();
    }
    if(record.deduction===null&&record.received===null&&!record.firmPayout)throw new Error('Enter the account deduction, cash received or firm payout confirmation.');record.expense=null;
  }else{if(record.expense===null||record.expense<=0)throw new Error('Enter the expense amount.');record.deduction=null;record.received=null;}
  await db().prepare('INSERT INTO cash_records(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').bind(record.id,JSON.stringify(record)).run();await bumpJournalRevision();return record;
}
export async function importFirmPayouts(input:Record<string,unknown>){
 const existing=(await db().prepare('SELECT data FROM cash_records').all<{data:string}>()).results.map(r=>JSON.parse(r.data)as CashRecord);
 const plan=planFirmPayoutImport(input.records,existing);
 for(const record of plan.records)if(!await knownAccount(record.account))throw new Error('Account '+record.account+' is not in this journal. No payouts were imported.');
 const results=plan.records.length?await db().batch(plan.records.map(r=>db().prepare('INSERT INTO cash_records(id,data) VALUES (?,?) ON CONFLICT(id) DO NOTHING').bind(r.id,JSON.stringify(r)))):[];
 const added=results.reduce((n,r)=>n+r.meta.changes,0);if(added)await bumpJournalRevision();
 const rows=(await db().prepare('SELECT data FROM cash_records').all<{data:string}>()).results.map(r=>JSON.parse(r.data)as CashRecord);
 return {added,duplicates:plan.duplicates+plan.records.length-added,summary:payoutSummary(rows)};
}
export async function saveProfile(input:Record<string,unknown>){
  const profile:AccountProfile={account:text(input.account,150),label:text(input.label??'',80),stage:text(input.stage??'Unclassified',30),status:text(input.status??'Unclassified',30),notes:text(input.notes??'',3000)};
  if(!['Unclassified','Evaluation','Funded'].includes(profile.stage)||!['Unclassified','Active','Failed','Upgraded','Retired'].includes(profile.status))throw new Error('Invalid account classification.');
  if(!await knownAccount(profile.account))throw new Error('Account not found.');
  await db().prepare('INSERT INTO account_profiles(account,data) VALUES (?,?) ON CONFLICT(account) DO UPDATE SET data=excluded.data').bind(profile.account,JSON.stringify(profile)).run();await bumpJournalRevision();return profile;
}
export async function saveTradeNote(input:Record<string,unknown>){
  const note:TradeNote={id:text(input.id,100),account:text(input.account,150),setup:text(input.setup??'',80),plan:text(input.plan??'',20),note:text(input.note??'',5000)};
  if(!['','Yes','No','Unclear'].includes(note.plan))throw new Error('Invalid plan status.');
  const row=await db().prepare('SELECT data FROM account_history WHERE account=?').bind(note.account).first<{data:string}>();
  if(!row||!(JSON.parse(row.data)as AccountHistory).trades.some(t=>t.id===note.id))throw new Error('Trade not found.');
  await db().prepare('INSERT INTO trade_notes(id,account,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').bind(note.id,note.account,JSON.stringify(note)).run();await bumpJournalRevision();return note;
}
export function validateFill(input:Record<string,unknown>):Fill&{account:string}{
  const account=text(input.account,150),id=text(input.id,150),contract=normalizeContract(text(input.contract,80));
  if(!account||!id)throw new Error('Account and execution ID are required.');
  const side=input.side;if(side!=='Buy'&&side!=='Sell')throw new Error('Invalid trade side.');
  if(typeof input.qty!=='number'||!Number.isInteger(input.qty)||input.qty<1||input.qty>100000)throw new Error('Invalid quantity.');
  if(typeof input.price!=='number'||!Number.isFinite(input.price)||input.price<=0)throw new Error('Invalid price.');
  const time=text(input.time,50);if(!/(Z|[+-]\d{2}:\d{2})$/.test(time)||!Number.isFinite(Date.parse(time)))throw new Error('Timestamps must include a time zone.');
  const pos=input.pos===null||input.pos===undefined?null:Number(input.pos);if(pos!==null&&(!Number.isInteger(pos)||Math.abs(pos)>100000))throw new Error('Invalid reported position.');
  return {account,id,...contract,side,qty:input.qty,price:input.price,time:new Date(time).toISOString(),pos,ordinal:0,entryFlag:typeof input.entryFlag==='boolean'?input.entryFlag:null};
}
export async function importExecutions(input:Record<string,unknown>){
  if(!await isReady())throw new Error('Wait for the existing history to finish loading.');
  if(!Array.isArray(input.fills)||input.fills.length<1||input.fills.length>1000)throw new Error('Import batches must contain 1–1,000 executions.');
  const source=text(input.source,200),checksum=text(input.checksum,100),chunk=Number(input.chunk);
  if(!/^[a-f0-9]{64}$/.test(checksum)||!Number.isInteger(chunk)||chunk<0)throw new Error('Invalid import identifier.');
  const logId=checksum+':'+chunk;
  const previous=await db().prepare('SELECT added,duplicates FROM journal_imports WHERE id=?').bind(logId).first<{added:number;duplicates:number}>();
  if(previous)return {added:0,duplicates:input.fills.length,replayed:true};
  const groups=new Map<string,Fill[]>();for(const raw of input.fills){const f=validateFill(raw);if(!groups.has(f.account))groups.set(f.account,[]);groups.get(f.account)!.push(f);}
  if(groups.size>20)throw new Error('Split this file into smaller account batches.');
  const updates:{history:AccountHistory;revision:number;fresh:boolean;added:number;duplicates:number}[]=[];
  for(const [account,fills] of groups){
    const row=await db().prepare('SELECT data,revision FROM account_history WHERE account=?').bind(account).first<{data:string;revision:number}>();
    const old:AccountHistory=row?JSON.parse(row.data):{account,fills:[],trades:[],issues:[]};const merged=mergeFills(old.fills,fills);
    if(merged.conflicts.length)throw new Error('Execution '+merged.conflicts[0]+' in '+account+' differs from your saved history. No conflicting rows were overwritten.');
    const history=merged.added?await reconstruct(account,merged.fills):old;
    if(JSON.stringify(history).length>1500000)throw new Error('This account needs a larger-history import layout. Your saved history has not been changed.');
    updates.push({history,revision:row?.revision||0,fresh:!row,added:merged.added,duplicates:merged.duplicates});
  }
  const now=new Date().toISOString();let added=0,duplicates=0;
  // CAS protects existing records if two browser sessions import at the same time.
  for(const u of updates){if(u.added){
    const compactTrades=JSON.stringify(u.history.trades.map(({parts:_,...t})=>t)),summary=JSON.stringify({account:u.history.account,fills:u.history.fills.length,issues:u.history.issues,first:u.history.fills[0]?.time||'',last:u.history.fills.at(-1)?.time||''});
    const sql=u.fresh?db().prepare('INSERT INTO account_history(account,data,trades_data,summary_data,revision,updated) VALUES (?,?,?,?,1,?) ON CONFLICT(account) DO NOTHING').bind(u.history.account,JSON.stringify(u.history),compactTrades,summary,now):db().prepare('UPDATE account_history SET data=?,trades_data=?,summary_data=?,revision=revision+1,updated=? WHERE account=? AND revision=?').bind(JSON.stringify(u.history),compactTrades,summary,now,u.history.account,u.revision);
    const result=await sql.run();if(result.meta.changes!==1)throw new Error('Another import updated this account. Re-upload safely to finish; duplicates will be ignored.');
  }added+=u.added;duplicates+=u.duplicates;}
  await indexExecutionTimes([...groups].flatMap(([account,fills])=>fills.map(fill=>({account,time:fill.time}))));
  const future=[...groups.values()].flat().map(fill=>fill.time).filter(time=>Date.parse(time)>Date.now()).sort()[0];
  if(future)await db().prepare("INSERT INTO journal_meta(key,value) VALUES ('next_future_fill',?) ON CONFLICT(key) DO UPDATE SET value=CASE WHEN value<? OR value>? THEN excluded.value ELSE value END").bind(future,now,future).run();
  await db().prepare('INSERT INTO journal_imports(id,source,added,duplicates,imported_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(logId,source,added,duplicates,now).run();
  if(added)await bumpJournalRevision();
  return {added,duplicates,accounts:groups.size,issues:updates.reduce((s,u)=>s+u.history.issues.length,0)};
}
export async function backupResponse(){
  const [hs,ps,ns,cs,im,version,accountState,firmReferences]=await Promise.all([
    db().prepare('SELECT data FROM account_history ORDER BY account').all<{data:string}>(),
    db().prepare('SELECT data FROM account_profiles').all<{data:string}>(),db().prepare('SELECT data FROM trade_notes').all<{data:string}>(),db().prepare('SELECT data FROM cash_records').all<{data:string}>(),
    db().prepare('SELECT id,source,added,duplicates,imported_at AS importedAt FROM journal_imports ORDER BY imported_at').all(),
    db().prepare("SELECT value FROM journal_meta WHERE key='seed_version'").first<{value:string}>(),loadAccountState(),loadFirmReferences(),
  ]);
  const metadata={accountState,firmReferences,firmAdjustments:KNOWN_FIRM_ADJUSTMENTS,format:'tradebook-backup-v1',exportedAt:new Date().toISOString(),timezone:'America/Chicago',profiles:ps.results.map(r=>JSON.parse(r.data)),notes:ns.results.map(r=>JSON.parse(r.data)),cash:cs.results.map(r=>JSON.parse(r.data)),imports:im.results,seedVersion:version?.value||''};
  const encoder=new TextEncoder();
  const sections=[{name:'balanceObservations',sql:"SELECT json_set(data,'$.receivedAt',received_at) AS data FROM account_observations ORDER BY account,captured_at,id"},{name:'recorderCaptures',sql:"SELECT json_set(data,'$.receivedAt',received_at) AS data FROM recorder_captures ORDER BY captured_at"},{name:'adjustmentLabels',sql:'SELECT data FROM balance_adjustment_labels ORDER BY id'},{name:'executionTimes',sql:"SELECT json_object('account',account,'time',time) AS data FROM execution_times ORDER BY account,time"}];
  async function* chunks(){
    yield JSON.stringify(metadata).slice(0,-1)+',"history":[';
    for(let i=0;i<hs.results.length;i++)yield (i?',':'')+hs.results[i].data;
    for(const current of sections){
      yield '],'+JSON.stringify(current.name)+':[';
      for(let offset=0;;offset+=500){
        const rows=await db().prepare(current.sql+' LIMIT 500 OFFSET ?').bind(offset).all<{data:string}>();
        if(rows.results.length)yield (offset?',':'')+rows.results.map(row=>row.data).join(',');
        if(rows.results.length<500)break;
      }
    }
    yield '],"priceBars":[';
    let contract='',start=-1,wrote=false;
    for(;;){
      const rows=await db().prepare("SELECT contract,start,json_object('id',contract||'|'||start,'contract',contract,'start',start,'end',start+60000,'open',open,'high',high,'low',low,'close',close,'volume',volume,'capturedAt',captured_at,'receivedAt',received_at) AS data FROM price_bars WHERE (contract,start)>(?,?) ORDER BY contract,start LIMIT 500").bind(contract,start).all<{contract:string;start:number;data:string}>();
      if(rows.results.length){yield (wrote?',':'')+rows.results.map(row=>row.data).join(',');wrote=true;const last=rows.results.at(-1)!;contract=last.contract;start=last.start;}
      if(rows.results.length<500)break;
    }
    yield ']}';
  }
  const iterator=chunks(),stream=new ReadableStream<Uint8Array>({async pull(controller){try{const next=await iterator.next();if(typeof next.value==='string')controller.enqueue(encoder.encode(next.value));else controller.close();}catch(error){controller.error(error);}},async cancel(){await iterator.return(undefined);}});
  return new Response(stream,{headers:{'Content-Type':'application/json','Content-Disposition':'attachment; filename="Tradebook-backup-'+new Date().toISOString().slice(0,10)+'.json"','Cache-Control':'no-store'}});
}
export async function getTrade(account:string,id:string){const row=await db().prepare('SELECT data FROM account_history WHERE account=?').bind(account).first<{data:string}>();if(!row)return null;const history=JSON.parse(row.data)as AccountHistory;const trade=history.trades.find(t=>t.id===id);if(!trade)return null;return {trade,fills:history.fills.filter(f=>trade.parts?.some(p=>p[0]===f.id))};}
