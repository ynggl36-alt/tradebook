'use client';
import React,{useEffect,useState} from 'react';
import {Moon,Sun} from 'lucide-react';
type Theme='dark'|'light';
const key='tradebook-theme';
function applyTheme(theme:Theme){document.documentElement.dataset.theme=theme;document.querySelector('meta[name="theme-color"]')?.setAttribute('content',theme==='dark'?'#0f171b':'#f6f7f2');}
export function ThemeToggle(){
 const [theme,setTheme]=useState<Theme>('dark');
 useEffect(()=>{
  const current=document.documentElement.dataset.theme==='light'?'light':'dark';setTheme(current);
  const sync=(event:StorageEvent)=>{if(event.key!==key)return;const next=event.newValue==='light'?'light':'dark';applyTheme(next);setTheme(next);};
  window.addEventListener('storage',sync);return()=>window.removeEventListener('storage',sync);
 },[]);
 const toggle=()=>{const next=theme==='dark'?'light':'dark';applyTheme(next);setTheme(next);try{localStorage.setItem(key,next);}catch{}};
 return <button className="theme-toggle" type="button" onClick={toggle} aria-label="Dark theme" aria-pressed={theme==='dark'} title={'Switch to '+(theme==='dark'?'light':'dark')+' theme'}>{theme==='dark'?<Sun size={17}/>:<Moon size={17}/>}<span>{theme==='dark'?'Light':'Dark'}</span></button>;
}
