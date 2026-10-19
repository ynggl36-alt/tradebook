'use client';
import React,{useEffect,useMemo,useRef,useState} from 'react';
import {ChevronRight,Download,FolderOpen,LoaderCircle} from 'lucide-react';
import type {Fill,Trade} from '../lib/types';
import type {PriceBar} from '../lib/recorder';
import {aggregateBars,executionMarkers,markerCoverage} from '../lib/recorder';
import {readPriceBars} from '../lib/recorder-browser';
import {parseTimestamp} from '../lib/csv';
import {centralDay} from '../lib/analytics';
import {useRecorder} from './recorder-connection';
import {dateLabel,num,PanelTitle,signed,timeLabel} from './ui';

type WindowKind='trade'|'day'|'week';
const options=[{id:'trade',label:'1m · Trade',minutes:1},{id:'day',label:'5m · Day',minutes:5},{id:'week',label:'15m · Week',minutes:15}] as const;
const price=(n:number)=>n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
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
  const svg=useRef<SVGSVGElement>(null);
  const range=useMemo(()=>chartRange(trade,kind),[trade.entry,trade.exit,kind]);
  useEffect(()=>{let cancelled=false;setReading(true);setError('');setHover(null);readPriceBars(trade.contract,range.start,range.end).then(data=>{if(!cancelled)setRaw(data);}).catch(e=>{if(!cancelled){setError(e instanceof Error?e.message:String(e));setRaw([]);}}).finally(()=>{if(!cancelled)setReading(false);});return()=>{cancelled=true;};},[trade.contract,range.start,range.end,recorder.revision]);
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
  const chartControls=<div className="price-controls"><div className="segmented">{options.map(o=><button key={o.id} className={kind===o.id?'selected':''} onClick={()=>setKind(o.id)}>{o.label}</button>)}</div>{bars.length>0&&<button className="icon-btn" title="Save chart as PNG" aria-label="Save chart as PNG" disabled={saving||loading||reading} onClick={()=>void saveChart()}>{saving?<LoaderCircle size={16} className="spin"/>:<Download size={16}/>}</button>}</div>;
  if(!bars.length){
    const hasSource=!!recorder.folder||recorder.summary.barCount>0,permission=recorder.phase==='permission';
    const status=reading?'Checking saved candles…':permission?'Folder access needed':hasSource?'Not recorded for this trade':'Recorder not connected';
    return <details className="inner-panel price-panel price-empty-panel"><summary><span>Price history</span><small>{status}</small><ChevronRight size={14}/></summary><PanelTitle title="Recorded price history" sub={trade.contract+' · exact-contract candles'} action={chartControls}/><div className="price-empty">{reading?<><LoaderCircle size={23} className="spin"/><strong>Reading saved candles…</strong></>:<><FolderOpen size={27}/><strong>{permission?'Allow folder access to read price history':hasSource?'Price history was not recorded for this trade':'Connect your recorder for price history'}</strong><p>{permission?'Resume folder access in Settings to read saved candles.':hasSource?'This capture has no '+trade.contract+' candles around '+dateLabel(centralDay(trade.entry),true)+'. Try a wider window or add a capture containing those prices.':'Connect the recorder folder in Settings or import a saved snapshot containing price history.'}</p><button className="button subtle small" onClick={onConnect}>{hasSource?'Price history settings':'Connect recorder'}</button></>}{error&&<p className="negative" role="alert">{error}</p>}</div></details>;
  }

  const width=960,height=450,left=28,right=870,top=76,bottom=365;
  const first=Math.min(bars[0].start,Date.parse(trade.entry),...markers.map(m=>m.time));
  const last=Math.max(bars.at(-1)!.end,Date.parse(trade.exit)+60000,...markers.map(m=>m.time+60000));
  const span=Math.max(last-first,60000),pad=span*.02;
  const low=Math.min(...bars.map(b=>b.low),...markers.map(m=>m.price)),high=Math.max(...bars.map(b=>b.high),...markers.map(m=>m.price));
  const pricePad=Math.max((high-low)*.13,1),lo=low-pricePad,hi=high+pricePad;
  const x=(time:number)=>left+(time-first+pad)/(span+pad*2)*(right-left);
  const y=(value:number)=>bottom-(value-lo)/(hi-lo)*(bottom-top);
  const candleWidth=Math.max(1,Math.min(11,(right-left)/(span/(minutes*60000)+2)*.65));
  const active=hover===null?null:bars[hover];
  return <section className="inner-panel price-panel"><PanelTitle title="Price history" sub="Actual fills on recorded prices · Central time" action={chartControls}/><div className="price-chart-scroll"><svg ref={svg} className="price-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={trade.contract+' candles with '+markers.length+' actual execution markers'} fontFamily="Inter,Segoe UI,Arial,sans-serif" onPointerLeave={()=>setHover(null)}>
    <title>{trade.contract} {trade.dir} · {dateLabel(centralDay(trade.entry))} · {signed(trade.pnl)} gross</title><desc>{minutes}-minute candles. Buy markers are green upward triangles; sell markers are red downward triangles. E identifies an entry, X an exit. The shaded band shows time in the trade. Missing price data is not filled in.</desc>
    <rect width={width} height={height} fill="var(--surface)"/><text x={left} y="26" fontSize="15" fontWeight="600" fill="var(--ink)">{trade.contract} · {trade.dir} · {minutes}m</text><text x={left} y="47" fontSize="10" fill="var(--chart-axis)">{trade.account} · {dateLabel(centralDay(trade.entry),true)}, 2026 · {signed(trade.pnl)} gross</text><text x={width-24} y="26" textAnchor="end" fontSize="12" fontWeight="600" fill="var(--chart-up)">tradebook.</text><text x={width-24} y="47" textAnchor="end" fontSize="10" fill="var(--chart-axis)">NinjaTrader · exact contract · CT</text>
    <rect x={x(Date.parse(trade.entry))} y={top} width={Math.max(2,x(Date.parse(trade.exit))-x(Date.parse(trade.entry)))} height={bottom-top} fill="var(--chart-band)"/>
    {Array.from({length:6},(_,i)=>{const value=lo+(hi-lo)*i/5;return <g key={i}><line x1={left} x2={right} y1={y(value)} y2={y(value)} stroke="var(--chart-grid)" strokeDasharray="3 4"/><text x={right+12} y={y(value)+3} fontSize="10" fill="var(--chart-axis)">{price(value)}</text></g>;})}
    {bars.map(b=>{const cx=x(b.start+Math.min(minutes*60000,b.end-b.start)/2),up=b.close>=b.open,color=up?'var(--chart-up)':'var(--chart-down)';return <g key={b.id}><title>{timeLabel(new Date(b.start).toISOString())+' CT · O '+price(b.open)+' H '+price(b.high)+' L '+price(b.low)+' C '+price(b.close)+' · volume '+num(b.volume)}</title><line x1={cx} x2={cx} y1={y(b.high)} y2={y(b.low)} stroke={color} strokeWidth="1"/><rect x={cx-candleWidth/2} y={Math.min(y(b.open),y(b.close))} width={candleWidth} height={Math.max(1,Math.abs(y(b.open)-y(b.close)))} fill={color}/></g>;})}
    {Array.from({length:6},(_,i)=>{const time=first+span*i/5;return <g key={i}><line x1={x(time)} x2={x(time)} y1={bottom} y2={bottom+4} stroke="var(--chart-reference)"/><text x={x(time)} y={bottom+21} textAnchor={i===0?'start':i===5?'end':'middle'} fontSize="10" fill="var(--chart-axis)">{(kind==='week'?axisDay:axisTime).format(new Date(time))}</text></g>;})}
    <rect x={left} y={top} width={right-left} height={bottom-top} fill="transparent" onPointerMove={event=>{const box=event.currentTarget.ownerSVGElement!.getBoundingClientRect(),px=(event.clientX-box.left)/box.width*width;let best=0,delta=Infinity;bars.forEach((b,i)=>{const distance=Math.abs(x(b.start+minutes*30000)-px);if(distance<delta){delta=distance;best=i;}});setHover(best);}}/>
    {markers.map((m,i)=>{const cx=x(m.time),cy=y(m.price),buy=m.side==='Buy',color=buy?'var(--chart-up)':'var(--chart-down)',labelY=Math.max(top+12,Math.min(bottom-10,cy+(buy?1:-1)*(24+(i%3)*13)));return <g key={m.id} tabIndex={0} aria-label={m.role+' '+m.side+' '+m.qty+' at '+price(m.price)+' at '+timeLabel(new Date(m.time).toISOString())+' Central time'}><title>{m.role+' · '+m.side+' '+m.qty+' @ '+price(m.price)+' · '+timeLabel(new Date(m.time).toISOString())+' CT'}</title><line x1={cx} x2={cx} y1={cy} y2={labelY} stroke={color} strokeWidth=".8" strokeDasharray="2 2"/><circle cx={cx} cy={cy} r="3" fill={color} stroke="var(--surface)" strokeWidth="1"/><path d={buy?`M ${cx} ${labelY-9} l -4 7 h 8 Z`:`M ${cx} ${labelY+3} l -4 -7 h 8 Z`} fill={color}/><text x={Math.min(right-20,Math.max(left+4,cx+6))} y={labelY+3} fontSize="10" fontWeight="600" fill={color}>{m.role==='Entry'?'E':'X'}{i+1} · {m.qty}</text></g>;})}
    {active&&<g data-interactive="true" pointerEvents="none"><line x1={x(active.start+minutes*30000)} x2={x(active.start+minutes*30000)} y1={top} y2={bottom} stroke="var(--chart-reference)" strokeDasharray="3 3"/><rect x={left} y="55" width="620" height="17" rx="3" fill="var(--surface-soft)"/><text x={left+6} y="67" fontSize="10" fill="var(--text-secondary)">{timeLabel(new Date(active.start).toISOString())} CT · O {price(active.open)} · H {price(active.high)} · L {price(active.low)} · C {price(active.close)} · V {num(active.volume)}</text></g>}
    <text x={left} y="414" fontSize="10" fill="var(--chart-up)">▲ Buy</text><text x={left+65} y="414" fontSize="10" fill="var(--chart-down)">▼ Sell</text><rect x={left+136} y="406" width="12" height="10" fill="var(--chart-band)"/><text x={left+154} y="414" fontSize="10" fill="var(--chart-axis)">Time in trade · E entry / X exit</text><text x={left} y="435" fontSize="10" fill="var(--chart-axis)">{num(raw.length)} observed 1m candles · {coverage.covered}/{coverage.total} fills have a matching 1m candle · no invented prices</text>
  </svg></div>
  <div className="price-caption"><span>{reading||loading?<><LoaderCircle size={12} className="spin"/> {reading?'Updating candles…':'Loading actual fills…'}</>:coverage.total?coverage.covered+' / '+coverage.total+' fills matched to a candle':'Execution details unavailable'}</span><span>{dateLabel(centralDay(new Date(raw[0].start).toISOString()),true)} {timeLabel(new Date(raw[0].start).toISOString())} – {dateLabel(centralDay(new Date(raw.at(-1)!.end).toISOString()),true)} {timeLabel(new Date(raw.at(-1)!.end).toISOString())} CT</span></div>
  {!loading&&(coverage.missing>0||coverage.outside>0||unmatched>0)&&<div className="notice price-notice">{coverage.missing>0&&<p>{coverage.missing} fill{coverage.missing===1?' has':'s have'} no completed candle yet. A final minute may still be forming or absent from the capture.</p>}{coverage.outside>0&&<p>{coverage.outside} fill price{coverage.outside===1?' is':'s are'} outside the recorded minute’s range. Review the source before classifying the setup.</p>}{unmatched>0&&<p>{unmatched} allocated execution{unmatched===1?' has':'s have'} no matching fill detail and cannot be placed.</p>}</div>}
  {error&&<div className="error-box" role="alert">{error}</div>}
  <p className="price-strategy-note">Use the chart to review your entry tag. Weekly-gap and trendline setups need their earlier context; no setup has been assigned automatically.</p></section>;
}
