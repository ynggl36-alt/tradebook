'use client';
import React,{useEffect,useMemo,useState} from 'react';
import {ChevronRight,LoaderCircle,Plus,Save} from 'lucide-react';
import type {AccountProfile,CostRecord,Journal} from '../lib/types';
import type {BalanceAdjustment} from '../lib/balance-adjustments';
import {unrecordedPayouts} from '../lib/balance-adjustments';
import {cashLedgerRows,cashLedgerSummary} from '../lib/cash-ledger';
import type {CashLedgerRow} from '../lib/cash-ledger';
import {centralDay} from '../lib/analytics';
import {reportingRange} from '../lib/reporting-year';
import {accountDisplayName} from './account-selector';
import {api,dateLabel,Empty,money,num,PanelTitle,signed,signClass,Stat,timeLabel} from './ui';

type Classification='automatic'|'payout'|'firm-adjustment'|'unexplained'|'ignore';
const kindLabel=(kind:BalanceAdjustment['kind'])=>({'likely-payout':'Payout',payout:'Payout','firm-adjustment':'Firm adjustment',unexplained:'Unexplained',credit:'Credit',ignore:'Ignored'}[kind]);
const readAt=(stamp:string)=>dateLabel(centralDay(stamp),true)+' · '+timeLabel(stamp)+' CT';

export function CashView({journal,start,end,account,profiles,onEdit,onUpdated}:{journal:Journal;start:string;end:string;account:string;profiles:Map<string,AccountProfile>;onEdit:(r:CostRecord)=>void;onUpdated?:()=>Promise<unknown>}){
 const cash=useMemo(()=>journal.cash.filter(row=>row.date>=start&&row.date<=end&&(account==='all'||row.account===account)),[journal.cash,start,end,account]);
 const adjustments=useMemo(()=>(journal.adjustments||[]).filter(row=>row.date>=start&&row.date<=end&&(account==='all'||row.account===account)),[journal.adjustments,start,end,account]);
 const rows=useMemo(()=>cashLedgerRows(cash,adjustments),[cash,adjustments]),income=cashLedgerSummary(rows);
 const costs=cash.filter(row=>row.kind!=='payout'),knownCosts=costs.filter(row=>row.expense!==null),spent=knownCosts.reduce((total,row)=>total+Math.round(row.expense!*100),0)/100;
 // Let incoming uploads settle in the background before presenting either a
 // payout or a balance exception. A payout never needs a separate pending row.
 const payoutIds=new Set(unrecordedPayouts(adjustments).map(row=>row.id)),otherChanges=adjustments.filter(row=>row.settled&&!row.settlementOffsetId&&!payoutIds.has(row.id)&&!(row.kind==='payout'&&row.payoutId));
 const notices=(journal.firmAdjustments||[]).filter(notice=>notice.date>=start&&notice.date<=end&&(account==='all'||notice.accounts.includes(account)));
 const newRecord=(kind:CostRecord['kind'])=>onEdit({id:crypto.randomUUID(),kind,date:reportingRange('all',centralDay(new Date().toISOString())).end,account:account==='all'?'':account,deduction:null,received:null,expense:null,note:''});
 return <>
  <div className="cash-intro cash-view-intro"><div><strong>Payouts</strong><p>Full payout amounts, listed by date.</p></div><button className="button primary" onClick={()=>newRecord('evaluation')}><Plus size={16}/> Add cost</button></div>
  <div className="stats-grid cash-recorded-stats">
   <Stat label="Total payouts" value={money(income.gross)} detail={income.unknownAmounts?num(income.unknownAmounts)+' payouts have an unknown amount':income.count?num(income.count)+(income.count===1?' payout':' payouts'):'No payouts in this view'}/>
   <Stat label="Trading costs" value={money(knownCosts.length?spent:null)} detail={num(knownCosts.length)+' of '+num(costs.length)+' cost records have amounts'}/>
  </div>
  <section className="panel"><PanelTitle title="Payouts & costs" sub="Latest first"/>
   {!rows.length?<Empty title="No payouts or costs in this view">Payouts appear as deductions are recorded. Add evaluation, reset and activation costs with Add cost.</Empty>:<div className="table-scroll"><table className="recorded-cash-table"><thead><tr><th>Date</th><th>Type</th><th>Account / note</th><th className="right">Payout / cost</th><th/></tr></thead><tbody>
    {rows.map(row=><TransactionRow key={row.id} row={row} profiles={profiles} onEdit={onEdit}/>)}
   </tbody></table></div>}

  </section>
  {otherChanges.length>0&&<section className="panel"><PanelTitle title="Other balance changes" sub="Adjustments and unmatched changes · excluded from additional payout totals"/><div className="table-scroll"><table className="adjustments-table"><thead><tr><th>Date / account</th><th className="right">Balance adjustment</th><th className="right">Trading net · model</th><th>Classification</th></tr></thead><tbody>{otherChanges.map(row=><React.Fragment key={row.id}><tr><td>{dateLabel(row.date,true)}<strong className="account-text" title={row.account}>{accountDisplayName(row.account,profiles.get(row.account))}</strong></td><td className={'right amount '+signClass(row.amount??0)}>{row.amount===null?'—':signed(row.amount)}</td><td className="right amount">{row.tradingNet===null?'—':signed(row.tradingNet)}</td><td><span className={'adjustment-kind '+row.kind}>{kindLabel(row.kind)}</span>{(row.payoutId||row.possiblePayoutIds.length>0)&&<small className="block muted">Saved payout overlap</small>}</td></tr><tr className="adjustment-review-row"><td colSpan={4}><AdjustmentReview row={row} onUpdated={onUpdated}/></td></tr></React.Fragment>)}</tbody></table></div></section>}
  {notices.length>0&&<section className="panel firm-adjustment-notices"><PanelTitle title="Known Lucid adjustment notices" sub="Dated owner reports · exact debit amounts were not supplied"/>{notices.map(notice=><article key={notice.id}><div><strong>{dateLabel(notice.date)}</strong><span>Profit removal notice</span></div><b>Amount unknown</b><p>{notice.accounts.map(id=><span key={id} title={id}>{accountDisplayName(id,profiles.get(id))}</span>)}</p><small>{notice.source}</small></article>)}<p className="cash-source-note">These notices carry no debit amount and are excluded from payout totals.</p></section>}
 </>;
}

function TransactionRow({row,profiles,onEdit}:{row:CashLedgerRow;profiles:Map<string,AccountProfile>;onEdit:(row:CostRecord)=>void}){
 const cost=row.record&&row.record.kind!=='payout'?{...row.record,kind:row.record.kind}:null;
 const edit=()=>{if(cost)onEdit(cost);};
 return <tr data-transaction-kind={row.kind} className={cost?'editable-cost':undefined} tabIndex={cost?0:undefined} onClick={cost?edit:undefined} onKeyDown={cost?event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();edit();}}:undefined}>
  <td>{dateLabel(row.date,true)}</td><td><span className={'cash-kind '+(row.kind==='payout'?'payout':'')}>{row.kind}</span></td>
  <td><strong className="account-text" title={row.account||'Business expense'}>{row.account?accountDisplayName(row.account,profiles.get(row.account)):'Business expense'}</strong>{row.note&&<small className="block muted cash-record-note">{row.note}</small>}</td>
  <td className={'right amount '+(row.kind==='payout'?'positive':'negative')}>{row.amount===null?'—':row.kind==='payout'?money(row.amount):signed(row.amount)}</td><td>{cost&&<ChevronRight size={15}/>}</td>
 </tr>;
}

function AdjustmentReview({row,onUpdated,summary='Reasons & classification'}:{row:BalanceAdjustment;onUpdated?:()=>Promise<unknown>;summary?:string}){
 const initial:Classification=row.source==='owner'&&['payout','firm-adjustment','unexplained','ignore'].includes(row.kind)?row.kind as Classification:'automatic';
 const [kind,setKind]=useState<Classification>(initial),[note,setNote]=useState(row.note),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);
 useEffect(()=>{setKind(initial);setNote(row.note);setSaved(false);},[initial,row.note]);
 const save=async()=>{setBusy(true);setError('');setSaved(false);let written=false;try{await api('adjustment-label',{id:row.id,kind,note});written=true;await onUpdated?.();setSaved(true);}catch(cause){setError((written?'Classification saved. Sync now to refresh payouts. ':'')+(cause instanceof Error?cause.message:String(cause)));}finally{setBusy(false);}};
 return <details className="adjustment-review"><summary>{summary}<ChevronRight size={13}/></summary><div className="adjustment-review-body"><div className="adjustment-interval"><span>{readAt(row.from)} → {readAt(row.to)}</span><span>Balance {money(row.before)} → {money(row.after)}</span></div>{row.reasons.length>0?<ul>{row.reasons.map((reason,index)=><li key={reason+index}>{reason}</li>)}</ul>:<p>The balance change has been compared with saved trading results.</p>}{row.payoutId&&<p className="adjustment-match">Matched to a recorded payout. Its proceeds stay in the recorded total.</p>}{!row.payoutId&&row.possiblePayoutIds.length>0&&<p className="adjustment-match">May match a recorded payout. Excluded from additional payout estimates.</p>}<form className="adjustment-label-form" onSubmit={event=>{event.preventDefault();void save();}}><label>Classification<select value={kind} onChange={event=>{setKind(event.target.value as Classification);setSaved(false);}}><option value="automatic">Automatic classification</option><option value="payout">Payout</option><option value="firm-adjustment">Firm adjustment</option><option value="unexplained">Unexplained</option><option value="ignore">Ignore</option></select></label><label>Note<input value={note} maxLength={1000} onChange={event=>{setNote(event.target.value);setSaved(false);}} placeholder="Optional source or explanation"/></label><button className="button subtle small" disabled={busy}>{busy?<LoaderCircle size={13} className="spin"/>:<Save size={13}/>} Save classification</button></form>{error&&<p className="negative" role="alert">{error}</p>}{saved&&<p className="positive" role="status">{onUpdated?'Classification saved.':'Classification saved. Use Sync now to refresh payouts.'}</p>}</div></details>;
}
