'use client';
import React,{useEffect,useMemo,useState} from 'react';
import type {AccountProfile,Trade} from '../lib/types';
import type {RealizedDay} from '../lib/realized';
import {calendarAccountRows,type DayBalanceRead,type DayBalanceReport} from '../lib/calendar-accounts';
import {round} from '../lib/analytics';
import {accountDisplayName} from './account-selector';
import {dateLabel,money,num,PanelTitle,signed,signClass,timeLabel} from './ui';

export function CalendarAccounts({day,trades,realized,profiles,accountStages,symbolFilter,refreshKey,onAccount}:{day:string;trades:Trade[];realized:RealizedDay[];profiles:Map<string,AccountProfile>;accountStages:ReadonlyMap<string,string>;symbolFilter:string;refreshKey:string;onAccount:(account:string,day:string)=>void}){
 const rows=useMemo(()=>calendarAccountRows(trades,realized,day),[trades,realized,day]);
 const accountKey=JSON.stringify(rows.map(r=>r.account).sort()),key=day+'|'+accountKey;
 const [state,setState]=useState<{key:string;data?:DayBalanceReport;error?:string}>({key:''});
 useEffect(()=>{
  const accounts=JSON.parse(accountKey)as string[];
  if(!accounts.length){setState({key});return;}
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);let active=true;
  setState({key});
  (async()=>{try{
   const response=await fetch('/api/account-day-balances',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',signal:controller.signal,body:JSON.stringify({day,accounts})});
   const data=await response.json()as DayBalanceReport&{error?:string};
   if(!response.ok)throw new Error(data.error||'Balance history could not be loaded.');
   if(data.day!==day||!Array.isArray(data.accounts))throw new Error('Unexpected balance history response.');
   if(active)setState({key,data});
  }catch(error){if(active)setState({key,error:controller.signal.aborted?'Balance history timed out. Use Sync now to retry.':error instanceof Error?error.message:'Balance history could not be loaded.'});}
  finally{clearTimeout(timer);}})();
  return()=>{active=false;controller.abort();clearTimeout(timer);};
 },[day,accountKey,key,refreshKey]);
 if(!rows.length)return <section className="panel calendar-accounts-panel"><PanelTitle title="Accounts traded" sub={dateLabel(day)}/><p className="calendar-trade-note">No captured execution activity for this date and filter.</p></section>;
 const current=state.key===key?state:null,balances=new Map((current?.data?.accounts||[]).map(r=>[r.account,r]));
 const loading=!current?.data&&!current?.error,total=round(rows.reduce((sum,r)=>sum+r.gross,0)),netKnown=rows.every(r=>r.net!==null);
 const balance=(point:DayBalanceRead|null|undefined,empty:string)=>point?<><strong>{money(point.value)}</strong><small className="block muted">{timeLabel(point.at)} CT</small></>:<span className="muted">{loading?'Loading…':current?.error?'Unavailable':empty}</span>;
 return <section className="panel calendar-accounts-panel"><PanelTitle title="Accounts traded" sub={dateLabel(day)+' · '+num(rows.length)+' account'+(rows.length===1?'':'s')+' · daily trading results'}/>
  {current?.error&&<p className="calendar-trade-note warning-text" role="status">{current.error} Trade results are still shown.</p>}
  <div className="table-scroll"><table className="calendar-accounts-table"><thead><tr><th>Account</th><th className="right">Activity</th><th className="right">Gross P&L</th><th className="right">Net · model</th><th className="right">First balance read</th><th className="right">Last balance read</th></tr></thead><tbody>{rows.map(row=>{
   const saved=balances.get(row.account);
   return <tr key={row.account}><td><button className="text-button calendar-account-link" title={row.account} onClick={()=>onAccount(row.account,day)}>{accountDisplayName(row.account,profiles.get(row.account),accountStages.get(row.account))}</button><small className="block muted">{row.symbols.join(' · ')}{row.incomplete?' · History incomplete':''}</small></td>
    <td className="right">{num(row.completed)} {row.completed===1?'trade':'trades'}<small className="block muted">{num(row.exits)} {row.exits===1?'exit fill':'exit fills'}{!row.exits&&!row.completed?' · entry activity':''}</small></td>
    <td className={'right amount '+signClass(row.gross)}>{signed(row.gross)}{row.incomplete?'*':''}</td><td className={'right amount '+signClass(row.net??0)}>{row.net===null?'—':signed(row.net)}</td>
    <td className="right calendar-balance">{balance(saved?.first,'Not captured')}</td><td className="right calendar-balance">{balance(saved?.last,saved?.first?'One read only':'Not captured')}{saved?.change!==null&&saved?.change!==undefined&&<small className="block muted">Between reads {signed(saved.change)}</small>}</td></tr>;
  })}</tbody><tfoot><tr><td colSpan={2}><strong>Trading total</strong></td><td className={'right amount '+signClass(total)}>{signed(total)}</td><td className={'right amount '+signClass(netKnown?rows.reduce((s,r)=>s+r.net!,0):0)}>{netKnown?signed(round(rows.reduce((s,r)=>s+r.net!,0))):'—'}</td><td colSpan={2} className="right muted">Balances are per account</td></tr></tfoot></table></div>
  <p className="calendar-trade-note">Balances are the first and last fresh USD NinjaTrader cash reads captured on this Central-time date. They may start after trading began or end before the day finished; older dates may have no balance captures. Balance changes can include payouts and adjustments. {symbolFilter!=='all'?'Balances cover the whole account; trade results follow the instrument filter. ':''}Net uses scheduled fees where available; floating P&L is excluded. {current?.data&&<>Balance history checked {timeLabel(current.data.asOf)} CT.</>}</p>
 </section>;
}
