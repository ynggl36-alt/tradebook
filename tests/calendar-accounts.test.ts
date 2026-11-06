import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {calendarAccountRows,calendarDayRange,dayBalanceReport,validateDayBalanceRequest} from '../lib/calendar-accounts';
import {scopePerformance} from '../lib/performance-scope';
import {journalForYear} from '../lib/reporting-year';
import {accountScopeTrades} from '../lib/account-scope';
import type {Fill,Journal,Trade} from '../lib/types';
import type {AccountStateData} from '../lib/account-state';
import type {RealizedDay} from '../lib/realized';
import {aggregateRealized,realizedEvents} from '../lib/realized';
import {journalExecutionLedger} from '../lib/execution-ledger';
import {reconstructJournal} from '../lib/reconstruct';

const day='2026-10-21',funded='LFF05000000000001',evaluation='LFE05000000000002';
const trade=(account=funded,exit='2026-10-21T17:00:00Z'):Trade=>({id:account+exit,account,contract:'MNQ 2026-12',symbol:'MNQ',dir:'Long',entry:'2026-10-21T15:00:00Z',exit,qty:1,maxQty:1,avgEntry:100,avgExit:150,pnl:100,exitOrder:1});
const row=(account=funded,symbol='MNQ',gross=100,net:number|null=99):RealizedDay=>({account,contract:symbol+' 2026-12',symbol,day,gross,commissions:net===null?null:gross-net,net,exits:1,quantity:1,unmatched:0});

test('calendar balance bounds use Central midnight, including the 23/25-hour DST dates',()=>{
 assert.deepEqual(calendarDayRange(day),{start:'2026-10-21T05:00:00.000Z',end:'2026-10-22T05:00:00.000Z'});
 for(const [date,hours]of [['2026-03-08',23],['2026-11-01',25]]as const){const r=calendarDayRange(date);assert.equal((Date.parse(r.end)-Date.parse(r.start))/3600000,hours);}
 for(const date of ['2026-02-30','2026-13-01','2026-00-01','2026-2-01','bad'])assert.throws(()=>calendarDayRange(date));
 assert.throws(()=>validateDayBalanceRequest(null));assert.throws(()=>validateDayBalanceRequest({day,accounts:['bad\naccount']}));
 assert.throws(()=>validateDayBalanceRequest({day,accounts:Array(501).fill('A')}));
 assert.deepEqual(validateDayBalanceRequest({day,accounts:[' A ','A','B']}).accounts,['A','B']);
});

test('session balance bounds include the previous evening and handle both DST transitions',()=>{
 assert.deepEqual(calendarDayRange(day,'session'),{start:'2026-10-20T22:00:00.000Z',end:'2026-10-21T22:00:00.000Z'});
 for(const [date,hours]of [['2026-03-08',23],['2026-11-01',25]]as const){const r=calendarDayRange(date,'session');assert.equal((Date.parse(r.end)-Date.parse(r.start))/3600000,hours);}
 assert.throws(()=>validateDayBalanceRequest({day,accounts:[],basis:'utc'}));
});

test('selected-day rows and account review include evening closes in the same session and retain entry-only activity',()=>{
 const trades=[trade(),trade(evaluation,'2026-10-22T05:00:00Z')],rows=[row(),row(funded,'NQ',-40,-43.5),{...row(evaluation,'MES',0,-.5),exits:0,quantity:0},{...row('OTHER'),day:'2026-10-20'}];
 const realized=calendarAccountRows(trades,rows,day);
 assert.deepEqual(realized.map(r=>r.account),[funded,evaluation]);assert.equal(realized[0].gross,60);assert.equal(realized[0].net,55.5);assert.equal(realized[0].exits,2);assert.deepEqual(realized[0].symbols,['MNQ','NQ']);
 assert.equal(realized[1].completed,0);assert.equal(realized[1].net,-.5);
 assert.deepEqual(calendarAccountRows([trade(funded,'2026-10-22T04:59:59Z')],[],day),[]);
 const prior=trade(funded,'2026-10-20T21:59:59Z'),evening=trade(funded,'2026-10-20T22:00:00Z'),next=trade(funded,'2026-10-21T22:00:00Z');
 assert.equal(calendarAccountRows([prior,evening,next],[row()],day)[0].completed,1);
 assert.deepEqual(accountScopeTrades([prior,evening,next],funded,{start:day,end:day,basis:'session'}).map(t=>t.id),[evening.id]);
});

test('Calendar year retains a prior-year evening trade, review note and entry-only session account',()=>{
 const first={...trade(funded,'2026-01-01T00:15:00Z'),entry:'2025-12-31T23:01:00Z'},next={...trade(funded,'2027-01-01T00:15:00Z'),entry:'2026-12-31T23:01:00Z'};
 const source={ready:true,accounts:[{account:funded,first:first.entry,last:next.exit,issues:[]},{account:evaluation,first:'2025-01-01T00:00:00Z',last:'2027-01-03T00:00:00Z',issues:[]}],trades:[first,next],notes:[{id:first.id},{id:next.id}],cash:[],profiles:[],realizedSessions:[{...row(evaluation,'MES',0,-.5),day:'2026-01-01',exits:0,quantity:0}]}as unknown as Journal;
 const sessionYear=journalForYear(source,2026,'session');
 assert.deepEqual(sessionYear.trades.map(t=>t.id),[first.id]);assert.deepEqual(sessionYear.notes.map(n=>n.id),[first.id]);assert.ok(sessionYear.accounts.some(a=>a.account===evaluation));
 assert.deepEqual(journalForYear(source,2026).trades.map(t=>t.id),[next.id]);
});

test('account rows respect supplied performance/instrument scope and preserve incomplete or unknown net results',()=>{
 const trades=[trade(),{...trade(evaluation),symbol:'NQ',contract:'NQ 2026-12'}],realized=[row(),row(evaluation,'NQ',-30,null)];
 const journal={accounts:[{account:funded},{account:evaluation}],trades,realized,profiles:[],firmReferences:[]}as unknown as Journal;
 const selected=scopePerformance(journal,'funded','all','MNQ');assert.deepEqual(calendarAccountRows(selected.trades,selected.realized,day).map(r=>r.account),[funded]);
 const incomplete=calendarAccountRows([], [{...row(),net:null,unmatched:1}],day)[0];assert.equal(incomplete.net,null);assert.equal(incomplete.incomplete,true);
 assert.equal(calendarAccountRows([trade('OLDER-ACCOUNT')],[],day)[0].net,null);
 assert.deepEqual(calendarAccountRows(trades,realized,'2026-10-19'),[]);
});

test('recorded balance endpoints retain missing/single reads and avoid comparing different sources',()=>{
 const a={account:funded,at:'2026-10-21T13:00:00.000Z',value:50000,provider:'Rithmic',connection:'Prop'},b={...a,at:'2026-10-21T20:00:00.000Z',value:50200};
 const points=[b,a],original=JSON.stringify(points),result=dayBalanceReport(day,[funded,evaluation],points,b.at);
 assert.equal(result.accounts[0].first?.value,50000);assert.equal(result.accounts[0].last?.value,50200);assert.equal(result.accounts[0].change,200);assert.equal(result.accounts[1].first,null);assert.equal(JSON.stringify(points),original);
 const single=dayBalanceReport(day,[funded],[a],b.at).accounts[0];assert.equal(single.last,null);assert.equal(single.change,null);
 assert.equal(dayBalanceReport(day,[funded],[a,{...b,provider:'Other'}],b.at).accounts[0].change,null);
});

const sqlite=new DatabaseSync(':memory:');
for(const file of fs.readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync('drizzle/'+file,'utf8'));
let queries=0,maxParameters=0;
const database={prepare:(sql:string)=>({bind:(...values:unknown[])=>({all:async()=>{queries++;maxParameters=Math.max(maxParameters,values.length);return {results:sqlite.prepare(sql).all(...values as any[])};}})})};
const originalLoad=(Module as any)._load;
(Module as any)._load=function(name:string,...rest:any[]){return name==='cloudflare:workers'?{env:{DB:database}}:originalLoad.call(this,name,...rest);};
const {loadAccountDayBalances}=require('../lib/server-calendar-accounts')as typeof import('../lib/server-calendar-accounts');
function observation(account:string,at:string,value:number,options:{origin?:string;cashAt?:string;currency?:string;connected?:boolean;provider?:string}={}){
 const state={currency:options.currency??'USD',connected:options.connected??true,provider:options.provider??'Rithmic',connection:'Prop',values:{CashValue:{value,at:options.cashAt??at,source:'PlatformRead'}}};
 const data=JSON.stringify({state});sqlite.prepare('INSERT INTO account_observations(id,account,captured_at,origin,cash_value,data,received_at) VALUES (?,?,?,?,?,?,?)').run(account+at+(options.origin||''),account,at,options.origin??'capture',value,data,at);
}

test('saved day balances use indexed account/date endpoints, excluding stale, absent, foreign-currency and future reads',async()=>{
 const account='DAY-BALANCE-SQL';
 observation(account,'2026-10-21T04:59:59.999Z',49000);
 observation(account,'2026-10-21T05:00:00.000Z',50000);
 observation(account,'2026-10-21T06:00:00.000Z',1,{origin:'legacy'});
 observation(account,'2026-10-21T07:00:00.000Z',2,{connected:false});
 observation(account,'2026-10-21T08:00:00.000Z',3,{currency:'CAD'});
 observation(account,'2026-10-21T09:00:00.000Z',4,{cashAt:'2026-10-21T08:00:00.000Z'});
 observation(account,'2026-10-21T10:00:00.000Z',5,{origin:'not-seen'});
 observation(account,'2026-10-21T17:00:00.000Z',50125);
 observation(account,'2026-10-21T20:00:00.000Z',99999);
 observation(account,'2026-10-22T05:00:00.000Z',88888);
 const before=sqlite.prepare('SELECT total_changes() AS n').get()!.n;
 const report=await loadAccountDayBalances({day,accounts:[account,'NO-SNAPSHOTS']},Date.parse('2026-10-21T19:00:00Z'));
 assert.equal(report.accounts[0].first?.value,50000);assert.equal(report.accounts[0].last?.value,50125);assert.equal(report.accounts[0].change,125);assert.equal(report.accounts[1].first,null);
 assert.equal(sqlite.prepare('SELECT total_changes() AS n').get()!.n,before);
 const next=await loadAccountDayBalances({day:'2026-10-22',accounts:[account]},Date.parse('2026-10-22T12:00:00Z'));assert.equal(next.accounts[0].first?.value,88888);assert.equal(next.accounts[0].last,null);
});

test('large day-balance requests stay bounded and SQL-bound account names cannot alter storage',async()=>{
 queries=0;maxParameters=0;const accounts=Array.from({length:500},(_,i)=>'BOUND-'+i);accounts[0]="x'); DROP TABLE account_observations;--";
 const before=sqlite.prepare('SELECT COUNT(*) AS n FROM account_observations').get()!.n;
 const report=await loadAccountDayBalances({day,accounts},Date.parse('2026-10-22T12:00:00Z'));
 assert.equal(report.accounts.length,500);assert.equal(queries,13);assert.ok(maxParameters<=46);assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM account_observations').get()!.n,before);
 await assert.rejects(()=>loadAccountDayBalances({day:'2026-02-30',accounts:[]}));
});

test('session balance endpoint includes its start and excludes the next session without changing legacy midnight queries',async()=>{
 const account='SESSION-BALANCE-SQL',day='2026-11-02',asOf=Date.parse('2026-11-03T00:00:00Z');
 observation(account,'2026-11-01T22:59:59.999Z',49000);observation(account,'2026-11-01T23:00:00.000Z',50000);
 observation(account,'2026-11-02T06:00:00.000Z',50100);observation(account,'2026-11-02T22:59:59.999Z',50200);observation(account,'2026-11-02T23:00:00.000Z',50300);
 const report=await loadAccountDayBalances({day,accounts:[account],basis:'session'},asOf);assert.equal(report.basis,'session');assert.equal(report.accounts[0].first?.value,50000);assert.equal(report.accounts[0].last?.value,50200);
 const legacy=await loadAccountDayBalances({day,accounts:[account]},asOf);assert.equal(legacy.basis,undefined);assert.equal(legacy.accounts[0].first?.value,50100);assert.equal(legacy.accounts[0].last?.value,50300);
});

test('a dense captured day still returns only the actual endpoint reads',async()=>{
 const account='DENSE-DAY',start=Date.parse('2026-10-21T12:00:00Z');
 for(let i=0;i<5000;i++)observation(account,new Date(start+i*1000).toISOString(),50000+i);
 const result=await loadAccountDayBalances({day,accounts:[account]},Date.parse('2026-10-22T12:00:00Z'));
 assert.equal(result.accounts[0].first?.value,50000);assert.equal(result.accounts[0].last?.value,54999);assert.equal(result.accounts[0].change,4999);
});

test('Calendar renders the same session total, completed trades and NinjaTrader net after evening and morning fills',async()=>{
 const at='2026-11-06T17:00:00.000Z',day='2026-11-06',newFill=(id:number,time:string,side:Fill['side'],qty:number,price:number,pos:number):Fill=>({id:String(id),time,side,qty,price,pos,ordinal:id,contract:'MNQ 2026-12',symbol:'MNQ',pv:2});
 const fills=[newFill(1,'2026-11-05T21:00:00Z','Buy',1,100,1),newFill(2,'2026-11-05T21:05:00Z','Sell',1,200,0),newFill(3,'2026-11-05T23:05:00Z','Buy',1,100,1),newFill(4,'2026-11-05T23:10:00Z','Sell',1,150,0),newFill(5,'2026-11-06T14:05:00Z','Buy',2,100,2),newFill(6,'2026-11-06T14:10:00Z','Sell',2,97.5,0)];
 const ledger=journalExecutionLedger(fills,Date.parse(at)),sessions=aggregateRealized(realizedEvents(funded,fills,ledger),'session'),history=await reconstructJournal(funded,fills,Date.parse(at));
 const accountState:AccountStateData={monitor:{capturedAt:at,accountsSeen:[funded],running:true,recorderVersion:'0.5.1',scopePrefixes:['LFF']},accounts:[{account:funded,connected:true,currency:'USD',provider:'Synthetic',connection:'Synthetic',capturedAt:at,values:{RealizedProfitLoss:{at,value:87,source:'PlatformRead'}},positions:[],positionsAvailable:true,positionsAt:at}]};
 const load=(Module as any)._load;let CalendarView:typeof import('../app/trading-calendar').CalendarView;
 try{(Module as any)._load=function(name:string,...rest:any[]){return name==='./recorder-connection'?{useRecorder:()=>({accountState})}:load.call(this,name,...rest);};CalendarView=require('../app/trading-calendar').CalendarView;}
 finally{(Module as any)._load=load;}
 const html=renderToStaticMarkup(React.createElement(CalendarView,{year:2026,trades:history.trades,sessions,profiles:new Map(),accountFilter:'all',stageFilter:'all',accountStages:new Map(),symbolFilter:'all',notes:new Map(),lastDay:day,onTrade:()=>{},onAccount:()=>{},refreshKey:''}));
 assert.match(html,/class="calendar-cell selected"[^>]*><span class="latest-day">6<\/span><strong class="positive">\+\$90\.00<\/strong><small>2 exit fills/);
 assert.match(html,/\+\$90\.00 gross · 2 completed trades/);assert.match(html,/Matches captured session/);assert.match(html,/\$87\.00/);assert.match(html,/5 pm CT start/);
});
