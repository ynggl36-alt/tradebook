'use client';
import './account-cards.css';
import React,{useEffect,useMemo,useState} from 'react';
import {Activity,ArrowRight,Clock3,Copy,Download,FolderOpen,Layers3,LoaderCircle,Search} from 'lucide-react';
import type {AccountProfile,Journal} from '../lib/types';
import type {AccountState,AccountValue} from '../lib/account-state';
import {accountAvailability,monitorFresh} from '../lib/account-state';
import {accountSyncStatus} from '../lib/recorder-status';
import {accountTradeGroups,centralDay,summarize} from '../lib/analytics';
import {netTradeSummary} from '../lib/trading-costs';
import {flexAccount} from '../lib/lucid-flex';
import {accountCardGroups} from '../lib/account-display';
import {cashLedgerRows,cashLedgerSummary} from '../lib/cash-ledger';
import {FlexProgress} from './flex-progress';
import {useRecorder} from './recorder-connection';
import {accountDisplayName} from './account-selector';
import {dateLabel,Empty,money,num,PanelTitle,signClass,Stat,timeLabel} from './ui';

const terminal=new Set(['Failed','Upgraded','Retired']);
function reported(value:AccountValue|undefined,currency:string){
 if(!value)return 'Not supplied';
 if(/^[A-Z]{3}$/.test(currency)){try{return new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:2}).format(value.value);}catch{}}
 return value.value.toLocaleString('en-US',{maximumFractionDigits:2})+' '+currency;
}
const at=(value:string)=>dateLabel(centralDay(value),true)+' · '+timeLabel(value)+' CT';

export function CurrentAccountsView({journal,profiles,onAccount,onSetup,onHistory}:{journal:Journal;profiles:Map<string,AccountProfile>;onAccount:(account:string)=>void;onSetup:()=>void;onHistory:()=>void}){
 const r=useRecorder(),{monitor,accounts}=r.accountState;
 const [now,setNow]=useState(Date.now()),[tab,setTab]=useState<'current'|'previous'>('current'),[search,setSearch]=useState(''),[showArchived,setShowArchived]=useState(false),[copied,setCopied]=useState('');
 useEffect(()=>{const update=()=>{if(document.visibilityState==='visible')setNow(Date.now());};const timer=setInterval(update,30000);window.addEventListener('focus',update);return()=>{clearInterval(timer);window.removeEventListener('focus',update);};},[]);
 useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(''),1800);return()=>clearTimeout(timer);},[copied]);
 const fresh=monitorFresh(monitor,now);
 const syncErrors=[...new Set([r.error,r.syncError,r.accountStateError].filter(Boolean))];
 const syncStatus=accountSyncStatus({phase:r.phase,syncEnabled:r.syncEnabled,syncing:r.syncing,hasError:syncErrors.length>0,monitor},now);
 const monitorCopy={
  permission:{title:'Folder access needed',description:'Allow this browser to read the recorder folder and resume automatic updates.'},
  loading:{title:'Checking the recorder connection',description:'Saved values retain their source timestamps.'},
  paused:{title:'Journal sync is paused',description:'Resume sync to save new executions and account snapshots.'},
  error:{title:'Account updates need attention',description:'Open Settings to review the sync problem.'},
  syncing:{title:'Saving recorder data',description:'The saved snapshot updates when the transfer finishes.'},
  fresh:{title:'Recent account snapshot',description:''},
  disconnected:{title:'Connect your recorder',description:'Open Tradebook in Chrome on your trading computer and connect the accounts-v2 folder in Settings.'},
  waiting:{title:'Waiting for an account snapshot',description:'Keep the recorder in Connected accounts mode and connect its accounts-v2 folder in Settings.'},
  stale:{title:'Waiting for a fresh account snapshot',description:monitor?.running?'Review the folder connection in Settings if NinjaTrader is recording.':'The last saved snapshot reported the recorder as stopped.'}
 }[syncStatus];
 const isPresent=(a:AccountState)=>!!monitor&&a.capturedAt===monitor.capturedAt&&monitor.accountsSeen.includes(a.account)&&a.connected;
 const current=accounts.filter(a=>isPresent(a)&&!terminal.has(profiles.get(a.account)?.status||''));
 const cashValues=current.filter(a=>a.currency==='USD'&&a.values.CashValue),usdCash=cashValues.reduce((sum,a)=>sum+a.values.CashValue!.value,0);
 const positionsKnown=current.filter(a=>a.positionsAvailable&&a.positionsAt===a.capturedAt),contracts=positionsKnown.reduce((sum,a)=>sum+a.positions.reduce((n,p)=>n+p.quantity,0),0);
 const payoutLedger=useMemo(()=>cashLedgerRows(journal.cash,journal.adjustments||[]),[journal.cash,journal.adjustments]);
 const income=cashLedgerSummary(payoutLedger.filter(row=>current.some(a=>a.account===row.account)));
 const visible=accounts.filter(a=>(tab==='current'?isPresent(a):!isPresent(a))&&(showArchived||!terminal.has(profiles.get(a.account)?.status||''))&&(a.account+' '+(profiles.get(a.account)?.label||'')).toLowerCase().includes(search.toLowerCase()));
 const groupedTrades=useMemo(()=>accountTradeGroups(journal.trades),[journal.trades]);
 const accountTotals=useMemo(()=>new Map([...groupedTrades].map(([account,ts])=>{const {trades:_,...totals}=netTradeSummary(ts);return [account,{...totals,gross:summarize(ts).gross,count:ts.length}];})),[groupedTrades]);
 const groups=accountCardGroups(visible,journal,profiles,now,groupedTrades);
 const copy=async(account:string)=>{try{await navigator.clipboard.writeText(account);setCopied(account);}catch{setCopied('');}};
 if(r.accountStateLoading&&!monitor)return <section className="panel"><div className="loading-inline"><LoaderCircle size={18} className="spin"/> Loading account snapshots…</div></section>;
 return <>
  <section className={'account-monitor panel '+(fresh?'fresh ':'')+(syncStatus==='fresh'?'account-monitor-normal':'')}>
   <div className="account-monitor-icon"><Activity size={20}/></div><div className="account-monitor-copy"><h2>{monitorCopy.title}</h2>{monitorCopy.description&&<p>{monitorCopy.description}</p>}{monitor&&<span className="account-monitor-time"><Clock3 size={12}/> Snapshot {at(monitor.capturedAt)}</span>}<div className="account-monitor-actions">{syncStatus==='permission'&&<button className="button primary small" disabled={r.busy} onClick={()=>void r.resume()}><FolderOpen size={14}/> Allow folder access</button>}{syncStatus==='paused'&&<button className="button primary small" disabled={r.busy} onClick={()=>void r.setExecutionSync(true)}>Resume sync</button>}{['permission','paused','error','disconnected','stale','waiting'].includes(syncStatus)&&<button className="text-button" onClick={onSetup}>Settings <ArrowRight size={14}/></button>}</div></div>
   <span className={'account-availability '+(fresh?'connected':'last-known')}>{syncStatus==='fresh'?'Automatic sync':fresh?'Recent snapshot':monitor?'Last known':'Setup needed'}</span>
  </section>
  {syncErrors.length>0&&<div className="error-box" role="alert">{syncErrors.join(' ')}</div>}
  {!monitor?<section className="panel account-setup"><div><Layers3 size={30}/><h2>Connect your current accounts</h2><p>The account recorder supplies balances and positions directly from NinjaTrader.</p></div><ol><li>Install recorder <b>0.4.1</b> and compile it in NinjaTrader.</li><li>Start <b>Connected accounts — read-only</b> with your account prefixes.</li><li>Connect its <b>accounts-v2</b> folder in Settings and enable journal sync.</li></ol><div className="recorder-actions"><a className="button primary small" href="/recorder/TradebookRecorder.cs?v=0.4.1" download><Download size={14}/> Recorder source</a><a className="button subtle small" href="/recorder/START-HERE.md?v=0.4.1" download>Setup guide</a><button className="text-button" onClick={onSetup}><FolderOpen size={14}/> Settings</button></div></section>:<>
   <div className="stats-grid account-state-stats"><Stat label={fresh?'Connected accounts':'Last connected accounts'} value={num(current.length)} detail="Active labels in the latest snapshot"/><Stat label="Reported balances" value={cashValues.length?money(usdCash):'—'} detail={cashValues.length+' of '+current.length+' accounts · USD'}/><Stat label={fresh?'Open contracts':'Last reported open contracts'} value={positionsKnown.length?num(contracts):'—'} detail={positionsKnown.length+' of '+current.length+' accounts supplied positions'}/><Stat label="Payouts · 2026" value={money(income.gross)} detail={income.count?num(income.count)+' payouts · full amounts':'No payouts for these accounts'}/></div>
   <section className="panel account-state-list"><PanelTitle title="Your accounts" action={<button className="text-button" onClick={onHistory}>Account archive <ArrowRight size={14}/></button>}/><div className="account-state-toolbar"><div className="segmented"><button className={tab==='current'?'selected':''} onClick={()=>setTab('current')}>Latest snapshot</button><button className={tab==='previous'?'selected':''} onClick={()=>setTab('previous')}>Previously seen</button></div><label className="account-state-search"><Search size={14}/><input aria-label="Search current accounts" placeholder="Search account or nickname" value={search} onChange={e=>setSearch(e.target.value)}/></label><label className="account-archive-toggle"><input type="checkbox" checked={showArchived} onChange={e=>setShowArchived(e.target.checked)}/> Include archived labels</label></div>
    {visible.length?<div className="account-stage-groups">{groups.map(group=><section className={'account-stage-group '+group.stage.toLowerCase()} key={group.stage} aria-labelledby={'account-group-'+group.stage}><header className="account-stage-heading"><div><h3 id={'account-group-'+group.stage}>{group.title}<span>{num(group.accounts.length)}</span></h3><p>{group.description}</p></div></header><div className="account-cards account-cards-compact">{group.accounts.map(({state:a,profile,stage,progress})=>{
     const reference=journal.firmReferences?.find(f=>f.account===a.account),total=accountTotals.get(a.account),flex=flexAccount(a.account),availability=accountAvailability(a,monitor,now),currentPositions=availability==='connected'&&a.positionsAvailable&&a.positionsAt===a.capturedAt,accountIncome=cashLedgerSummary(payoutLedger.filter(row=>row.account===a.account));
     const label=availability==='connected'?'Connected':availability==='disconnected'?'Disconnected':availability==='not-seen'?'Not in latest snapshot':'Last known';
     return <article className="account-card" key={a.account}><div className="account-card-header"><div><div className="account-card-identity"><button className="account-card-name" title={a.account} onClick={()=>onAccount(a.account)}>{accountDisplayName(a.account,profile,stage)}</button><button className="icon-btn account-id-copy" title={copied===a.account?'Account ID copied':'Copy full account ID: '+a.account} aria-label={copied===a.account?'Account ID copied':'Copy account ID'} onClick={()=>void copy(a.account)}><Copy size={12}/></button></div><div className="account-card-labels">{flex&&<span>Lucid Flex · 50K</span>}<span className={'account-availability '+availability}>{label}</span>{profile?.status&&profile.status!=='Unclassified'&&<span>{profile.status}</span>}</div></div></div>
      <div className="account-headline-values"><div className="account-cash"><span>Balance · NinjaTrader</span><strong>{reported(a.values.CashValue,a.currency)}</strong><small>{a.values.CashValue?'Read '+at(a.values.CashValue.at):'No confirmed platform value'}</small></div><div className="account-reported-realized"><span>Realized P&L · reported</span><strong className={signClass(a.values.RealizedProfitLoss?.value||0)}>{reported(a.values.RealizedProfitLoss,a.currency)}</strong><small>Platform period{a.values.RealizedProfitLoss&&<> · Read {at(a.values.RealizedProfitLoss.at)}</>}</small></div></div>
      <FlexProgress account={a.account} journal={journal} now={now} accountTrades={groupedTrades.get(a.account)} progress={progress} compact/>
      {a.positions.length>0&&<div className="account-open-positions"><h3>{currentPositions?'Open positions':'Last reported positions'}</h3>{a.positions.map(p=><div className="account-position" key={p.instrument}><span className={p.side==='Long'?'positive':'negative'}>{p.side} {p.quantity}</span><strong>{p.instrument}</strong><span>@ {p.averagePrice.toLocaleString('en-US',{maximumFractionDigits:6})}</span></div>)}{a.values.UnrealizedProfitLoss&&<div className="account-floating"><span>Floating P&L · reported<small>Read {at(a.values.UnrealizedProfitLoss.at)}</small></span><b className={signClass(a.values.UnrealizedProfitLoss.value)}>{reported(a.values.UnrealizedProfitLoss,a.currency)}</b></div>}{!currentPositions&&a.positionsAt&&<small>{at(a.positionsAt)}</small>}</div>}
      <details className="account-details"><summary>Details</summary><div><span>Snapshot</span><b>{at(a.capturedAt)}</b></div>{a.connection&&<div><span>Connection</span><b>{a.connection}{a.provider?' · '+a.provider:''}</b></div>}<div><span>Full account ID</span><b className="account-full-id">{a.account}</b></div><div><span>Net liquidation · platform</span><b>{reported(a.values.NetLiquidation,a.currency)}</b></div>{a.values.NetLiquidation&&<small>Read {at(a.values.NetLiquidation.at)}</small>}<div><span>Completed trades net · model · 2026</span><b>{money(total?.net)}</b></div><div><span>Completed trades gross · 2026</span><b>{total?.count?money(total.gross):'—'}</b></div><div><span>Scheduled commissions · 2026</span><b>{total?.complete?money(total.commissions):'Not fully covered'}</b></div>{reference&&<><div><span>{reference.firm} total profit · {dateLabel(reference.date,true)}</span><b>{money(reference.totalProfit)}</b></div><div><span>Firm minimum balance · same record</span><b>{money(reference.minimumBalance)}</b></div>{reference.flex?.qualifyingDays!==null&&reference.flex?.qualifyingDays!==undefined&&<div><span>Qualifying days · saved checkpoint</span><b>{num(reference.flex.qualifyingDays)} / 5</b></div>}</>}<div><span>Payouts · 2026</span><b>{money(accountIncome.gross)}</b></div><p>Reported realized P&L uses NinjaTrader’s reporting period and commission calculation. The trade model uses completed positions and scheduled fees. Firm records keep their recorded dates.</p></details>
      <div className="account-card-footer"><small title={'Snapshot '+at(a.capturedAt)+(a.connection?' · '+a.connection:'' )}>Snapshot {timeLabel(a.capturedAt)} CT</small><div><button className="text-button" onClick={()=>onAccount(a.account)}>Review <ArrowRight size={12}/></button></div></div>
     </article>;
    })}</div></section>)}</div>:<Empty title={tab==='current'?'No current accounts match':'No previously seen accounts match'} action={<button className="button subtle small" onClick={()=>setTab(tab==='current'?'previous':'current')}>{tab==='current'?'Show previously seen':'Show latest snapshot'}</button>}>Clear the filters or review the recorder connection in Settings.</Empty>}
   </section>
  </>}
  <p className="scope-note">Balances and realized P&L are platform reports, not calendar-day totals. Source timestamps show when each value was read.</p>
 </>;
}
