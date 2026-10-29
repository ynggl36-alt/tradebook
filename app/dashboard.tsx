'use client';
import React,{useState,useEffect,useMemo,useRef} from 'react';
import {CalendarDays,Layers3,ChartNoAxesCombined,Wallet,Database,ChevronRight,ShieldCheck,LoaderCircle,ArrowRight,BookOpen,SlidersHorizontal,CheckCircle2,RefreshCw} from 'lucide-react';
import type {CostRecord,Journal,Trade} from '../lib/types';
import {centralDay,dailySeries,summarize} from '../lib/analytics';
import {journalForYear,REPORTING_YEAR,reportingRange} from '../lib/reporting-year';
import {api,dateLabel,money,num,pct,signClass,Stat,PanelTitle,EquityChart,TradeTable} from './ui';
import {CalendarView,AccountsView,PatternsView,CashView,DataView} from './views';
import {AccountDialog,TradeDialog,CostDialog,type AccountScope} from './dialogs';
import {AccountSelector} from './account-selector';
import {StageFilter} from './stage-filter';
import {scopePerformance,performanceAccountLabel,type PerformanceStage} from '../lib/performance-scope';
import {RecorderBadge,RecorderProvider,useCloudJournalRevision,useRecorder} from './recorder-connection';
import {SimulatorView} from './simulator-view';
import {CurrentAccountsView} from './current-accounts';
import {ThemeToggle} from './theme';
import {DailyLossView} from './daily-loss-view';
import {latestDailyLossSession} from '../lib/daily-loss';

type View='accounts'|'history'|'calendar'|'overview'|'patterns'|'daily-loss'|'cash'|'data'|'simulator';
const nav=[{id:'accounts',label:'Accounts',icon:Layers3,views:['accounts','history']},{id:'calendar',label:'Calendar',icon:CalendarDays,views:['calendar']},{id:'overview',label:'Analysis',icon:ChartNoAxesCombined,views:['overview','patterns','daily-loss']},{id:'cash',label:'Payouts & costs',icon:Wallet,views:['cash']},{id:'data',label:'Settings',icon:Database,views:['data']}]as const;
export default function Dashboard(){
 return <RecorderProvider><JournalDashboard/></RecorderProvider>;
}
function JournalDashboard(){
 const cloudRevision=useCloudJournalRevision();
 const recorder=useRecorder(),manualRunning=useRef(false);
 const [refreshing,setRefreshing]=useState(false),[lastManualCheck,setLastManualCheck]=useState(0),[updateError,setUpdateError]=useState('');
 const [sourceJournal,setSourceJournal]=useState<Journal|null>(null),[error,setError]=useState(''),[progress,setProgress]=useState('Opening your 2026 journal…'),[view,setView]=useState<View>('accounts');
 const journal=useMemo(()=>sourceJournal?journalForYear(sourceJournal):null,[sourceJournal]);
 const pendingBalanceChanges=sourceJournal?.adjustments?.some(row=>!row.settled)??false;
 const [period,setPeriod]=useState('all'),[account,setAccount]=useState('all'),[symbol,setSymbol]=useState('all'),[chartMode,setChartMode]=useState('cumulative'),[stage,setStage]=useState<PerformanceStage>('all');
 const [activeTrade,setActiveTrade]=useState<{trade:Trade;pnlMode:'gross'|'net'}|null>(null),[activeAccount,setActiveAccount]=useState<{account:string;scope?:AccountScope;pnlMode:'gross'|'net'}|null>(null),[cashEdit,setCashEdit]=useState<CostRecord|null>(null),[toast,setToast]=useState(''),[busy,setBusy]=useState(false);
 const loaded=useRef(false),journalRequest=useRef(0);
 const refresh=async()=>{const request=++journalRequest.current,data=await api<Journal>('journal');if(request===journalRequest.current)setSourceJournal(data);return data;};
 const refreshAll=async()=>{
  if(manualRunning.current||recorder.busy||recorder.syncing)return;
  manualRunning.current=true;setRefreshing(true);
  try{
   const folderOk=recorder.folder?await recorder.scan(true):true;
   const accountOk=await recorder.refreshAccountState();await refresh();
   setLastManualCheck(Date.now());setUpdateError('');
   setToast(!folderOk||!accountOk?'History refreshed. Check Settings for the folder or account update problem.':!recorder.syncEnabled?'Saved data refreshed. Journal uploads remain paused.':'Latest saved files, account values and trade history checked.');
  }catch(e){setUpdateError(e instanceof Error?e.message:String(e));setToast('Refresh could not finish. Your saved history is retained.');}
  finally{manualRunning.current=false;setRefreshing(false);}
 };
 useEffect(()=>{
  if(!sourceJournal?.revision)return;
  let cancelled=false,checking=false,lastCheck=Date.now();
  const check=async()=>{
   const interval=document.visibilityState==='visible'?60000:120000;
   if(checking||Date.now()-lastCheck<interval)return;checking=true;lastCheck=Date.now();
   const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
   try{const response=await fetch('/api/journal-version',{cache:'no-store',signal:controller.signal}),data=await response.json()as {revision?:string;error?:string};if(!response.ok||!data.revision)throw new Error(data.error||'Background updates are delayed.');if(!cancelled){if(data.revision!==sourceJournal.revision||pendingBalanceChanges)await refresh();setUpdateError('');}}
   catch(e){if(!cancelled)setUpdateError(e instanceof Error?e.message:String(e));}finally{clearTimeout(timeout);checking=false;}
  };
  const timer=setInterval(()=>void check(),30000),focus=()=>{if(document.visibilityState==='visible')void check();};window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
  return()=>{cancelled=true;clearInterval(timer);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};
 },[sourceJournal?.revision,pendingBalanceChanges]);
 useEffect(()=>{if(!cloudRevision)return;let cancelled=false;refresh().then(()=>{if(!cancelled)setToast('New recorder executions saved to your journal');}).catch(e=>{if(!cancelled)setToast('Executions saved; refresh the journal to update this view. '+e.message);});return()=>{cancelled=true;};},[cloudRevision]);
 useEffect(()=>{if(loaded.current)return;loaded.current=true;const request=++journalRequest.current;(async()=>{try{let j=await api('journal');if(!j.ready){let offset=0,ready=false;while(!ready){const result=await api('bootstrap',{offset});offset=result.next;ready=result.ready;setProgress('Bringing across your history · '+Math.round(offset/result.total*100)+'%');}j=await api('journal');}if(request===journalRequest.current)setSourceJournal(j);}catch(e){setError(e instanceof Error?e.message:String(e));}})();},[]);
 useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(''),4500);return()=>clearTimeout(t);},[toast]);
 const notes=useMemo(()=>new Map((journal?.notes||[]).map(n=>[n.id,n])),[journal?.notes]);
 const profiles=useMemo(()=>new Map((sourceJournal?.profiles||[]).map(p=>[p.account,p])),[sourceJournal?.profiles]);
 const lastDay=useMemo(()=>{const times=(journal?.accounts||[]).map(a=>a.last).filter(Boolean).sort((a,b)=>Date.parse(a)-Date.parse(b));return times.length?centralDay(times.at(-1)!):reportingRange('all',centralDay(new Date().toISOString())).end;},[journal?.accounts]);
 const lastSession=useMemo(()=>latestDailyLossSession(journal?.realizedSessions||[],lastDay),[journal?.realizedSessions,lastDay]);
 const through=view==='cash'?[lastDay,centralDay(new Date().toISOString()),...(journal?.cash||[]).map(row=>row.date),...(journal?.adjustments||[]).map(row=>row.date)].sort().at(-1)!:view==='daily-loss'?lastSession:lastDay;
 const {start,end:viewEnd}=reportingRange(period,through);
 const performanceView=['overview','patterns','daily-loss','calendar','history'].includes(view),effectiveStage=performanceView?stage:'all';
 const performance=useMemo(()=>journal?scopePerformance(view==='daily-loss'&&sourceJournal?sourceJournal:journal,effectiveStage,account,view==='daily-loss'?'all':symbol,sourceJournal||journal):null,[journal,sourceJournal,effectiveStage,account,symbol,view]);
 const accountFilter=performance?.account||account,baseTrades=performance?.trades||[],baseRealized=performance?.realized||[];
 useEffect(()=>{if(performanceView&&performance&&account!==performance.account)setAccount(performance.account);},[performanceView,performance,account]);
 const historyJournal=useMemo(()=>journal&&performance?{...journal,accounts:performance.accounts}:journal,[journal,performance]);
 const accountChoices=useMemo(()=>(performance?.accounts||[]).map(row=>({...row,stage:performance?.stages.get(row.account)})),[performance]);
 const unknownStages=journal?.accounts.filter(row=>(accountFilter==='all'||row.account===accountFilter)&&!['Funded','Evaluation'].includes(performance?.stages.get(row.account)||'Unclassified')).length||0;
 const trades=useMemo(()=>baseTrades.filter(t=>centralDay(t.exit)>=start&&centralDay(t.exit)<=viewEnd),[baseTrades,start,viewEnd]);
 const stats=useMemo(()=>summarize(trades),[trades]);
 const symbols=useMemo(()=>[...new Set([...(journal?.trades||[]).map(t=>t.symbol),...(journal?.realized||[]).map(row=>row.symbol)])].sort(),[journal?.trades,journal?.realized]);
 const onTrade=(trade:Trade,pnlMode:'gross'|'net'='gross')=>{setActiveAccount(null);setActiveTrade({trade,pnlMode});};
 const onAccount=(selected:string,scope?:AccountScope,pnlMode:'gross'|'net'='gross')=>{setActiveTrade(null);setActiveAccount({account:selected,scope:scope||(view==='history'?{start,end:viewEnd,symbol,label:period==='all'?'All 2026 trades':dateLabel(start,true)+' – '+dateLabel(viewEnd,true)+', 2026'}:undefined),pnlMode});};
 const save=async(path:string,payload:unknown)=>{setBusy(true);try{await api(path,payload);await refresh();setToast('Saved to your journal');return true;}catch(e){setToast(e instanceof Error?e.message:String(e));return false;}finally{setBusy(false);}};
 if(!journal)return <main className="opening"><span className="brand-icon">T</span><h1>Tradebook</h1>{error?<><p className="negative">{error}</p><button className="button primary" onClick={()=>location.reload()}>Try again</button></>:<><LoaderCircle className="spin" size={23}/><p>{progress}</p><small>Your existing accounts and trades stay together.</small></>}</main>;
 const activeNav=nav.find(n=>n.views.some(id=>id===view))||{id:'simulator',label:'Sim101 test'};
 const subnav=view==='accounts'||view==='history'?[{id:'accounts' as View,label:'Current'},{id:'history' as View,label:'Archive'}]:view==='overview'||view==='patterns'||view==='daily-loss'?[{id:'overview' as View,label:'Overview'},{id:'patterns' as View,label:'Entries'},{id:'daily-loss' as View,label:'Daily loss'}]:[];
 return <div className="app-shell"><aside className="sidebar"><a className="brand" href="/"><span className="brand-icon">T</span><span>tradebook<span className="brand-dot">.</span></span></a><div className="sidebar-label">2026 JOURNAL</div><nav>{nav.map(n=><button key={n.id} aria-label={n.label} title={n.label} className={'nav-link '+(n.views.some(id=>id===view)?'active':'')} onClick={()=>setView(n.id)}><n.icon size={19}/><span>{n.label}</span></button>)}</nav><div className="sidebar-note"><BookOpen size={20}/><strong>Your 2026 journal.</strong><p>Keep each account’s trades and progress together.</p><button onClick={()=>setView('data')}>Settings <ArrowRight size={14}/></button></div><div className="sidebar-bottom"><span className="avatar">T</span><div><strong>Personal workspace</strong><small><ShieldCheck size={11}/> Private · saved online</small></div></div></aside>
 <div className="main-shell"><div className="topbar"><span><span className="muted">Journal · {REPORTING_YEAR}</span><ChevronRight size={13}/>{activeNav.label}</span><div className="top-actions"><button className="button subtle small sync-now" onClick={()=>void refreshAll()} disabled={refreshing||recorder.busy||recorder.syncing||recorder.phase==='loading'} title="Read the latest saved recorder files, sync allowed uploads and refresh every journal view. This does not force a new NinjaTrader snapshot."><RefreshCw size={14} className={refreshing?'spin':''}/>{refreshing?'Syncing…':'Sync now'}</button><RecorderBadge onClick={()=>setView('data')}/><span className="private-badge"><ShieldCheck size={13}/> Only you</span><ThemeToggle/></div></div>
 <main className="workspace"><header className="page-header"><div><div className="eyebrow">{view==='simulator'?'RECORDER TEST':view==='cash'?'THE BUSINESS OF TRADING':view==='data'?'A HISTORY YOU KEEP':'YOUR TRADING JOURNAL'}</div><h1>{activeNav.label}</h1><p>{view==='simulator'?'Inspect recorded simulator fills and price history.':view==='overview'?'Completed positions before trading costs. Use Calendar for daily realized exits.':view==='accounts'?'Reported balances, P&L and progress for the accounts you hold now.':view==='history'?'Compare completed trade results across your 2026 accounts.':view==='calendar'?'Daily trading results and completed trades.':view==='patterns'?'Inspect automatic entry context, your reviews and trading conditions.':view==='daily-loss'?'Inspect a $1,200 realized-loss scenario for each whole-account session.':view==='cash'?'Account payouts and recorded trading costs.':'Automatic sync, backups and recovery.'}</p></div><div className="data-through">{view==='accounts'?<>Platform snapshots<small>Source timestamps on each account</small></>:view==='simulator'?<>Local recorder data<small>Sim101 only · Central time · USD</small></>:<><span className="status-dot"/> History through {dateLabel(view==='daily-loss'?lastSession:lastDay,true)}<small>2026 only · Central time · USD</small></>}</div></header>
 {(updateError||lastManualCheck>0)&&<div className="refresh-feedback" role="status">{updateError?<span className="warning-text">Updates need attention: {updateError}</span>:<span>Synced {new Date(lastManualCheck).toLocaleTimeString('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit',second:'2-digit'})} CT</span>}</div>}
 {subnav.length>0&&<div className="section-subnav" role="navigation" aria-label={activeNav.label+' sections'}>{subnav.map(item=><button key={item.id} className={view===item.id?'selected':''} onClick={()=>setView(item.id)}>{item.label}{item.id==='history'&&<small>{num(journal.accounts.length)}</small>}</button>)}</div>}
 {view!=='data'&&view!=='simulator'&&view!=='accounts'&&<div className="filters"><div className="filter-label"><SlidersHorizontal size={14}/> View</div>{performanceView&&<StageFilter value={stage} onChange={setStage}/>}<AccountSelector ariaLabel="Filter account" value={accountFilter} onChange={setAccount} accounts={accountChoices} profiles={profiles} allLabel={performanceAccountLabel(effectiveStage)}/>{view!=='cash'&&<select className={view==='daily-loss'?'daily-loss-instruments':undefined} aria-label="Filter instrument" value={view==='daily-loss'?'all':symbol} disabled={view==='daily-loss'} title={view==='daily-loss'?'Daily loss always includes every instrument in the account.':undefined} onChange={e=>setSymbol(e.target.value)}><option value="all">All instruments</option>{symbols.map(s=><option key={s}>{s}</option>)}</select>}{view!=='calendar'&&<div className="period-control">{[['7','7 days'],['30','30 days'],['90','90 days'],['all','2026']].map(([p,label])=><button key={p} className={period===p?'selected':''} onClick={()=>setPeriod(p)}>{label}</button>)}</div>}<span className="filter-caption">{view==='calendar'?'January – December 2026':period==='all'?'January 1 – December 31, 2026':dateLabel(start,true)+' – '+dateLabel(viewEnd,true)}</span></div>}
 {view==='daily-loss'&&<p className="daily-loss-scope-note">Whole-account analysis · all instruments included. Instrument selection is paused in this view.</p>}
 {performanceView&&unknownStages>0&&<p className="performance-stage-note">Across 2026, {num(unknownStages)} account{unknownStages===1?' has':'s have'} no stage. Included in Both.</p>}
 {view==='overview'&&<><div className="stats-grid"><Stat label="Completed trades · gross P&L" value={money(stats.gross)} detail={num(stats.count)+' completed trades · before costs'} tone={signClass(stats.gross)}/><Stat label="Win rate" value={stats.count?pct(stats.winRate):'—'} detail={num(stats.wins)+' wins / '+num(stats.losses)+' losses'}/><Stat label="Average trade" value={money(stats.count?stats.avg:null)} detail="Gross result per completed trade" tone={signClass(stats.avg)}/><Stat label="Profit factor" value={stats.pf===null?'—':stats.pf.toFixed(2)} detail="Winning dollars ÷ losing dollars"/></div>
 <div className="overview-grid"><section className="panel equity-panel"><PanelTitle title="The shape of your results" sub="Completed positions, booked on their final closing date" action={<div className="segmented"><button className={chartMode==='cumulative'?'selected':''} onClick={()=>setChartMode('cumulative')}>Cumulative</button><button className={chartMode==='daily'?'selected':''} onClick={()=>setChartMode('daily')}>Daily</button></div>}/><EquityChart trades={trades} mode={chartMode}/><div className="chart-footer"><span><i className="legend-dot"/> Completed trades · gross P&L</span><span>Withdrawals do not change this curve</span></div></section>
 <section className="panel outcome-panel outcome-summary"><PanelTitle title="Wins & losses"/><div className="outcome-counts"><div><span>Wins</span><strong>{num(stats.wins)}</strong></div><div><span>Losses</span><strong>{num(stats.losses)}</strong></div><div><span>Scratches</span><strong>{num(stats.scratches)}</strong></div></div><div className="outcome-amounts"><div><span>Average winner</span><strong className="positive">{money(stats.wins?stats.avgWin:null)}</strong></div><div><span>Average loser</span><strong className="negative">{money(stats.losses?stats.avgLoss:null)}</strong></div></div></section></div>
 <ReviewStrip trades={trades}/><section className="panel"><PanelTitle title="Recent completed trades" sub="Most recently closed first · open a trade to inspect fills or add an entry tag" action={<button className="text-button" onClick={()=>setView('calendar')}>View calendar <ArrowRight size={15}/></button>}/><p className="calendar-trade-note">Each row combines the entries and exits until that account is flat in that contract. Partial exits from a position still open appear in Trading calendar → Realized exits.</p><TradeTable trades={trades} notes={notes} onTrade={onTrade} limit={8} accountStages={performance!.stages}/></section><p className="scope-note">These statistics use completed positions before trading costs. Realized daily P&L includes partial exits on their actual exit dates; payouts and account costs are recorded separately.</p></>}
 {view==='calendar'&&<CalendarView year={REPORTING_YEAR} trades={baseTrades} realized={baseRealized} realizedSessions={performance!.sessions} profiles={profiles} accountFilter={accountFilter} stageFilter={effectiveStage} accountStages={performance!.stages} symbolFilter={symbol} notes={notes} lastDay={lastDay} onTrade={onTrade} refreshKey={(sourceJournal?.revision||'')+'|'+lastManualCheck} onAccount={(selected,day)=>onAccount(selected,{start:day,end:day,symbol,label:dateLabel(day)})}/>}
 {view==='accounts'&&<CurrentAccountsView journal={journal} profiles={profiles} onAccount={onAccount} onSetup={()=>setView('data')} onHistory={()=>setView('history')}/>}
 {view==='history'&&<AccountsView journal={historyJournal!} trades={trades} profiles={profiles} onAccount={onAccount} accountFilter={accountFilter}/>}
 {view==='patterns'&&<PatternsView trades={trades} notes={notes} onTrade={onTrade} accountStages={performance!.stages}/>}
 {view==='daily-loss'&&<DailyLossView accounts={accountChoices.filter(row=>accountFilter==='all'||row.account===accountFilter).map(row=>row.account)} start={start} end={viewEnd} stage={effectiveStage} profiles={profiles} refreshKey={(sourceJournal?.revision||'')+'|'+lastManualCheck} onAccount={(selected,day)=>onAccount(selected,{start:day,end:day,symbol:'all',basis:'session',label:'Session '+dateLabel(day)},'net')}/>}
 {view==='cash'&&<CashView journal={journal} start={start} end={viewEnd} account={account} profiles={profiles} onEdit={setCashEdit} onUpdated={refresh}/>}
 {view==='data'&&<DataView journal={sourceJournal!} onSimulator={()=>setView('simulator')} onUpdated={async()=>{await refresh();setToast('Your history is up to date');}}/>}
 {view==='simulator'&&<SimulatorView onConnect={()=>setView('data')}/>}
 <footer className="app-footer"><span>tradebook<span className="brand-dot">.</span></span><span>Your 2026 trades. Your history.</span></footer></main></div>
 {activeAccount&&<AccountDialog key={activeAccount.account} account={activeAccount.account} scope={activeAccount.scope} pnlMode={activeAccount.pnlMode} journal={activeAccount.scope?.basis==='session'?sourceJournal!:journal} profiles={profiles} notes={notes} onTrade={onTrade} onClose={()=>setActiveAccount(null)} onSave={p=>save('profile',p)} onSaveFirm={r=>save('firm-reference',r)} busy={busy}/>}
 {activeTrade&&<TradeDialog key={activeTrade.trade.id} trade={activeTrade.trade} pnlMode={activeTrade.pnlMode} stage={performance?.stages.get(activeTrade.trade.account)} note={notes.get(activeTrade.trade.id)} setups={[...new Set(journal.notes.map(n=>n.setup).filter(Boolean))]} onClose={()=>setActiveTrade(null)} onConnect={()=>{setActiveTrade(null);setView('data');}} onSave={n=>save('note',n)} busy={busy}/>}
 {cashEdit&&<CostDialog record={cashEdit} accounts={cashEdit.account&&!sourceJournal!.accounts.some(a=>a.account===cashEdit.account)?[...sourceJournal!.accounts,{account:cashEdit.account,fills:0,issues:[],first:'',last:''}]:sourceJournal!.accounts} profiles={profiles} onClose={()=>setCashEdit(null)} busy={busy} onSave={async r=>{if(await save('cash',r))setCashEdit(null);}} onDelete={async id=>{setBusy(true);try{await api('cash',{id},'DELETE');await refresh();setCashEdit(null);setToast('Transaction removed');}catch(e){setToast(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}}/>}
 {toast&&<div className="toast" role="status"><CheckCircle2 size={17}/>{toast}</div>}</div>;
}
function ReviewStrip({trades}:{trades:Trade[]}){
 const days=dailySeries(trades),s=summarize(trades),green=days.filter(d=>d.pnl>0).length;
 return <div className="analysis-notes"><span>{green} / {days.length} trading days had a positive gross result</span><details className="advanced-analysis overview-advanced"><summary>Advanced trade statistics</summary><div className="account-facts"><div><span>Closed-trade drawdown</span><b>{money(s.drawdown)}</b></div><div><span>Peak cumulative gross P&L</span><b>{money(s.peak)}</b></div><div><span>Profit given back</span><b>{money(s.giveback)}</b></div></div><p>Completed-trade drawdown differs from the firm’s minimum-balance rule.</p></details></div>;
}
