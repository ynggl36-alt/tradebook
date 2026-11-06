import type {Trade} from './types';
import type {RealizedDay} from './realized';
import {addDays,round} from './analytics';
import {flexSession,flexSessionStart} from './trading-session';
import {parseTimestamp} from './csv';
import {summarizeRealized} from './realized';

export type DayBalanceRead={at:string;value:number;provider:string;connection:string};
export type DayAccountBalance={account:string;first:DayBalanceRead|null;last:DayBalanceRead|null;change:number|null};
export type DayBalanceBasis='calendar'|'session';
export type DayBalanceReport={day:string;basis?:DayBalanceBasis;asOf:string;accounts:DayAccountBalance[]};

export function calendarDayRange(day:string,basis:DayBalanceBasis='calendar'){
 if(!/^20\d{2}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day+'T12:00:00Z'))||new Date(day+'T12:00:00Z').toISOString().slice(0,10)!==day)throw new Error('Choose a valid calendar date.');
 if(basis==='session')return {start:flexSessionStart(day),end:flexSessionStart(addDays(day,1))};
 return {start:parseTimestamp(day+' 00:00:00','America/Chicago'),end:parseTimestamp(addDays(day,1)+' 00:00:00','America/Chicago')};
}
export function validateDayBalanceRequest(raw:unknown){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Choose a calendar date and accounts.');
 const input=raw as Record<string,unknown>;
 if(typeof input.day!=='string')throw new Error('Choose a calendar date.');
 if(input.basis!==undefined&&input.basis!=='calendar'&&input.basis!=='session')throw new Error('Choose a valid day basis.');
 const basis=input.basis as DayBalanceBasis|undefined,range=calendarDayRange(input.day,basis);
 if(!Array.isArray(input.accounts)||input.accounts.length>500||input.accounts.some(a=>typeof a!=='string'||!a.trim()||a.length>150||/[\u0000-\u001f]/.test(a)))throw new Error('Choose up to 500 valid accounts.');
 return {day:input.day,basis,...range,accounts:[...new Set((input.accounts as string[]).map(a=>a.trim()))]};
}
export function dayBalanceReport(day:string,accounts:string[],points:(DayBalanceRead&{account:string})[],asOf:string,basis?:DayBalanceBasis):DayBalanceReport{
 const groups=new Map<string,DayBalanceRead[]>();
 for(const {account,...point}of points){const rows=groups.get(account)||[];rows.push(point);groups.set(account,rows);}
 return {day,asOf,...(basis?{basis}:{}),accounts:accounts.map(account=>{
  const rows=(groups.get(account)||[]).sort((a,b)=>a.at.localeCompare(b.at)),first=rows[0]||null,last=rows.length>1?rows.at(-1)!:null;
  const sameSource=first&&last&&first.provider&&first.connection&&first.provider===last.provider&&first.connection===last.connection;
  return {account,first,last,change:sameSource?round(last!.value-first!.value):null};
 })};
}

// An entry-only account still traded on this date, even when its completed
// positions close later. Realized rows include every captured entry and exit.
export function calendarAccountRows(trades:Trade[],sessions:RealizedDay[],day:string){
 const closed=trades.filter(t=>flexSession(t.exit)===day),activity=sessions.filter(r=>r.day===day);
 const names=new Set([...activity.map(r=>r.account),...closed.map(t=>t.account)]);
 return [...names].map(account=>{
  const completed=closed.filter(t=>t.account===account),rows=activity.filter(r=>r.account===account),daily=summarizeRealized(rows);
  return {account,symbols:[...new Set([...rows,...completed].map(r=>r.symbol))].sort(),completed:completed.length,exits:daily.exits,
   gross:daily.gross,net:daily.net,
   incomplete:daily.unmatched>0||daily.coverageIssues>0||(!rows.length&&completed.length>0)};
 }).sort((a,b)=>Math.abs(b.gross)-Math.abs(a.gross)||a.account.localeCompare(b.account));
}
