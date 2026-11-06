'use client';
import React,{useMemo,useState} from 'react';
import {ChevronLeft,ChevronRight} from 'lucide-react';
import type {AccountProfile,Trade,TradeNote} from '../lib/types';
import type {RealizedDay} from '../lib/realized';
import {summarizeRealized} from '../lib/realized';
import {centralDay,summarize} from '../lib/analytics';
import {flexSession} from '../lib/trading-session';
import {accountAvailability,monitorFresh} from '../lib/account-state';
import {normalizeContract} from '../lib/csv';
import {dateLabel,money,num,PanelTitle,pct,signed,signClass,Stat,timeLabel,TradeTable} from './ui';
import {useRecorder} from './recorder-connection';
import {accountDisplayName} from './account-selector';
import {matchesPerformanceStage,type PerformanceStage} from '../lib/performance-scope';
import {CalendarAccounts} from './calendar-accounts';

export function CalendarView({trades,sessions,profiles,accountFilter,stageFilter,accountStages,symbolFilter,notes,lastDay,onTrade,onAccount,refreshKey,year}:{year:number;trades:Trade[];sessions:RealizedDay[];profiles:Map<string,AccountProfile>;accountFilter:string;stageFilter:PerformanceStage;accountStages:ReadonlyMap<string,string>;symbolFilter:string;notes:Map<string,TradeNote>;lastDay:string;onTrade:(trade:Trade)=>void;onAccount:(account:string,day:string)=>void;refreshKey:string}){
 const [picked,setPicked]=useState<{month:string;day:string}|null>(null);
 const month=picked?.month??lastDay.slice(0,7),selected=picked?.day??lastDay;
 const monthRows=sessions.filter(row=>row.day.startsWith(month)),closed=summarize(trades.filter(trade=>flexSession(trade.exit).startsWith(month)));
 const days=useMemo(()=>{
  const grouped=new Map<string,RealizedDay[]>();
  for(const row of sessions){if(!row.day.startsWith(month))continue;const entries=grouped.get(row.day)||[];entries.push(row);grouped.set(row.day,entries);}
  return [...grouped].sort(([a],[b])=>a.localeCompare(b)).map(([day,entries])=>{const total=summarizeRealized(entries);return {day,pnl:total.gross,count:total.exits,incomplete:total.unmatched>0||total.coverageIssues>0};});
 },[sessions,month]);
 const dayMap=new Map(days.map(day=>[day.day,day])),total=summarizeRealized(monthRows).gross;
 const first=new Date(month+'-01T12:00:00Z'),offset=(first.getUTCDay()+6)%7,nDays=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate(),count=Math.ceil((offset+nDays)/7)*7,max=Math.max(1,...days.map(day=>Math.abs(day.pnl)));
 const move=(n:number)=>{const date=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+n,1,12)),next=date.toISOString().slice(0,7);if(next.startsWith(year+'-'))setPicked({month:next,day:''});};
 const selectedTrades=trades.filter(trade=>flexSession(trade.exit)===selected),selectedRows=sessions.filter(row=>row.day===selected),selectedTotal=summarizeRealized(selectedRows);
 return <>
  <div className="stats-grid"><Stat label="Month trading P&L · gross" value={money(total)} detail="Before commissions · closed contracts only" tone={signClass(total)}/><Stat label="Completed trades" value={num(closed.count)} detail={pct(closed.winRate)+' gross win rate'}/><Stat label="Best day" value={days.length?money(Math.max(...days.map(day=>day.pnl))):'—'} detail="Highest recorded daily gross result"/><Stat label="Average recorded day" value={days.length?money(total/days.length):'—'} detail={days.length+' days with captured activity'}/></div>
  {days.some(day=>day.incomplete)&&<div className="notice" role="status">Some days have incomplete execution history. Amounts marked * include only the portion that can be calculated.</div>}
  <section className="panel calendar-panel"><PanelTitle title={new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'long',year:'numeric'}).format(first)} sub="Trading sessions · 5 pm CT start · before commissions" action={<div className="calendar-nav"><button className="icon-btn" disabled={month===year+'-01'} onClick={()=>move(-1)} aria-label="Previous month"><ChevronLeft size={18}/></button><button className="button subtle small" onClick={()=>setPicked(null)}>Latest</button><button className="icon-btn" disabled={month===year+'-12'} onClick={()=>move(1)} aria-label="Next month"><ChevronRight size={18}/></button></div>}/>
   <div className="calendar-grid">{['MON','TUE','WED','THU','FRI','SAT','SUN'].map(day=><div className="calendar-weekday" key={day}>{day}</div>)}{Array.from({length:count},(_,i)=>{const n=i-offset+1;if(n<1||n>nDays)return <div className="calendar-blank" key={'blank'+i}/>;const day=month+'-'+String(n).padStart(2,'0'),result=dayMap.get(day),color=result?`rgb(var(--${result.pnl>=0?'profit':'loss'}-rgb) / ${.08+Math.abs(result.pnl)/max*.20})`:undefined;return <button key={day} className={'calendar-cell '+(selected===day?'selected':'')} style={{background:color}} onClick={()=>setPicked({month,day})}><span className={day===lastDay?'latest-day':''}>{n}</span>{result?<><strong className={signClass(result.pnl)}>{signed(result.pnl)}{result.incomplete?'*':''}</strong><small>{result.count} exit fills</small></>:<small className="calendar-no-trades">—</small>}</button>;})}</div>
  </section>
  <p className="scope-note">A trading day starts at 5 pm CT on the previous date. Evening fills count toward the next trading day. Fill times still show when you actually traded.</p>
  {selected&&<CalendarAccounts day={selected} trades={trades} sessions={sessions} profiles={profiles} accountStages={accountStages} symbolFilter={symbolFilter} refreshKey={refreshKey} onAccount={onAccount}/>}
  {selected&&<LatestPlatformReport day={selected} sessions={sessions} profiles={profiles} accountFilter={accountFilter} stageFilter={stageFilter} accountStages={accountStages} symbolFilter={symbolFilter}/>}
  {selected&&<section className="panel"><PanelTitle title={dateLabel(selected)} sub={signed(selectedTotal.gross)+' gross · '+num(selectedTrades.length)+' completed trades'}/><TradeTable trades={selectedTrades} notes={notes} onTrade={onTrade} limit={500} accountStages={accountStages}/></section>}
  {selected&&selectedRows.length>0&&<details className="panel data-details"><summary>Execution breakdown · {num(selectedTotal.exits)} exit fills<ChevronRight size={15}/></summary><RealizedResultsTable rows={selectedRows} day={selected} profiles={profiles} accountStages={accountStages}/></details>}
 </>;
}


function RealizedResultsTable({rows,day,profiles,accountStages}:{rows:RealizedDay[];day:string;profiles:Map<string,AccountProfile>;accountStages:ReadonlyMap<string,string>}){
 const {accountState}=useRecorder(),monitor=accountState.monitor,showPositions=!!monitor&&flexSession(monitor.capturedAt)===day;
 const ordered=[...rows].sort((a,b)=>a.symbol.localeCompare(b.symbol)||a.contract.localeCompare(b.contract)||a.account.localeCompare(b.account)),total=summarizeRealized(rows);
 if(!rows.length)return <p className="calendar-trade-note">No executions have been captured for this date and filter.</p>;
 const position=(row:RealizedDay)=>{
  const account=accountState.accounts.find(account=>account.account===row.account);
  if(!account?.positionsAt||flexSession(account.positionsAt)!==day)return <span className="muted">Not supplied</span>;
  const open=account.positions.find(position=>{try{return normalizeContract(position.instrument).contract===row.contract;}catch{return false;}});
  const current=accountAvailability(account,monitor)==='connected'&&account.positionsAvailable&&account.positionsAt===account.capturedAt;
  return <><span>{!current?'Last known · ':''}{open?num(open.quantity)+' '+open.side.toLowerCase():'Flat'}</span><small className="block muted">{dateLabel(centralDay(account.positionsAt),true)} · {timeLabel(account.positionsAt)} CT</small></>;
 };
 return <><div className="table-scroll"><table className="realized-results-table"><thead><tr><th>Contract</th><th>Account</th><th className="right">Contracts closed</th>{showPositions&&<th>Latest position</th>}<th className="right">Realized gross</th><th className="right">Net · model</th></tr></thead><tbody>{ordered.map(row=><tr key={row.account+'|'+row.contract+'|'+row.day}><td><strong>{row.symbol}</strong><small className="block muted">{row.contract.slice(row.symbol.length+1)}</small>{(row.unmatched>0||(row.coverageIssues||0)>0)&&<small className="block warning-text">Entry or position history incomplete</small>}</td><td><span className="account-text" title={row.account}>{accountDisplayName(row.account,profiles.get(row.account),accountStages.get(row.account))}</span></td><td className="right">{row.unmatched>0?'Unconfirmed':num(row.quantity)}<small className="block muted">{num(row.exits)} exit fills</small></td>{showPositions&&<td>{position(row)}</td>}<td className={'right amount '+signClass(row.gross)}>{signed(row.gross)}{row.unmatched>0||(row.coverageIssues||0)>0?'*':''}</td><td className={'right amount '+signClass(row.net??0)}>{row.net===null?'—':signed(row.net)}</td></tr>)}</tbody><tfoot><tr><td colSpan={2}><strong>Total recorded</strong></td><td className="right">{total.unmatched>0?'Unconfirmed':num(total.quantity)}<small className="block muted">{num(total.exits)} exit fills</small></td>{showPositions&&<td className="muted">Floating P&L excluded</td>}<td className={'right amount '+signClass(total.gross)}>{signed(total.gross)}</td><td className={'right amount '+signClass(total.net??0)}>{total.net===null?'—':signed(total.net)}</td></tr></tfoot></table></div><p className="calendar-trade-note realized-results-note">Rows group the selected day's captured activity by account and contract. Net subtracts scheduled fees on captured entries and exits. Missing cost coverage stays unavailable.</p></>;
}

function LatestPlatformReport({day,sessions,profiles,accountFilter,stageFilter,accountStages,symbolFilter}:{day:string;sessions:RealizedDay[];profiles:Map<string,AccountProfile>;accountFilter:string;stageFilter:PerformanceStage;accountStages:ReadonlyMap<string,string>;symbolFilter:string}){
 const {accountState}=useRecorder(),monitor=accountState.monitor;
 if(!monitor||flexSession(monitor.capturedAt)!==day||symbolFilter!=='all')return null;
 const session=day;
 const accounts=accountState.accounts.filter(account=>account.connected&&account.capturedAt===monitor.capturedAt&&monitor.accountsSeen.includes(account.account)&&(accountFilter==='all'||account.account===accountFilter)&&matchesPerformanceStage(account.account,stageFilter,accountStages));
 const known=accounts.filter(account=>account.currency==='USD'&&account.values.RealizedProfitLoss?.at===monitor.capturedAt);
 if(!known.length)return null;
 const reported=known.reduce((sum,account)=>sum+account.values.RealizedProfitLoss!.value,0),accountIds=new Set(known.map(account=>account.account)),captured=sessions.filter(row=>row.day===session&&accountIds.has(row.account)),estimate=summarizeRealized(captured),fresh=monitorFresh(monitor);
 const perAccount=known.map(account=>({account,model:summarizeRealized(captured.filter(row=>row.account===account.account))}));
 const complete=perAccount.every(row=>row.model.net!==null),difference=complete?reported-estimate.net!:null,matches=difference!==null&&Math.abs(difference)<.005&&perAccount.every(row=>Math.abs(row.account.values.RealizedProfitLoss!.value-row.model.net!)<.005);
 return <details className="panel data-details realized-reconciliation" open={!matches}>
  <summary>{fresh?'NinjaTrader comparison':'Last-known NinjaTrader comparison'} <span className={matches?'positive':'warning-text'}>{matches?'Matches captured session':difference===null?'Coverage to check':money(difference)+' difference'}</span><ChevronRight size={15}/></summary>
  <div className="data-details-caption">Read {dateLabel(centralDay(monitor.capturedAt),true)} · {timeLabel(monitor.capturedAt)} CT · {known.length} USD accounts · session dated {dateLabel(session,true)}</div>
  <div className="realized-comparison-values"><div><span>Realized P&L · platform</span><strong className={signClass(reported)}>{money(reported)}</strong><small>Reported by NinjaTrader</small></div><div><span>Session net · estimate</span><strong className={signClass(estimate.net??0)}>{money(complete?estimate.net:null)}</strong><small>FIFO exits less scheduled fees on captured fills</small></div><div><span>Difference to check</span><strong className={matches?'muted':'warning-text'}>{money(difference)}</strong><small>Same accounts · provider periods can differ</small></div></div>
  <p>Execution estimates use the 5 pm CT futures session and include partial exits. Missing history, timing, provider reporting periods or fee settings can leave a difference. Use the platform value for the reported account result.</p>
  <div className="table-scroll"><table><thead><tr><th>Account</th><th className="right">Platform realized</th><th className="right">Session net estimate</th></tr></thead><tbody>{perAccount.map(({account,model})=><tr key={account.account}><td title={account.account}>{accountDisplayName(account.account,profiles.get(account.account),accountStages.get(account.account))}</td><td className="right">{money(account.values.RealizedProfitLoss!.value)}</td><td className="right">{money(model.net)}</td></tr>)}</tbody></table></div>
 </details>;
}
