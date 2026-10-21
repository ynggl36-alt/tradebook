'use client';
import React,{useEffect,useMemo,useState} from 'react';
import {ChevronRight,LoaderCircle,RefreshCw} from 'lucide-react';
import type {Trade} from '../lib/types';
import type {PriceBar} from '../lib/recorder';
import type {TrendEntriesResponse} from '../lib/server-trendline-entries';
import type {TrendEntry} from '../lib/trendlines';
import type {TrendJobResult} from '../lib/trendline-runner';
import {inTrendPilot,summarizeTrendEntries,TREND_BATCH,TREND_END_AT,TREND_MAX_ENTRIES,TREND_START_AT,TREND_VERSION} from '../lib/trendlines';
import {calculateTrends,loadTrendPrices} from './trendline-client';
import {useRecorder} from './recorder-connection';
import {accountDisplayName} from './account-selector';
import {centralDay} from '../lib/analytics';
import {dateLabel,Empty,money,num,PanelTitle,pct,signClass,timeLabel} from './ui';
const groupLabel={'body-only':'Body only','wick-only':'Wick only',both:'Both',neither:'Neither',unknown:'Unavailable'};
const point=(n:number)=>n.toLocaleString('en-US',{maximumFractionDigits:2});
type State={key:string;busy:boolean;message:string;checked:number;missing:number;warning:string;error:string;result:TrendJobResult|null};
export function TrendlinePilotPanel({trades,onTrade}:{trades:Trade[];onTrade:(trade:Trade,pnlMode?:'gross'|'net')=>void}){
  const {priceRevision}=useRecorder(),[refresh,setRefresh]=useState(0),[limit,setLimit]=useState(10);
  const eligible=useMemo(()=>trades.filter(t=>inTrendPilot(t.entry)&&/^(NQ|MNQ|ES|MES) 20\d{2}-(0[1-9]|1[0-2])$/.test(t.contract)).sort((a,b)=>Date.parse(b.entry)-Date.parse(a.entry)||a.id.localeCompare(b.id)),[trades]);
  const selected=eligible.slice(0,TREND_MAX_ENTRIES),key=JSON.stringify(selected.map(t=>[t.account,t.id,t.entry,t.exit,t.pnl,t.qty,t.maxQty,t.avgEntry,t.avgExit,t.contract,t.dir]));
  const [state,setState]=useState<State>({key:'',busy:false,message:'',checked:0,missing:0,warning:'',error:'',result:null});
  useEffect(()=>{
    const controller=new AbortController(),timer=setTimeout(()=>{void(async()=>{
      let missing=0,warning='';setLimit(10);setState({key,busy:true,message:'Reading actual first fills…',checked:0,missing,warning,error:'',result:null});
      try{
        const refs=(JSON.parse(key) as string[][]).map(([account,id])=>({account,id})),entries:TrendEntry[]=[];
        for(let offset=0;offset<refs.length;offset+=TREND_BATCH){
          const batch=new AbortController(),cancel=()=>batch.abort();controller.signal.addEventListener('abort',cancel,{once:true});const timeout=setTimeout(cancel,30000);
          try{
            const response=await fetch('/api/trendline-entries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({trades:refs.slice(offset,offset+TREND_BATCH)}),signal:batch.signal,cache:'no-store'}),data=await response.json() as TrendEntriesResponse&{error?:string};
            if(!response.ok)throw new Error(data.error||'First fills could not load.');if(data.version!==TREND_VERSION||!Array.isArray(data.rows)||!Array.isArray(data.missing))throw new Error('Refresh the page to load the current pilot.');
            entries.push(...data.rows);missing+=data.missing.length;
          }finally{clearTimeout(timeout);controller.signal.removeEventListener('abort',cancel);}
          if(controller.signal.aborted)return;
        }
        const prices:PriceBar[]=[];
        for(const contract of [...new Set(entries.map(e=>e.contract))]){
          setState(s=>({...s,message:'Reading '+contract+' candles…',missing}));
          const loaded=await loadTrendPrices(contract,TREND_START_AT-86400000,TREND_END_AT-60000,controller.signal);prices.push(...loaded.bars);warning=warning||loaded.warning;if(controller.signal.aborted)return;
        }
        setState(s=>({...s,message:'Comparing wick, body and mixed anchors…',warning}));
        const result=await calculateTrends({id:crypto.randomUUID(),entries,prices},controller.signal,(checked,total)=>{if(!controller.signal.aborted)setState(s=>({...s,checked,message:'Measuring entries · '+num(checked)+' / '+num(total)}));});
        if(!controller.signal.aborted)setState({key,busy:false,message:'',checked:entries.length,missing,warning,error:'',result});
      }catch(error){if(!controller.signal.aborted)setState(s=>({...s,busy:false,error:error instanceof Error?error.message:String(error)}));}
    })();},1500);
    return()=>{clearTimeout(timer);controller.abort();};
  },[key,priceRevision,refresh]);
  const current=state.key===key,busy=selected.length>0&&(!current||state.busy),result=current?state.result:null,rows=result?.rows??[];
  const measured=rows.filter(r=>r.status==='measured'),near=measured.filter(r=>r.confirmedNear>0),incomplete=rows.length-measured.length,capped=measured.filter(r=>r.snapshot.truncated).length;
  const groups=summarizeTrendEntries(rows),reaction=result?.reactions,tradeMap=new Map(selected.map(t=>[JSON.stringify([t.account,t.id]),t]));
  const ordered=[...rows].sort((a,b)=>Number(b.confirmedNear>0)-Number(a.confirmedNear>0)||Date.parse(b.entry)-Date.parse(a.entry));
  return <section className="panel trend-pilot" aria-busy={busy}>
    <PanelTitle title="Trendline lab" sub="Oct 7–20, 2026 · automatic retrospective pilot · 1m / 5m / 15m" action={<button className="button subtle small" disabled={busy||!selected.length} onClick={()=>setRefresh(n=>n+1)}>{busy?<LoaderCircle size={14} className="spin"/>:<RefreshCw size={14}/>} Refresh analysis</button>}/>
    {!selected.length?<Empty title="No pilot entries in this view">Choose dates and accounts containing completed trades from October 7–20. This first test is limited to those two weeks.</Empty>:<>
      <div className="gap-pilot-metrics"><div><strong>{result?num(measured.length):'—'}<small> / {num(selected.length)}</small></strong><span>Entries with pre-entry prices</span></div><div><strong>{result?num(near.length):'—'}</strong><span>Near a line with an independent touch</span></div><div><strong>{result?num(measured.filter(r=>r.group==='body-only').length):'—'}</strong><span>Body-only matches</span></div><div><strong>{result?num(incomplete):'—'}</strong><span>First fills or prices unavailable</span></div></div>
      {busy&&<p className="gap-pilot-note trend-progress" role="status"><LoaderCircle size={13} className="spin"/>{current?state.message:'Preparing the pilot…'} The calculation runs in the browser background.</p>}
      {current&&state.error&&<p className="error-box" role="alert">{state.error} Refresh analysis to retry; no partial performance totals are shown.</p>}
      {current&&state.warning&&<p className="gap-pilot-note">{state.warning}</p>}
      {eligible.length>selected.length&&<p className="gap-pilot-note">Limited to the newest {num(TREND_MAX_ENTRIES)} of {num(eligible.length)} eligible entries. Narrow the account filters to include the remainder.</p>}
      {current&&state.missing>0&&<p className="gap-pilot-note">{state.missing} references were absent or outside the canonical pilot. Refresh the journal to reconcile its current trades.</p>}
      {result&&<>
        <p className="gap-pilot-note">Each entry belongs to one body/wick group below. A match needs a pre-entry line with at least one separate touch after both anchors became confirmable; two-anchor candidates remain visible on the chart. Mixed-anchor matches are tracked separately: <b>{num(measured.filter(r=>r.mixed).length)}</b>. Proximity describes location, not your intended strategy.</p>
        <div className="table-scroll"><table><thead><tr><th>Near a confirmed candidate</th><th className="right">Trades</th><th className="right">Days</th><th className="right">Win rate · net model</th><th className="right">Avg net · model</th><th className="right">Total net · model</th></tr></thead><tbody>{groups.map(g=><tr key={g.group}><td><span className={'trend-swatch '+g.group}/>{groupLabel[g.group]}</td><td className="right">{num(g.count)}</td><td className="right">{g.days}</td><td className="right">{g.winRate===null?'—':pct(g.winRate)}</td><td className={'right '+(g.average===null?'muted':signClass(g.average))}>{g.average===null?'—':money(g.average)}</td><td className={'right '+(g.net===null?'muted':signClass(g.net))}>{g.net===null?'—':money(g.net)}</td></tr>)}</tbody></table></div>
        <p className="gap-pilot-note trend-after-table">Full completed trades after modeled commissions; excludes payouts and account costs. Missing fees leave the group’s net results unknown. Nearby lines do not establish which anchor method caused a win or loss. Multiple accounts and overlapping lines are not independent observations.</p>
        {reaction&&<details className="gap-pilot-method"><summary>Body versus wick · matched price-reaction replay <ChevronRight size={13}/></summary><p>Same anchor timestamps, same tolerance, same 12 following candles. A reaction requires a contact in the first nine candles, no closing breach throughout all 12, and a move away within the next three candles by the greater of one point and half the contact candle’s prior ATR. This replay is separate from the entry labels and trading P&amp;L. It samples candidate pairs encountered in these retrospective entry reconstructions; it is not a prospective strategy backtest.</p><div className="trend-reaction-grid"><div><strong>{num(reaction.complete)}</strong><span>Comparable pair observations</span></div><div><strong>{num(reaction.bodyOnly)}</strong><span>Body reacted; wick did not</span></div><div><strong>{num(reaction.wickOnly)}</strong><span>Wick reacted; body did not</span></div><div><strong>{num(reaction.both)}</strong><span>Both reacted</span></div></div><p>With at least one impulse anchor: {num(reaction.impulse.complete)} comparable pairs · body only {num(reaction.impulse.bodyOnly)} · wick only {num(reaction.impulse.wickOnly)} · both {num(reaction.impulse.both)} · neither {num(reaction.impulse.neither)}. Impulse means body ≥70% of candle range and true range ≥1.5× its prior 14-bar ATR. {num(reaction.baselineIneligible)} pairs failed the shared formation check; {num(reaction.incomplete)} lacked a full in-period observation window. Counts are unique pairs, with overlapping windows.</p></details>}
        <div className="gap-pilot-list-title"><strong>Inspect the reconstructed entries</strong><span>Matches first · newest entry first · open a row for its lines and executions</span></div>
        <div className="table-scroll"><table className="gap-context-table"><thead><tr><th>Entry · CT</th><th>Account / contract</th><th>Context</th><th className="right">Nearest selected line</th><th className="right">Net · model</th><th/></tr></thead><tbody>{ordered.slice(0,limit).map(row=>{
          const t=tradeMap.get(JSON.stringify([row.account,row.id]));
          return <tr key={JSON.stringify([row.account,row.id])} className={t?'clickable-row':''} onClick={()=>t&&onTrade(t,'net')}><td>{dateLabel(centralDay(row.entry))}<small>{timeLabel(row.entry)}</small></td><td>{accountDisplayName(row.account)}<small>{row.contract}</small></td><td className="gap-context-label">{row.status==='missing-entry-fill'?'First fill unavailable':row.status==='insufficient-prices'?'Pre-entry prices unavailable':groupLabel[row.group]+(row.mixed?' · mixed also':'')}{row.status==='measured'&&<small>{row.confirmedNear?row.confirmedNear+' confirmed nearby':row.candidateNear?row.candidateNear+' nearby · two anchors only':'No selected confirmed line nearby'}{row.impulse?' · impulse anchor':''}</small>}</td><td className="right">{row.nearest===null?'—':point(row.nearest)+' pts'}<small>{row.snapshot.tolerance===null?'':point(row.snapshot.tolerance)+' pt tolerance'}</small></td><td className={'right '+(row.net===null?'muted':signClass(row.net))}>{row.net===null?'—':money(row.net)}</td><td><ChevronRight size={13}/></td></tr>;
        })}</tbody></table></div>
        {ordered.length>limit&&<div className="trend-more"><button className="button subtle small" onClick={()=>setLimit(n=>n+20)}>Show 20 more entries</button></div>}
        <details className="gap-pilot-method"><summary>Method, coverage and limits <ChevronRight size={13}/></summary><p>{TREND_VERSION}. Uses the actual first allocated fill and only candles completed before its entry minute. Swing anchors require two candles on each side; impulse anchors are eligible after their candle closes. Backfilled candles establish mathematical confirmation, not proof the recorder had that information live. Impulse ATR excludes the impulse candle itself.</p><p>Only complete exact-contract 1m, 5m and 15m candles are used. Lines stay within continuous price sessions; market closures and missing minutes split the search. Daily and cross-session lines remain outside this version. A missing stream is not replaced with another contract’s prices.</p><p>Every shared pair receives wick/wick, body/body and both mixed versions. Close-based breaches and wick/body edge contacts use the same quarter-ATR / four-tick floor for every style. Adjacent contacts count as one episode. Geometry alone selects at most two lines per style; entry price, trade direction, exits and P&amp;L do not choose them. The entry minute and all later prices cannot change its classification.</p><p>{num(result.snapshots)} distinct contract/minute reconstructions · {num(result.families)} distinct shared anchor pairs encountered. Search is bounded to the last 720 complete bars in the current session, 28 anchor timestamps per side and 160 shared pairs per side/timeframe; {num(capped)} measured entries hit a search bound. This is a limited candidate search, not an exhaustive catalogue of visual trendlines. Results update when saved prices change; no automatic tags or accounting edits are written.</p></details>
      </>}
    </>}
  </section>;
}
