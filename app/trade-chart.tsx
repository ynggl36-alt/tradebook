'use client';
import React,{useEffect,useId,useMemo,useRef,useState} from 'react';
import {ChevronRight,Download,FolderOpen,LoaderCircle} from 'lucide-react';
import type {Fill,Trade} from '../lib/types';
import type {PriceBar} from '../lib/recorder';
import {aggregateBars,executionMarkers,markerCoverage} from '../lib/recorder';
import {readPriceBars,readWeeklyGapBars} from '../lib/recorder-browser';
import {mergePriceBars} from '../lib/price-history';
import {weeklyBoundaries,weeklyGapContext} from '../lib/weekly-gaps';
import {parseTimestamp} from '../lib/csv';
import {centralDay} from '../lib/analytics';
import {useRecorder} from './recorder-connection';
import {firstEntryFill} from '../lib/gap-context';
import {inTrendPilot,trendValueAt} from '../lib/trendlines';
import type {TrendSnapshot} from '../lib/trendlines';
import {calculateTrends,loadTrendPrices} from './trendline-client';
import {dateLabel,num,PanelTitle,signed,timeLabel} from './ui';

type WindowKind='trade'|'day'|'week';
const options=[{id:'trade',label:'1m · Trade',minutes:1},{id:'day',label:'5m · Day',minutes:5},{id:'week',label:'15m · Week',minutes:15}] as const;
const price=(n:number)=>n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const gapPrice=(n:number)=>n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:3});
const axisTime=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const axisDay=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function chartRange(trade:Trade,kind:WindowKind){
  const entry=Date.parse(trade.entry),exit=Date.parse(trade.exit);
  if(kind==='week')return {start:entry-7*86400000,end:exit+15*60000};
  if(kind==='day'){
    const day=centralDay(trade.entry),next=new Date(Date.parse(day+'T12:00:00Z')+86400000).toISOString().slice(0,10);
    return {start:Date.parse(parseTimestamp(day+' 00:00:00','America/Chicago'))-60000,end:Math.max(Date.parse(parseTimestamp(next+' 00:00:00','America/Chicago')),exit+15*60000)};
  }
  return {start:Math.floor(entry/60000)*60000-15*60000,end:Math.ceil(exit/60000)*60000+15*60000};
}

export function TradePriceChart({trade,fills,loading,onConnect}:{trade:Trade;fills:Fill[];loading:boolean;onConnect:()=>void}){
  const recorder=useRecorder(),[kind,setKind]=useState<WindowKind>('trade'),[raw,setRaw]=useState<PriceBar[]>([]),[reading,setReading]=useState(true),[error,setError]=useState(''),[hover,setHover]=useState<number|null>(null),[saving,setSaving]=useState(false);
  const [gapSource,setGapSource]=useState<PriceBar[]>([]),[gapLoading,setGapLoading]=useState(true),[gapError,setGapError]=useState(''),[showGaps,setShowGaps]=useState(true);
  const [trend,setTrend]=useState<TrendSnapshot|null>(null),[trendLoading,setTrendLoading]=useState(false),[trendError,setTrendError]=useState(''),[showTrends,setShowTrends]=useState(true),[highlight,setHighlight]=useState<string|null>(null);
  const pilot=inTrendPilot(trade.entry),firstFill=firstEntryFill(trade,fills);
  const plotId='price-plot-'+useId().replace(/[^a-z0-9]/gi,'');
  const svg=useRef<SVGSVGElement>(null);
  const range=useMemo(()=>chartRange(trade,kind),[trade.entry,trade.exit,kind]);
  const gapAsOf=Date.parse(trade.entry);
  const gapContext=useMemo(()=>weeklyGapContext(trade.contract,gapAsOf,gapSource),[trade.contract,gapAsOf,gapSource]);
  useEffect(()=>{
    const controller=new AbortController();setTrend(null);setHighlight(null);setTrendError('');
    if(!pilot||loading){setTrendLoading(false);return()=>controller.abort();}
    setTrendLoading(true);
    const timer=setTimeout(()=>{void(async()=>{
      try{
        const end=Math.floor(gapAsOf/60000)*60000,loaded=await loadTrendPrices(trade.contract,end-2*86400000,end-60000,controller.signal);
        const result=await calculateTrends({id:JSON.stringify([trade.account,trade.id,gapAsOf]),entries:[{id:trade.id,account:trade.account,contract:trade.contract,entry:trade.entry,entryPrice:firstFill?.price??null,gross:trade.pnl,net:null}],prices:loaded.bars,chart:true},controller.signal);
        if(!controller.signal.aborted){setTrend(result.chart??null);setTrendError(loaded.warning);setTrendLoading(false);}
      }catch(error){if(!controller.signal.aborted){setTrendError(error instanceof Error?error.message:String(error));setTrendLoading(false);}}
    })();},600);
    return()=>{clearTimeout(timer);controller.abort();};
    // Geometry is independent of outcomes, direction and later fill details.
  },[trade.account,trade.id,trade.contract,gapAsOf,pilot,loading,firstFill?.price,recorder.priceRevision]);
  useEffect(()=>{
    let cancelled=false,controller:AbortController;
    const load=async()=>{
      controller=new AbortController();setGapLoading(true);setGapError('');
      const timeout=setTimeout(()=>controller.abort(),20000);
      const [local,cloud]=await Promise.allSettled([
        readWeeklyGapBars(trade.contract,gapAsOf),
        (async()=>{const params=new URLSearchParams({contract:trade.contract,asOf:String(gapAsOf)}),response=await fetch('/api/weekly-gap-bars?'+params,{cache:'no-store',signal:controller.signal}),data=await response.json() as {bars:PriceBar[];error?:string};if(!response.ok)throw new Error(data.error||'Weekly-gap history could not load.');return data.bars;})(),
      ]);
      clearTimeout(timeout);if(cancelled)return;
      setGapSource(mergePriceBars(cloud.status==='fulfilled'?cloud.value:[],local.status==='fulfilled'?local.value:[]));
      setGapError(cloud.status==='rejected'?'Cloud gap boundaries could not load; using any saved device data.':'');setGapLoading(false);
    };
    void load();const timer=setInterval(()=>{if(document.visibilityState==='visible')void load();},60000);
    return()=>{cancelled=true;controller?.abort();clearInterval(timer);};
  },[trade.contract,gapAsOf,recorder.revision,recorder.priceRevision]);
  useEffect(()=>{
    let cancelled=false,controller:AbortController;
    const load=async()=>{
      controller=new AbortController();setReading(true);setError('');setHover(null);
      const timeout=setTimeout(()=>controller.abort(),20000);
      const [local,cloud]=await Promise.allSettled([
        readPriceBars(trade.contract,range.start,range.end),
        (async()=>{const params=new URLSearchParams({contract:trade.contract,start:String(range.start),end:String(range.end)}),response=await fetch('/api/prices?'+params,{cache:'no-store',signal:controller.signal}),data=await response.json() as {bars:PriceBar[];error?:string};if(!response.ok)throw new Error(data.error||'Cloud price history could not load.');return data.bars;})(),
      ]);
      clearTimeout(timeout);if(cancelled)return;
      setRaw(mergePriceBars(cloud.status==='fulfilled'?cloud.value:[],local.status==='fulfilled'?local.value:[]));
      setError(cloud.status==='rejected'?'Cloud price history could not load. Showing available local candles; it will retry.':local.status==='rejected'?'Device storage is unavailable. Showing cloud candles.':'');setReading(false);
    };
    void load();const timer=setInterval(()=>{if(document.visibilityState==='visible')void load();},60000);
    return()=>{cancelled=true;controller?.abort();clearInterval(timer);};
  },[trade.contract,range.start,range.end,recorder.revision,recorder.priceRevision]);
  const minutes=options.find(o=>o.id===kind)!.minutes;
  const bars=useMemo(()=>aggregateBars(raw,minutes),[raw,minutes]);
  const markers=useMemo(()=>executionMarkers(trade,fills),[trade,fills]);
  const coverage=useMemo(()=>markerCoverage(markers,raw),[markers,raw]);
  const unmatched=Math.max(0,(trade.parts?.length||0)-markers.length);
  const saveChart=async()=>{
    if(!svg.current)return;setSaving(true);setError('');let url='';
    try{
      const clone=svg.current.cloneNode(true) as SVGSVGElement;
      // Standalone SVG images do not inherit the page's theme variables.
      // Freeze resolved colors and fonts before serializing the chart to PNG.
      const originals=[svg.current,...svg.current.querySelectorAll('*')],copies=[clone,...clone.querySelectorAll('*')];
      originals.forEach((node,index)=>{const computed=getComputedStyle(node),copy=copies[index] as SVGElement;for(const property of ['fill','stroke','color','stop-color','font-family','font-size','font-weight'])copy.style.setProperty(property,computed.getPropertyValue(property));});
      clone.querySelectorAll('[data-interactive]').forEach(e=>e.remove());
      clone.setAttribute('xmlns','http://www.w3.org/2000/svg');clone.setAttribute('width','1920');clone.setAttribute('height','900');
      url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)],{type:'image/svg+xml;charset=utf-8'}));
      const image=new Image();await new Promise<void>((resolve,reject)=>{image.onload=()=>resolve();image.onerror=()=>reject(new Error('The chart image could not be created.'));image.src=url;});
      const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=900;const ctx=canvas.getContext('2d');if(!ctx)throw new Error('Image export is unavailable in this browser.');ctx.drawImage(image,0,0,1920,900);
      const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('The chart could not be saved.')),'image/png'));
      const downloadUrl=URL.createObjectURL(blob),link=document.createElement('a');link.href=downloadUrl;link.download='Tradebook-'+trade.contract.replace(/[^a-z0-9-]/gi,'_')+'-'+centralDay(trade.entry)+'-'+trade.id.slice(0,8)+'.png';link.click();setTimeout(()=>URL.revokeObjectURL(downloadUrl),10000);
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{if(url)URL.revokeObjectURL(url);setSaving(false);}
  };
  const chartControls=<div className="price-controls"><div className="segmented">{options.map(o=><button key={o.id} className={kind===o.id?'selected':''} onClick={()=>setKind(o.id)}>{o.label}</button>)}</div><button className="button subtle small" aria-pressed={showGaps} onClick={()=>setShowGaps(v=>!v)}>Weekly gaps {showGaps?'on':'off'}</button>{pilot&&<button className="button subtle small" aria-pressed={showTrends} onClick={()=>setShowTrends(v=>!v)}>Trendlines {showTrends?'on':'off'}</button>}{bars.length>0&&<button className="icon-btn" title="Save chart as PNG" aria-label="Save chart as PNG" disabled={saving||loading||reading||gapLoading||trendLoading} onClick={()=>void saveChart()}>{saving?<LoaderCircle size={16} className="spin"/>:<Download size={16}/>}</button>}</div>;
  if(!bars.length){
    const hasSource=!!recorder.folder||recorder.summary.barCount>0,permission=recorder.phase==='permission';
    const status=reading?'Checking saved candles…':error?'Price history needs attention':'Not yet archived for this trade';
    return <details className="inner-panel price-panel price-empty-panel"><summary><span>Price history</span><small>{status}</small><ChevronRight size={14}/></summary><PanelTitle title="Recorded price history" sub={trade.contract+' · exact-contract candles'} action={chartControls}/><div className="price-empty">{reading?<><LoaderCircle size={23} className="spin"/><strong>Reading saved candles…</strong></>:<><FolderOpen size={27}/><strong>{permission?'Allow folder access to read price history':hasSource?'Price history was not recorded for this trade':'Connect your recorder for price history'}</strong><p>{permission?'Resume folder access in Settings to read saved candles.':hasSource?'This capture has no '+trade.contract+' candles around '+dateLabel(centralDay(trade.entry),true)+'. Try a wider window or add a capture containing those prices.':'Connect the recorder folder in Settings or import a saved snapshot containing price history.'}</p><button className="button subtle small" onClick={onConnect}>{hasSource?'Price history settings':'Connect recorder'}</button></>}{error&&<p className="negative" role="alert">{error}</p>}</div></details>;
  }

  const width=960,height=450,left=28,right=870,top=76,bottom=365;
  const first=Math.min(bars[0].start,Date.parse(trade.entry),...markers.map(m=>m.time));
  const last=Math.max(bars.at(-1)!.end,Date.parse(trade.exit)+60000,...markers.map(m=>m.time+60000));
  const span=Math.max(last-first,60000),pad=span*.02;
  const low=Math.min(...bars.map(b=>b.low),...markers.map(m=>m.price)),high=Math.max(...bars.map(b=>b.high),...markers.map(m=>m.price));
  const pricePad=Math.max((high-low)*.13,1),lo=low-Math.max((high-low)*.24,2),hi=high+pricePad;
  const x=(time:number)=>left+(time-first+pad)/(span+pad*2)*(right-left);
  const y=(value:number)=>bottom-(value-lo)/(hi-lo)*(bottom-top);
  const candleWidth=Math.max(1,Math.min(11,(right-left)/(span/(minutes*60000)+2)*.65));
  const active=hover===null?null:bars[hover];
  const visibleGaps=gapContext.gaps.filter(g=>g.high>=lo&&g.low<=hi&&g.sundayOpenAt<=bars.at(-1)!.end);
  const weekends=weeklyBoundaries(last+60000).filter(g=>g.fridayCloseAt>=first&&g.sundayOpenAt<=last);
  const trendColor={wick:'#588fff',body:'#d4a03c',mixed:'#a880ed'};
  const selectedLines=(trend?.lines??[]).filter((line,index,all)=>all.findIndex(other=>Math.abs(other.value-line.value)<1e-7&&Math.abs(other.slope-line.slope)<1e-12)===index);
  return <section className="inner-panel price-panel"><PanelTitle title="Price history" sub="Actual fills on recorded prices · Central time" action={chartControls}/><div className="price-chart-scroll"><svg ref={svg} className="price-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={trade.contract+' candles with '+markers.length+' actual execution markers'} fontFamily="Inter,Segoe UI,Arial,sans-serif" onPointerLeave={()=>setHover(null)}>
    <title>{trade.contract} {trade.dir} · {dateLabel(centralDay(trade.entry))} · {signed(trade.pnl)} gross</title><desc>{minutes}-minute candles. Buy markers are green upward triangles; sell markers are red downward triangles. E identifies an entry, X an exit. The shaded band shows time in the trade. Grey weekly-gap zones span recorded Friday closes and Sunday opens, with dashed midpoints, and persist after fills. Empty weekend time is not a price path. Missing price data is not filled in. Automatic trendlines use only pre-entry completed prices. Blue uses wick anchors, amber body anchors and purple mixed anchors; dashed portions precede confirmation and dotted portions after entry are untested projections.</desc>
    <defs><clipPath id={plotId}><rect x={left} y={top} width={right-left} height={bottom-top}/></clipPath></defs>
    <rect width={width} height={height} fill="var(--surface)"/><text x={left} y="26" fontSize="15" fontWeight="600" fill="var(--ink)">{trade.contract} · {trade.dir} · {minutes}m</text><text x={left} y="47" fontSize="10" fill="var(--chart-axis)">{trade.account} · {dateLabel(centralDay(trade.entry),true)}, 2026 · {signed(trade.pnl)} gross</text><text x={width-24} y="26" textAnchor="end" fontSize="12" fontWeight="600" fill="var(--chart-up)">tradebook.</text><text x={width-24} y="47" textAnchor="end" fontSize="10" fill="var(--chart-axis)">NinjaTrader · exact contract · CT</text>
    <rect x={x(Date.parse(trade.entry))} y={top} width={Math.max(2,x(Date.parse(trade.exit))-x(Date.parse(trade.entry)))} height={bottom-top} fill="var(--chart-band)"/>
    {showGaps&&<g clipPath={'url(#'+plotId+')'}>{visibleGaps.map(g=>{
      const begin=x(Math.max(first,g.sundayOpenAt)),finish=x(bars.at(-1)!.end),upper=y(g.high),lower=y(g.low);
      return <g key={g.id}><title>{'Weekly opening gap · '+dateLabel(g.sunday,true)+' · Friday close '+gapPrice(g.fridayClose)+' / Sunday open '+gapPrice(g.sundayOpen)+' · midpoint '+gapPrice(g.midpoint)}</title><rect x={begin} y={upper} width={Math.max(0,finish-begin)} height={Math.max(.6,lower-upper)} fill="var(--chart-gap-fill)" stroke="var(--chart-gap-edge)" strokeWidth=".7"/><line x1={begin} x2={finish} y1={y(g.midpoint)} y2={y(g.midpoint)} stroke="var(--chart-gap-edge)" strokeWidth=".8" strokeDasharray="4 4"/><text x={begin+5} y={Math.max(top+10,upper+11)} fontSize="8" fill="var(--chart-gap-label)">{'WOG '+dateLabel(g.sunday)}</text></g>;
    })}</g>}
    {Array.from({length:6},(_,i)=>{const value=lo+(hi-lo)*i/5;return <g key={i}><line x1={left} x2={right} y1={y(value)} y2={y(value)} stroke="var(--chart-grid)" strokeDasharray="3 4"/><text x={right+12} y={y(value)+3} fontSize="10" fill="var(--chart-axis)">{price(value)}</text></g>;})}
    {bars.map(b=>{const cx=x(b.start+Math.min(minutes*60000,b.end-b.start)/2),up=b.close>=b.open,color=up?'var(--chart-up)':'var(--chart-down)';return <g key={b.id}><title>{timeLabel(new Date(b.start).toISOString())+' CT · O '+price(b.open)+' H '+price(b.high)+' L '+price(b.low)+' C '+price(b.close)+' · volume '+num(b.volume)}</title><line x1={cx} x2={cx} y1={y(b.high)} y2={y(b.low)} stroke={color} strokeWidth="1"/><rect x={cx-candleWidth/2} y={Math.min(y(b.open),y(b.close))} width={candleWidth} height={Math.max(1,Math.abs(y(b.open)-y(b.close)))} fill={color}/></g>;})}
    {showTrends&&<g clipPath={'url(#'+plotId+')'}>{selectedLines.map(line=>{
      const color=trendColor[line.style],begin=Math.max(first,line.a.time),finish=Math.min(last,gapAsOf+12*line.minutes*60000),confirmed=Math.max(begin,line.availableAt),entry=Math.max(begin,Math.min(gapAsOf,finish)),opacity=highlight&&highlight!==line.id ? .25 : .9;
      const path=(a:number,b:number,dash?:string,alpha=1)=>b>a?<line x1={x(a)} x2={x(b)} y1={y(trendValueAt(line,a))} y2={y(trendValueAt(line,b))} stroke={color} strokeWidth={highlight===line.id?2:1.4} strokeDasharray={dash} opacity={opacity*alpha}/>:null;
      return <g key={line.id}><title>{line.minutes+'m '+line.polarity+' · '+line.a.edge+' / '+line.b.edge+' · '+line.touches+' independent touches before entry · confirmable '+timeLabel(new Date(line.availableAt).toISOString())+' CT'}</title>{path(begin,Math.min(confirmed,finish),'5 4',.6)}{path(confirmed,entry)}{path(entry,finish,'2 4',.55)}{[line.a,line.b].map((a,i)=><circle key={i} cx={x(a.time)} cy={y(a.price)} r={3} fill="var(--surface)" stroke={color} strokeWidth="1.5" opacity={opacity}/>)}</g>;
    })}</g>}
    {weekends.map(g=><g key={'closed-'+g.sunday}><title>{'Closed weekend · Friday '+timeLabel(new Date(g.fridayCloseAt).toISOString())+' to Sunday '+timeLabel(new Date(g.sundayOpenAt).toISOString())+' CT. No price path is drawn.'}</title><line x1={x(g.fridayCloseAt)} x2={x(g.fridayCloseAt)} y1={top} y2={bottom} stroke="var(--chart-gap-edge)" strokeDasharray="2 5"/><line x1={x(g.sundayOpenAt)} x2={x(g.sundayOpenAt)} y1={top} y2={bottom} stroke="var(--chart-gap-edge)" strokeDasharray="2 5"/><text x={(x(g.fridayCloseAt)+x(g.sundayOpenAt))/2} y={bottom-9} textAnchor="middle" fontSize="9" fill="var(--chart-gap-label)">Weekend closed</text></g>)}
    {Array.from({length:6},(_,i)=>{const time=first+span*i/5;return <g key={i}><line x1={x(time)} x2={x(time)} y1={bottom} y2={bottom+4} stroke="var(--chart-reference)"/><text x={x(time)} y={bottom+21} textAnchor={i===0?'start':i===5?'end':'middle'} fontSize="10" fill="var(--chart-axis)">{(kind==='week'?axisDay:axisTime).format(new Date(time))}</text></g>;})}
    <rect x={left} y={top} width={right-left} height={bottom-top} fill="transparent" onPointerMove={event=>{const box=event.currentTarget.ownerSVGElement!.getBoundingClientRect(),px=(event.clientX-box.left)/box.width*width;let best=0,delta=Infinity;bars.forEach((b,i)=>{const distance=Math.abs(x(b.start+minutes*30000)-px);if(distance<delta){delta=distance;best=i;}});setHover(best);}}/>
    {markers.map((m,i)=>{const cx=x(m.time),cy=y(m.price),buy=m.side==='Buy',color=buy?'var(--chart-up)':'var(--chart-down)',labelY=Math.max(top+12,Math.min(bottom-10,cy+(buy?1:-1)*(24+(i%3)*13)));return <g key={m.id} tabIndex={0} aria-label={m.role+' '+m.side+' '+m.qty+' at '+price(m.price)+' at '+timeLabel(new Date(m.time).toISOString())+' Central time'}><title>{m.role+' · '+m.side+' '+m.qty+' @ '+price(m.price)+' · '+timeLabel(new Date(m.time).toISOString())+' CT'}</title><line x1={cx} x2={cx} y1={cy} y2={labelY} stroke={color} strokeWidth=".8" strokeDasharray="2 2"/><circle cx={cx} cy={cy} r="3" fill={color} stroke="var(--surface)" strokeWidth="1"/><path d={buy?`M ${cx} ${labelY-9} l -4 7 h 8 Z`:`M ${cx} ${labelY+3} l -4 -7 h 8 Z`} fill={color}/><text x={Math.min(right-20,Math.max(left+4,cx+6))} y={labelY+3} fontSize="10" fontWeight="600" fill={color}>{m.role==='Entry'?'E':'X'}{i+1} · {m.qty}</text></g>;})}
    {active&&<g data-interactive="true" pointerEvents="none"><line x1={x(active.start+minutes*30000)} x2={x(active.start+minutes*30000)} y1={top} y2={bottom} stroke="var(--chart-reference)" strokeDasharray="3 3"/><rect x={left} y="55" width="620" height="17" rx="3" fill="var(--surface-soft)"/><text x={left+6} y="67" fontSize="10" fill="var(--text-secondary)">{timeLabel(new Date(active.start).toISOString())} CT · O {price(active.open)} · H {price(active.high)} · L {price(active.low)} · C {price(active.close)} · V {num(active.volume)}</text></g>}
    <text x={left} y="414" fontSize="10" fill="var(--chart-up)">▲ Buy</text><text x={left+65} y="414" fontSize="10" fill="var(--chart-down)">▼ Sell</text><rect x={left+136} y="406" width="12" height="10" fill="var(--chart-band)"/><text x={left+154} y="414" fontSize="10" fill="var(--chart-axis)">Time in trade · E entry / X exit</text>{showGaps&&<g><rect x={left+345} y="406" width="12" height="10" fill="var(--chart-gap-fill)" stroke="var(--chart-gap-edge)"/><text x={left+363} y="414" fontSize="10" fill="var(--chart-axis)">Weekly gap · dashed midpoint</text></g>}<g>{showTrends&&pilot&&<text x="650" y="414" fontSize="9"><tspan fill="#588fff">Wick</tspan><tspan dx="15" fill="#d4a03c">Body</tspan><tspan dx="15" fill="#a880ed">Mixed</tspan></text>}</g><text x={left} y="435" fontSize="10" fill="var(--chart-axis)">{num(raw.length)} observed 1m candles · {coverage.covered}/{coverage.total} fills have a matching 1m candle · no invented prices</text>
  </svg></div>
  <div className="price-caption"><span>{reading||loading?<><LoaderCircle size={12} className="spin"/> {reading?'Updating candles…':'Loading actual fills…'}</>:coverage.total?coverage.covered+' / '+coverage.total+' fills matched to a candle':'Execution details unavailable'}</span><span>{dateLabel(centralDay(new Date(raw[0].start).toISOString()),true)} {timeLabel(new Date(raw[0].start).toISOString())} – {dateLabel(centralDay(new Date(raw.at(-1)!.end).toISOString()),true)} {timeLabel(new Date(raw.at(-1)!.end).toISOString())} CT</span></div>
  {!loading&&(coverage.missing>0||coverage.outside>0||unmatched>0)&&<div className="notice price-notice">{coverage.missing>0&&<p>{coverage.missing} fill{coverage.missing===1?' has':'s have'} no completed candle yet. A final minute may still be forming or absent from the capture.</p>}{coverage.outside>0&&<p>{coverage.outside} fill price{coverage.outside===1?' is':'s are'} outside the recorded minute’s range. Review the source before classifying the setup.</p>}{unmatched>0&&<p>{unmatched} allocated execution{unmatched===1?' has':'s have'} no matching fill detail and cannot be placed.</p>}</div>}
  {error&&<div className="error-box" role="alert">{error}</div>}
  {pilot&&<div className="trend-chart-summary"><div className="trend-chart-heading"><strong>Automatic trendline candidates</strong>{trendLoading?<><LoaderCircle size={12} className="spin"/> Reconstructing pre-entry lines…</>:trend?.status==='insufficient-prices'?'20 consecutive pre-entry minutes are unavailable.':trend?selectedLines.length+' displayed paths · body / wick / mixed tested equally':'Not yet measured'}</div>{trendError&&<p className="negative" role="alert">{trendError}</p>}{trend?.status==='measured'&&<><div className="trend-chart-lines">{selectedLines.map(line=>{const coincident=trend.lines.filter(other=>Math.abs(other.value-line.value)<1e-7&&Math.abs(other.slope-line.slope)<1e-12);return <button key={line.id} aria-pressed={highlight===line.id} onClick={()=>setHighlight(v=>v===line.id?null:line.id)}><span className={'trend-swatch '+line.style}/><b>{line.minutes}m {line.polarity}</b> · {coincident.length>1?[...new Set(coincident.map(l=>l.style))].join(' / '):line.a.edge+' → '+line.b.edge}<small>{line.touches?line.touches+' separate pre-entry touch'+(line.touches===1?'':'es'):'Two anchors · no independent touch yet'}{line.a.impulse||line.b.impulse?' · impulse anchor':''} · {gapPrice(trendValueAt(line,gapAsOf))} at entry</small></button>;})}</div><p className="trend-chart-note">Blue wick · amber body · purple mixed. Dashed portions precede mathematical confirmation; dotted portions after entry are projections. Only the solid pre-entry portion can supply independent touches. Lines use the same wall-clock scale as the chart and stop searching at missing minutes or session closures. {trend.truncated?'The bounded candidate search was reached. ':''}{selectedLines.length?'Select a line above to highlight it.':'No intact candidates survived the fixed geometry rules.'}</p></>}</div>}
  <details className="weekly-gap-details"><summary>Weekly gaps · {gapLoading?'checking history…':visibleGaps.length+' in range · '+gapContext.gaps.length+' known before entry'}<ChevronRight size={13}/></summary><p>Last 35 days · Friday close → Sunday reopen · exact {trade.contract} candles. Zones extend to the last candle in this view. They are retained as historical context after price trades through them; no validity or bounce is inferred.</p>{gapError&&<p className="negative" role="alert">{gapError}</p>}{!gapLoading&&gapContext.unavailable>0&&<p>{gapContext.unavailable} weekly boundary pair{gapContext.unavailable===1?' is':'s are'} unavailable. Missing and holiday/early-close boundaries are not guessed.</p>}{gapContext.noGapWeeks>0&&<p>{gapContext.noGapWeeks} observed week{gapContext.noGapWeeks===1?' has':'s have'} the same closing and opening price.</p>}{gapContext.gaps.map(g=><div className="weekly-gap-row" key={g.id}><span>{dateLabel(g.sunday,true)}</span><span>{gapPrice(g.low)} – {gapPrice(g.high)}</span><span>Mid {gapPrice(g.midpoint)}{!visibleGaps.includes(g)?' · outside this view':''}</span></div>)}</details>
  <p className="price-strategy-note">Weekly gaps and trendline candidates provide context. {pilot?'This trendline pilot covers October 7–20 only.':'Trendline reconstruction is currently limited to the October 7–20 pilot.'} No intended strategy is assigned or saved.</p></section>;
}
