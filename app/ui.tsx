'use client';
import React,{useEffect,useRef} from 'react';
import {AreaChart,Area,XAxis,YAxis,CartesianGrid,Tooltip,ResponsiveContainer,ReferenceLine} from 'recharts';
import {BookOpen,ChevronRight,X} from 'lucide-react';
import type {Trade,TradeNote} from '../lib/types';
import {centralDay,dailySeries,ordered} from '../lib/analytics';
import {netTradePnl} from '../lib/trading-costs';
import {accountDisplayName} from './account-selector';

const USD=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2});
export const money=(n:number|null|undefined)=>n===null||n===undefined?'—':USD.format(n);
export const signed=(n:number)=>n>0?'+'+money(n):money(n);
export const compact=(n:number)=>Math.abs(n)>=1000?(n<0?'−':'')+'$'+(Math.abs(n)/1000).toFixed(1)+'k':money(n);
export const num=(n:number)=>new Intl.NumberFormat('en-US').format(n);
export const pct=(n:number)=>(n*100).toFixed(1)+'%';
export const signClass=(n:number)=>n<0?'negative':n>0?'positive':'neutral';
export const dateLabel=(s:string,short=false)=>new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:short?'short':'long',day:'numeric',...(short?{}:{year:'numeric'})}).format(new Date(s.slice(0,10)+'T12:00:00Z'));
export const timeLabel=(s:string)=>new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit',second:'2-digit'}).format(new Date(s));
export const tooltipStyle={color:'var(--ink)',background:'var(--surface)',border:'1px solid var(--line)',borderRadius:10,fontSize:12,boxShadow:'0 6px 22px var(--shadow)'};
export async function api<T=any>(path:string,body?:unknown,method='POST'):Promise<T>{
 const r=await fetch('/api/'+path,body!==undefined?{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});const data:any=await r.json();if(!r.ok)throw new Error(data.error||'Unable to save. Please try again.');return data as T;
}
export function Empty({title,children,action}:{title:string;children:React.ReactNode;action?:React.ReactNode}){return <div className="empty"><span className="empty-icon"><BookOpen size={25}/></span><h3>{title}</h3><p>{children}</p>{action}</div>;}
export function Stat({label,value,detail,tone}:{label:string;value:string;detail:string;tone?:string}){return <div className="stat"><div className="stat-label">{label}</div><div className={'stat-value '+(tone||'')}>{value}</div><div className="stat-detail">{detail}</div></div>;}
export function PanelTitle({title,sub,action}:{title:string;sub?:string;action?:React.ReactNode}){return <div className="panel-heading"><div><h2>{title}</h2>{sub&&<p>{sub}</p>}</div>{action}</div>;}
export function Spark({trades}:{trades:Trade[]}){
 const vals=[0];for(const t of ordered(trades))vals.push(vals.at(-1)!+t.pnl);const lo=Math.min(...vals),hi=Math.max(...vals),span=hi-lo||1;const points=vals.map((v,i)=>`${i/(vals.length-1||1)*130},${28-(v-lo)/span*26}`).join(' ');
 return <svg className="spark" viewBox="0 0 132 32" aria-label="Cumulative gross profit"><line x1="0" x2="132" y1={28+lo/span*26} y2={28+lo/span*26} stroke="var(--chart-grid)" strokeDasharray="3 3"/><polyline points={points} fill="none" stroke={vals.at(-1)!>=0?'var(--chart-up)':'var(--chart-down)'} strokeWidth="1.7"/></svg>;
}
export function EquityChart({trades,mode='cumulative'}:{trades:Trade[];mode?:string}){
 const data=dailySeries(trades).map(d=>({...d,label:dateLabel(d.day,true)}));if(!data.length)return <Empty title="No completed trades in this view">Try a wider date range or another account.</Empty>;
 return <div className="chart-area"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data} margin={{top:20,right:12,left:8,bottom:4}}><defs><linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--chart-area)" stopOpacity={.19}/><stop offset="100%" stopColor="var(--chart-area)" stopOpacity={.01}/></linearGradient></defs><CartesianGrid stroke="var(--chart-grid)" vertical={false} strokeDasharray="3 4"/><XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={38} tick={{fontSize:11,fill:'var(--chart-axis)'}} dy={9}/><YAxis width={70} tickFormatter={compact} tickLine={false} axisLine={false} tick={{fontSize:11,fill:'var(--chart-axis)'}}/><Tooltip contentStyle={tooltipStyle} formatter={(v:any)=>[money(Number(v)),mode==='daily'?'Daily gross P&L':'Cumulative gross P&L']} labelFormatter={(_,p)=>p?.[0]?.payload?.day?dateLabel(p[0].payload.day):''}/><ReferenceLine y={0} stroke="var(--chart-reference)"/><Area type="linear" dataKey={mode==='daily'?'pnl':'cumulative'} stroke="var(--chart-up)" strokeWidth={2.3} fill="url(#equityFill)" activeDot={{r:5,fill:'var(--chart-up)',stroke:'var(--surface)',strokeWidth:2}} dot={data.length<3}/></AreaChart></ResponsiveContainer></div>;
}
export function TradeTable({trades,notes,onTrade,limit=10,pnlMode='gross',accountStages}:{trades:Trade[];notes:Map<string,TradeNote>;onTrade:(t:Trade,pnlMode?:'gross'|'net')=>void;limit?:number;pnlMode?:'gross'|'net';accountStages?:ReadonlyMap<string,string>}){
 const rows=ordered(trades).reverse().slice(0,limit);if(!rows.length)return <Empty title="No completed trades to show">Completed trades will appear here after an import.</Empty>;
 return <div className="table-scroll"><table className="trade-table"><thead><tr><th>Contract / direction</th><th>Account</th><th>Closed time <small>CT</small></th><th>Size</th><th>Entry type</th><th className="right">{pnlMode==='net'?'Net P&L · model':'Gross P&L'}</th><th/></tr></thead><tbody>{rows.map(t=><tr key={t.id} tabIndex={0} onClick={()=>onTrade(t,pnlMode)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onTrade(t,pnlMode);}}}><td><strong>{t.symbol}</strong><span className={'direction '+t.dir.toLowerCase()}>{t.dir}</span><small className="block muted">{t.contract.slice(t.symbol.length+1)}</small></td><td><span className="account-text" title={t.account}>{accountDisplayName(t.account,undefined,accountStages?.get(t.account))}</span></td><td>{dateLabel(centralDay(t.exit),true)}<small className="block muted">{timeLabel(t.exit)}</small><small className="block muted">Opened {dateLabel(centralDay(t.entry),true)} · {timeLabel(t.entry)}</small></td><td>{t.qty}<small className="block muted">contracts entered</small></td><td>{notes.get(t.id)?.setup||<span className="tag-add">+ Add tag</span>}</td><td className={'right amount '+signClass(pnlMode==='net'?(netTradePnl(t)??0):t.pnl)}>{pnlMode==='net'?netTradePnl(t)===null?'—':signed(netTradePnl(t)!):signed(t.pnl)}</td><td><ChevronRight size={15}/></td></tr>)}</tbody></table></div>;
}
export function Modal({title,kicker,children,onClose,wide=false}:{title:string;kicker?:string;children:React.ReactNode;onClose:()=>void;wide?:boolean}){
 const ref=useRef<HTMLDivElement>(null);
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;const old=document.body.style.overflow;document.body.style.overflow='hidden';ref.current?.focus();const key=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose();if(e.key==='Tab'){const els=ref.current?.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex="0"]');if(!els?.length)return;const first=els[0],last=els[els.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}};document.addEventListener('keydown',key);return()=>{document.body.style.overflow=old;document.removeEventListener('keydown',key);previous?.focus();};},[onClose]);
 return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div className={'modal '+(wide?'modal-wide':'')} ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}><header className="modal-header"><div>{kicker&&<div className="eyebrow">{kicker}</div>}<h2>{title}</h2></div><button className="icon-btn" onClick={onClose} aria-label="Close dialog"><X size={21}/></button></header>{children}</div></div>;
}
