'use client';
import React,{useEffect,useMemo,useState} from 'react';
import {ChevronRight,LoaderCircle,RefreshCw} from 'lucide-react';
import type {Trade} from '../lib/types';
import type {GapContextReport} from '../lib/server-gap-context';
import {GAP_CONTEXT_BATCH,GAP_CONTEXT_LABELS,GAP_CONTEXT_SAMPLE,GAP_CONTEXT_VERSION,summarizeGapContexts} from '../lib/gap-context';
import type {GapEntryContext} from '../lib/gap-context';
import {centralDay} from '../lib/analytics';
import {accountDisplayName} from './account-selector';
import {useRecorder} from './recorder-connection';
import {dateLabel,Empty,money,num,PanelTitle,pct,signClass,timeLabel} from './ui';

const point=(value:number)=>value.toLocaleString('en-US',{maximumFractionDigits:3});
function contextLabel(row:GapEntryContext){
  if(row.status==='missing-entry-fill')return 'First fill unavailable';
  if(row.status==='insufficient-prices')return 'Pre-entry candles missing';
  if(row.status==='no-known-gaps')return row.unavailableWeeks?'Gap levels unavailable':'Observed weeks had no gap';
  return row.tags.length?row.tags.map(tag=>GAP_CONTEXT_LABELS[tag]).join(' · '):'No recorded match';
}
type PilotState={key:string;rows:GapEntryContext[];missing:number;checked:number;busy:boolean;error:string};
export function GapContextPanel({trades,onTrade,accountStages}:{trades:Trade[];onTrade:(trade:Trade,pnlMode?:'gross'|'net')=>void;accountStages?:ReadonlyMap<string,string>}){
  const {priceRevision}=useRecorder(),[refresh,setRefresh]=useState(0),[limit,setLimit]=useState(8);
  const selected=useMemo(()=>trades.filter(t=>/^(NQ|MNQ|ES|MES) 20\d{2}-(0[1-9]|1[0-2])$/.test(t.contract)&&Date.parse(t.entry)>=Date.UTC(2026,0,1)).sort((a,b)=>Date.parse(b.entry)-Date.parse(a.entry)||b.exitOrder-a.exitOrder||a.id.localeCompare(b.id)).slice(0,GAP_CONTEXT_SAMPLE),[trades]);
  // Stable across heartbeat-only journal refreshes; genuine trade corrections
  // and a completed price upload start a fresh calculation.
  const key=JSON.stringify(selected.map(t=>[t.account,t.id,t.entry,t.exit,t.qty,t.maxQty,t.avgEntry,t.pnl]));
  const [state,setState]=useState<PilotState>({key:'',rows:[],missing:0,checked:0,busy:false,error:''});
  useEffect(()=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>{void(async()=>{
      setState({key,rows:[],missing:0,checked:0,busy:true,error:''});setLimit(8);
      const refs=(JSON.parse(key) as string[][]).map(([account,id])=>({account,id}));
      const rows:GapEntryContext[]=[];let missing=0,checked=0;
      try{
        for(let offset=0;offset<refs.length;offset+=GAP_CONTEXT_BATCH){
          const chunk=refs.slice(offset,offset+GAP_CONTEXT_BATCH);
          const batchController=new AbortController(),cancel=()=>batchController.abort();
          controller.signal.addEventListener('abort',cancel,{once:true});
          const timeout=setTimeout(cancel,20000);
          let response:Response,data:GapContextReport&{error?:string};
          try{
            response=await fetch('/api/gap-context',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({trades:chunk}),cache:'no-store',signal:batchController.signal});
            data=await response.json() as GapContextReport&{error?:string};
          }catch(error){if(batchController.signal.aborted&&!controller.signal.aborted)throw new Error('The entry analysis timed out. Try refreshing it again.');throw error;}
          finally{clearTimeout(timeout);controller.signal.removeEventListener('abort',cancel);}
          if(!response.ok)throw new Error(data.error||'Entry context could not load.');
          if(data.version!==GAP_CONTEXT_VERSION||!Array.isArray(data.rows)||!Array.isArray(data.missing))throw new Error('Refresh the page to use the current entry analysis.');
          if(controller.signal.aborted)return;
          rows.push(...data.rows);missing+=data.missing.length;checked+=chunk.length;
          setState({key,rows:[...rows],missing,checked,busy:true,error:''});
        }
        if(!controller.signal.aborted)setState({key,rows,missing,checked,busy:false,error:''});
      }catch(error){if(!controller.signal.aborted)setState({key,rows,missing,checked,busy:false,error:error instanceof Error?error.message:String(error)});}
    })();},500);
    return()=>{clearTimeout(timer);controller.abort();};
  },[key,priceRevision,refresh]);

  const current=state.key===key,rows=current?state.rows:[],busy=!current||state.busy;
  const priced=rows.filter(r=>r.status==='measured'||r.status==='no-known-gaps').length;
  const measured=rows.filter(r=>r.status==='measured').length;
  const matches=rows.filter(r=>r.tags.length>0).length,incomplete=rows.filter(r=>r.unavailableWeeks>0).length;
  const groups=summarizeGapContexts(rows),tradeMap=new Map(selected.map(t=>[JSON.stringify([t.account,t.id]),t]));
  // Nearest first, normalized by recent range when available. Equal distances
  // retain newest first-entry order; this is an inspection list, not a ranking.
  const ordered=[...rows].sort((a,b)=>(a.nearest?.atrDistance??Infinity)-(b.nearest?.atrDistance??Infinity)||Date.parse(b.entry)-Date.parse(a.entry));
  return <section className="panel gap-pilot" aria-busy={busy}>
    <PanelTitle title="Automatic entry context" sub={'Weekly gaps · pilot · latest '+selected.length+' supported completed trades in this view'} action={<button className="button subtle small" disabled={busy||!selected.length} onClick={()=>setRefresh(n=>n+1)} title="Recalculate from saved trades and candles">{busy?<LoaderCircle size={14} className="spin"/>:<RefreshCw size={14}/>} Refresh analysis</button>}/>
    {!selected.length?<Empty title="No supported entries in this view">Choose completed NQ, MNQ, ES or MES trades. Weekly-gap measurements use each exact contract.</Empty>:<>
      <div className="gap-pilot-metrics" aria-live="polite">
        <div><strong>{current?state.checked:0}<small> / {selected.length}</small></strong><span>{busy?'Checking entries…':'Entries checked'}</span></div>
        <div><strong>{priced}</strong><span>With 20 pre-entry minutes</span></div>
        <div><strong>{matches}</strong><span>Near or inside a recorded gap</span></div>
        <div><strong>{incomplete}</strong><span>With missing weekly boundaries</span></div>
      </div>
      {current&&state.error&&<p className="error-box" role="alert">{state.error} Results below cover only {state.checked} checked entries. Use Refresh analysis to retry.</p>}
      {current&&state.missing>0&&<p className="gap-pilot-note">{state.missing} trade reference{state.missing===1?' was':'s were'} no longer present. Refresh the journal to load its current trades.</p>}
      {rows.length>0&&<>
        <p className="gap-pilot-note">{matches?'These are measured entry locations, with overlapping descriptions.':measured?'None of the '+measured+' measured entries met the proximity rules among the available gap levels.':'No entry can yet be compared with recorded weekly-gap levels.'} {rows.length>measured?num(rows.length-measured)+' entries could not be measured. ':''}{incomplete>0?'Missing weeks mean other gap setups remain unclassified.':'Only gap weeks in the last 35 calendar days are checked.'} Open a row to inspect the executions on its chart.</p>
        {matches>0&&<div className="table-scroll"><table><thead><tr><th>First-entry location</th><th className="right">Trades</th><th className="right">Days</th><th className="right">Win rate · net model</th><th className="right">Avg net · model</th><th className="right">Total net · model</th></tr></thead><tbody>{groups.filter(g=>g.count>0).map(g=><tr key={g.id}><td><strong>{g.label}</strong>{g.netUnknown>0&&<small className="block muted">{g.netUnknown} with unknown commissions</small>}</td><td className="right">{g.count}</td><td className="right">{g.days}</td><td className="right">{g.winRate===null?'—':pct(g.winRate)}</td><td className={'right '+signClass(g.average??0)}>{money(g.average)}</td><td className={'right amount '+signClass(g.net??0)}>{money(g.net)}</td></tr>)}</tbody></table></div>}
        <div className="gap-pilot-list-title"><strong>Entries to inspect</strong><span>Closest recorded levels first · distance in recent range units</span></div>
        <div className="table-scroll"><table className="gap-context-table"><thead><tr><th>Contract / account</th><th>First entry <small>CT</small></th><th>Recorded context</th><th>Nearest recorded level</th><th className="right">Distance</th><th className="right">Weeks available</th><th className="right">Net · model</th><th/></tr></thead><tbody>{ordered.slice(0,limit).map(row=>{
          const trade=tradeMap.get(JSON.stringify([row.account,row.id]));
          return <tr key={row.account+'|'+row.id} tabIndex={trade?0:undefined} onClick={()=>{if(trade)onTrade(trade,'net');}} onKeyDown={e=>{if(trade&&(e.key==='Enter'||e.key===' ')){e.preventDefault();onTrade(trade,'net');}}}>
            <td><strong>{row.contract}</strong><span className={'direction '+trade?.dir.toLowerCase()}>{trade?.dir}</span><small className="block account-text" title={row.account}>{accountDisplayName(row.account,undefined,accountStages?.get(row.account))}</small></td>
            <td>{dateLabel(centralDay(row.entry),true)}<small className="block muted">{timeLabel(row.entry)}</small><small className="block muted">{row.entryPrice===null?'Unknown first price':point(row.entryPrice)}</small></td>
            <td className="gap-context-label">{contextLabel(row)}</td>
            <td>{row.nearest?point(row.nearest.price):'—'}{row.nearest&&<small className="block muted">{dateLabel(row.nearest.sunday,true)} · {row.nearest.kind}</small>}</td>
            <td className="right">{row.nearest?point(row.nearest.distance)+' pts':'—'}{row.nearest?.atrDistance!==null&&row.nearest&&<small className="block muted">{row.nearest.atrDistance.toFixed(2)} × ATR</small>}{row.tolerance!==null&&<small className="block muted">Near ≤ {point(row.tolerance)} pts</small>}</td>
            <td className="right" title={row.noGapWeeks+' observed weeks had no opening gap'}>{row.checkedWeeks-row.unavailableWeeks} / {row.checkedWeeks}<small className="block muted">{row.unavailableWeeks?'Incomplete':'Boundary pairs'}</small></td>
            <td className={'right amount '+signClass(row.net??0)}>{money(row.net)}</td><td>{trade&&<ChevronRight size={15} aria-label="Open trade chart"/>}</td>
          </tr>;
        })}</tbody></table></div>
        {rows.length>limit&&<div className="entry-review-more"><button className="button subtle small" onClick={()=>setLimit(n=>n+12)}>Show more entries</button></div>}
      </>}
      <details className="gap-pilot-method"><summary>What this pilot measures<ChevronRight size={13}/></summary><p>The actual first allocated fill is compared with exact-contract Friday-close / Sunday-reopen gaps from the preceding 35 calendar days. Partial and full price traversals do not delete a historical zone. Older gaps and trendlines are not checked.</p><p>“Near” means no farther than the greater of four ticks (1 point) and one-quarter of the mean true range of the last 14 completed one-minute candles. Twenty consecutive minutes before entry are required. The entry minute and all later candles are excluded. The threshold is provisional.</p><p>Descriptions can overlap and do not identify a bounce or your intended strategy. A missing weekly boundary stays unknown. Dollar results describe the whole completed trade, including scaling, after estimated commissions; missing commission rates leave net results unknown. Account sizes, position sizes and instrument mix affect comparisons. This limited recent sample is not a full-period performance total.</p><p>Uses uploaded candles and refreshes when this device uploads more. Refresh analysis rereads saved data; it does not request prices from NinjaTrader.</p></details>
    </>}
  </section>;
}
