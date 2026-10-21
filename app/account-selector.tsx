'use client';
import React,{useEffect,useId,useMemo,useRef,useState} from 'react';
import {Check,ChevronDown,Copy,Search} from 'lucide-react';
import type {AccountProfile} from '../lib/types';
import {accountStage} from '../lib/lucid-flex';

type AccountChoice=string|{account:string;label?:string;stage?:string};
export function accountDisplayName(account:string,profile?:AccountProfile,stage?:string){
 const classification=stage||accountStage(account,profile),shortStage=classification==='Evaluation'?'Eval':classification==='Funded'?'Funded':'Account';
 const suffix=account.length>8?account.slice(-6):account;
 return [profile?.label?.trim(),shortStage,suffix].filter(Boolean).join(' · ');
}

export function AccountSelector({value,onChange,accounts,profiles,allowAll=true,allLabel='All accounts',allowEmpty=false,emptyLabel='Choose account',ariaLabel='Account',disabled=false,required=false,className=''}:{value:string;onChange:(value:string)=>void;accounts:readonly AccountChoice[];profiles?:Map<string,AccountProfile>;allowAll?:boolean;allLabel?:string;allowEmpty?:boolean;emptyLabel?:string;ariaLabel?:string;disabled?:boolean;required?:boolean;className?:string}){
 const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[copied,setCopied]=useState(false),[copyError,setCopyError]=useState(false);
 const root=useRef<HTMLDivElement>(null),search=useRef<HTMLInputElement>(null),id=useId();
 const choices=useMemo(()=>accounts.map(choice=>{
  const item=typeof choice==='string'?{account:choice}:choice,profile=profiles?.get(item.account);
  return {account:item.account,label:item.label||accountDisplayName(item.account,profile,item.stage)};
 }).filter((item,index,all)=>all.findIndex(a=>a.account===item.account)===index),[accounts,profiles]);
 const selected=choices.find(a=>a.account===value),label=value==='all'&&allowAll?allLabel:selected?.label||emptyLabel;
 const matches=choices.filter(a=>(a.account+' '+a.label).toLowerCase().includes(query.trim().toLowerCase()));
 useEffect(()=>{if(!open)return;search.current?.focus();const close=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[open]);
 useEffect(()=>{setCopied(false);setCopyError(false);},[value]);
 useEffect(()=>{if(!copied)return;const timer=setTimeout(()=>setCopied(false),1800);return()=>clearTimeout(timer);},[copied]);
 const choose=(account:string)=>{onChange(account);setOpen(false);setQuery('');root.current?.querySelector<HTMLButtonElement>('.account-selector-trigger')?.focus();};
 const copy=async()=>{try{await navigator.clipboard.writeText(value);setCopied(true);setCopyError(false);}catch{setCopyError(true);}};
 return <div className={'account-selector '+className} ref={root} onKeyDown={event=>{if(event.key==='Escape'&&open){event.stopPropagation();setOpen(false);root.current?.querySelector<HTMLButtonElement>('.account-selector-trigger')?.focus();}}}>
  <button type="button" className="account-selector-trigger" aria-label={ariaLabel+': '+label} aria-haspopup="listbox" aria-expanded={open} aria-controls={id} aria-required={required||undefined} disabled={disabled} title={selected?selected.account:label} onClick={()=>{setQuery('');setOpen(v=>!v);}} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();setQuery('');setOpen(true);}}}><span>{label}</span><ChevronDown size={14}/></button>
  {selected&&<button type="button" className="account-selector-copy icon-btn" disabled={disabled} title={copied?'Account ID copied':'Copy full account ID: '+value} aria-label={copied?'Account ID copied':'Copy full account ID'} onClick={()=>void copy()}>{copied?<Check size={13}/>:<Copy size={13}/>}</button>}
  {copyError&&<span className="account-copy-fallback" role="status">{value}</span>}
  {open&&<div className="account-selector-popover"><label className="account-selector-search"><Search size={14}/><input ref={search} value={query} placeholder="Search account or nickname" aria-label="Search accounts" onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();root.current?.querySelector<HTMLButtonElement>('[role="option"]')?.focus();}else if(event.key==='Enter'&&query.trim()&&matches.length){event.preventDefault();choose(matches[0].account);}}}/></label><div role="listbox" id={id} aria-label={ariaLabel} className="account-selector-options" onKeyDown={event=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const options=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')),index=options.indexOf(document.activeElement as HTMLButtonElement),next=event.key==='Home'?0:event.key==='End'?options.length-1:(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;options[next]?.focus();}}>
   {allowAll&&!query&&<button type="button" role="option" aria-selected={value==='all'} onClick={()=>choose('all')}><span>{allLabel}</span>{value==='all'&&<Check size={14}/>}</button>}
   {allowEmpty&&!query&&<button type="button" role="option" aria-selected={!value} onClick={()=>choose('')}><span>{emptyLabel}</span>{!value&&<Check size={14}/>}</button>}
   {matches.map(a=><button key={a.account} type="button" role="option" aria-selected={value===a.account} title={a.account} onClick={()=>choose(a.account)}><span>{a.label}<small>{a.account}</small></span>{value===a.account&&<Check size={14}/>}</button>)}
   {!matches.length&&query&&<p>No matching accounts</p>}
  </div></div>}
 </div>;
}
