'use client';
import React,{useEffect,useMemo,useState} from 'react';
import {RefreshCw,LoaderCircle} from 'lucide-react';
import type {AccountProfile} from '../lib/types';
import type {PerformanceStage} from '../lib/performance-scope';
import {centralDay} from '../lib/analytics';
import {DAILY_LOSS_LIMIT,DAILY_LOSS_RULES_URL,DAILY_LOSS_HOURS_URL,summarizeDailyLoss} from '../lib/daily-loss';
import type {DailyLossReport,DailyLossSession} from '../lib/daily-loss';
import {runDailyLoss,DAILY_LOSS_CLIENT_ACCOUNTS,DAILY_LOSS_CLIENT_ROWS} from '../lib/daily-loss-runner';
import type {DailyLossRun} from '../lib/daily-loss-runner';
import {accountDisplayName} from './account-selector';
import {dateLabel,money,num,PanelTitle,signed,signClass,Stat,timeLabel} from './ui';

type Profiles=Map<string,AccountProfile>;
type State={key:string;data?:DailyLossRun;error?:string;checked?:number;total?:number};
export function DailyLossView({accounts,start,end,stage,profiles,refreshKey,onAccount}:{accounts:string[];start:string;end:string;stage:PerformanceStage;profiles:Profiles;refreshKey:string;onAccount:(account:string,day:string)=>void}){
 const [markedOnly,setMarkedOnly]=useState(false),[retry,setRetry]=useState(0),[state,setState]=useState<State>({key:''});
 const accountsKey=JSON.stringify([...new Set(accounts)].filter(account=>!markedOnly||profiles.get(account)?.status==='Upgraded').sort()),key=JSON.stringify([accountsKey,start,end,stage,markedOnly,refreshKey,retry]);
 useEffect(()=>{
  const controller=new AbortController();let active=true;
  setState({key,checked:0,total:Math.min(JSON.parse(accountsKey).length,DAILY_LOSS_CLIENT_ACCOUNTS)});
  void runDailyLoss({accounts:JSON.parse(accountsKey)as string[],start,end,stage,markedUpgradedOnly:markedOnly},async(request,signal)=>{
   const response=await fetch('/api/daily-loss',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),body:JSON.stringify(request)});
   const report=await response.json()as DailyLossReport&{error?:string};
   if(!response.ok)throw new Error(report.error||'Daily loss history could not be loaded.');
   return report;
  },controller.signal,(checked,total)=>{if(active)setState({key,checked,total});})
   .then(data=>{if(active)setState({key,data});})
   .catch(error=>{if(active)setState({key,error:error instanceof Error&&['TimeoutError','AbortError'].includes(error.name)?'Daily loss history timed out. Refresh analysis or use Sync now to retry.':error instanceof Error?error.message:'Daily loss history could not be loaded.'});});
  return()=>{active=false;controller.abort();};
 },[accountsKey,start,end,stage,markedOnly,refreshKey,retry,key]);
 const current=state.key===key?state:null,loading=!current?.data&&!current?.error;
 return <div className="daily-loss-view">
  <section className="panel daily-loss-intro"><PanelTitle title="$1,200 daily-loss scenario" sub="Recorded realized net from session opening · every contract in each account" action={<button className="button subtle small" onClick={()=>setRetry(value=>value+1)} disabled={loading}><RefreshCw size={14}/> Refresh analysis</button>}/>
   <p>Each session starts at zero at 5 PM Central and includes captured entry fees and partial exits. This measures recorded realized results; floating P&L can change when a firm limit would be reached.</p>
   <div className="daily-loss-tools"><label><input type="checkbox" checked={markedOnly} onChange={event=>setMarkedOnly(event.target.checked)}/> Only evaluations marked upgraded</label><small>A saved account status, without inferred passes or pass dates.</small></div>
   <details className="daily-loss-method"><summary>Definitions and account rules</summary>
    <p>Worst realized net is the lowest cumulative value from zero. Giveback measures the largest fall from a prior realized peak, separately from the −$1,200 opening-relative threshold. Fills with the same timestamp are combined because their physical order is unknown.</p>
    <p>After-crossing change is the actual end net minus the actual first crossing value, including any overshoot. It describes what happened later; it is not savings or a forced-stop replay. Positions still open, unrealized gains/losses, liquidation timing and slippage are excluded. A recorded crossing is not a confirmed firm breach, and an absent crossing does not establish safety.</p>
    <p>Net uses scheduled commission rates only where covered. A session with missing fees or entry/position history remains unknown. Complete means the captured ledger can be calculated; it does not prove all trading was captured. Payouts and account purchase costs are separate. Account stage follows saved classifications, not a reconstruction of each historical fill's phase.</p>
    <p>LucidFlex currently offers a Daily Loss Limit ON purchase option for both evaluations and funded accounts, with a soft lockout until the next session. This $1,200 scenario does not assign purchased rules to your accounts. The exact equity/fee enforcement calculation is not established here. <a href={DAILY_LOSS_RULES_URL} target="_blank" rel="noreferrer">Official configuration rules</a> · <a href={DAILY_LOSS_HOURS_URL} target="_blank" rel="noreferrer">Trading hours</a> · checked October 21, 2026.</p>
   </details>
  </section>
  {loading?<section className="panel daily-loss-loading" role="status"><LoaderCircle size={19} className="spin"/><span>Checking saved history · {num(current?.checked||0)} / {num(current?.total??accounts.length)} accounts</span></section>:current?.error?<section className="panel daily-loss-loading warning-text" role="alert">{current.error}</section>:current?.data&&<DailyLossResults key={key} result={current.data} profiles={profiles} onAccount={onAccount}/>}
 </div>;
}

const unavailableReason={missing:'No saved execution history', 'history-limit':'History exceeds this bounded analysis', 'invalid-history':'Execution history could not be verified',changed:'History changed during the request; refresh analysis'};
export function DailyLossResults({result,profiles,onAccount}:{result:DailyLossRun;profiles:Profiles;onAccount:(account:string,day:string)=>void}){
 const [subset,setSubset]=useState('all'),[page,setPage]=useState(0);
 const summary=useMemo(()=>summarizeDailyLoss(result.rows),[result.rows]);
 const rows=useMemo(()=>result.rows.filter(row=>subset==='all'||(subset==='crossed'?row.crossingAt!==null:!row.complete)),[result.rows,subset]);
 const pages=Math.max(1,Math.ceil(rows.length/50)),visible=rows.slice(page*50,(page+1)*50);
 return <>
  {result.limited&&<div className="notice daily-loss-notice" role="status"><strong>Partial report</strong><p>Showing {num(result.checkedAccounts)} of {num(result.requestedAccounts)} requested accounts. This view stops at {num(DAILY_LOSS_CLIENT_ACCOUNTS)} accounts or {num(DAILY_LOSS_CLIENT_ROWS)} account sessions. Narrow the account or date selection to inspect the remainder. Counts below describe the loaded portion.</p></div>}
  {result.unavailable.length>0&&<details className="notice daily-loss-unavailable"><summary>{num(result.unavailable.length)} account{result.unavailable.length===1?'':'s'} unavailable · excluded from session counts</summary><ul>{result.unavailable.map(row=><li key={row.account}><strong>{accountDisplayName(row.account,profiles.get(row.account))}</strong> · {unavailableReason[row.reason]}</li>)}</ul></details>}
  <div className="stats-grid"><Stat label="Account sessions" value={num(summary.sessions)} detail={num(summary.accounts)+' accounts · '+num(summary.complete)+' complete'}/><Stat label="Crossed −$1,200 · realized" value={num(summary.crossed)} detail="Among complete captured session paths" tone={summary.crossed?'negative':undefined}/><Stat label="Later recovered above −$1,200" value={num(summary.recovered)} detail={num(summary.endedBelow)+' crossed sessions ended at/below the level'}/><Stat label="Unknown session paths" value={num(summary.unknown)} detail="Missing fees or entry/position history" tone={summary.unknown?'warning-text':undefined}/></div>
  <section className="panel daily-loss-results"><PanelTitle title="Recorded account sessions" sub="5 PM Central evening activity belongs to the next date · modeled net in USD"/>
   <div className="daily-loss-stage-summary">{['Funded','Evaluation','Unclassified'].map(stage=>{const totals=summarizeDailyLoss(result.rows.filter(row=>row.stage===stage));return totals.sessions>0?<div key={stage}><strong>{stage==='Evaluation'?'Evaluations':stage}</strong><span>{num(totals.crossed)} crossed / {num(totals.complete)} complete sessions</span><small>{num(totals.unknown)} unknown · later actual change {money(totals.afterCrossChange)}</small></div>:null;})}</div>
   <div className="daily-loss-table-tools"><div className="segmented" aria-label="Daily loss session subset">{[['all','All sessions'],['crossed','Crossed'],['unknown','Unknown']].map(([value,label])=><button key={value} className={subset===value?'selected':''} onClick={()=>{setSubset(value);setPage(0);}}>{label}</button>)}</div><span>{num(rows.length)} account sessions</span></div>
   {rows.length?<div className="table-scroll"><table className="daily-loss-table"><thead><tr><th>Account</th><th>Session</th><th className="right">Worst realized net</th><th className="right">Peak giveback</th><th>First crossing · CT</th><th className="right">End net</th><th className="right">Later actual change</th><th>Recovery</th></tr></thead><tbody>{visible.map(row=><DailyLossRow key={row.account+'|'+row.day} row={row} profile={profiles.get(row.account)} onAccount={onAccount}/>)}</tbody></table></div>:<p className="daily-loss-empty">No captured sessions match these selections. Unmarked evaluations are not assumed to have passed.</p>}
   {pages>1&&<div className="daily-loss-pagination"><button className="button subtle small" disabled={page===0} onClick={()=>setPage(value=>value-1)}>Previous</button><span>Page {num(page+1)} of {num(pages)}</span><button className="button subtle small" disabled={page+1===pages} onClick={()=>setPage(value=>value+1)}>Next</button></div>}
   <p className="daily-loss-footer">End net is the last captured realized value, including in an unfinished session. Account and session links open completed trades for that whole-account session. Partial exits from positions still open remain in this report and may not have a completed trade to open. {result.asOf&&<>History checked {timeLabel(result.asOf)} CT.</>}</p>
  </section>
 </>;
}
function DailyLossRow({row,profile,onAccount}:{row:DailyLossSession;profile?:AccountProfile;onAccount:(account:string,day:string)=>void}){
 const amount=(value:number|null)=><span className={'amount '+signClass(value??0)}>{value===null?'—':signed(value)}</span>;
 return <tr data-crossed={row.crossingAt!==null}>
  <td><button className="text-button daily-loss-account" title={row.account} onClick={()=>onAccount(row.account,row.day)}>{accountDisplayName(row.account,profile,row.stage)}</button><small className="block muted">{row.stage}{row.markedUpgraded?' · Marked upgraded':''}</small>{!row.complete&&<small className="block warning-text">{[row.missingFees?num(row.missingFees)+' fees missing':'',row.unmatched?num(row.unmatched)+' unmatched quantity':'',row.coverageIssues?num(row.coverageIssues)+' inventory gaps':''].filter(Boolean).join(' · ')||'Coverage incomplete'}</small>}</td>
  <td><button className="text-button" onClick={()=>onAccount(row.account,row.day)}>{dateLabel(row.day,true)}</button><small className="block muted">{num(row.fills)} fills</small></td>
  <td className="right">{amount(row.worstNet)}</td><td className="right">{row.maxGiveback===null?'—':money(row.maxGiveback)}</td>
  <td>{row.crossingAt?<>{timeLabel(row.crossingAt)}<small className="block muted">{dateLabel(centralDay(row.crossingAt),true)} · {signed(row.crossingNet!)}</small></>:row.complete?<span className="muted">Not recorded</span>:<span className="warning-text">Unknown</span>}</td>
  <td className="right">{amount(row.endNet)}</td><td className="right">{amount(row.afterCrossChange)}</td>
  <td>{!row.complete?<span className="warning-text">Unknown</span>:row.crossingAt?<><span>{row.recoveredAboveAt?'Recovered above':'Stayed at/below'}</span><small className="block muted">Ended {row.endNet!>-DAILY_LOSS_LIMIT?'above':'at/below'} −$1,200</small></>:<span className="muted">—</span>}</td>
 </tr>;
}
