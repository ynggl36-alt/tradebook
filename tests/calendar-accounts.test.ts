import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {calendarAccountRows,calendarDayRange,dayBalanceReport,validateDayBalanceRequest} from '../lib/calendar-accounts';
import {scopePerformance} from '../lib/performance-scope';
import type {Journal,Trade} from '../lib/types';
import type {RealizedDay} from '../lib/realized';

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

test('selected-day account rows retain entry-only activity and reconcile separately for realized and completed bases',()=>{
 const trades=[trade(),trade(evaluation,'2026-10-22T05:00:00Z')],rows=[row(),row(funded,'NQ',-40,-43.5),{...row(evaluation,'MES',0,-.5),exits:0,quantity:0},{...row('OTHER'),day:'2026-10-20'}];
 const realized=calendarAccountRows(trades,rows,day,'realized'),closed=calendarAccountRows(trades,rows,day,'closed');
 assert.deepEqual(realized.map(r=>r.account),[funded,evaluation]);assert.equal(realized[0].gross,60);assert.equal(realized[0].net,55.5);assert.equal(realized[0].exits,2);assert.deepEqual(realized[0].symbols,['MNQ','NQ']);
 assert.equal(realized[1].completed,0);assert.equal(realized[1].net,-.5);
 assert.equal(closed.reduce((s,r)=>s+r.gross,0),100);assert.equal(closed[0].net,99);assert.equal(closed[1].net,0);
 assert.equal(calendarAccountRows([trade(funded,'2026-10-22T04:59:59Z')],[],day,'closed')[0].completed,1);
});

test('account rows respect supplied performance/instrument scope and preserve incomplete or unknown net results',()=>{
 const trades=[trade(),{...trade(evaluation),symbol:'NQ',contract:'NQ 2026-12'}],realized=[row(),row(evaluation,'NQ',-30,null)];
 const journal={accounts:[{account:funded},{account:evaluation}],trades,realized,profiles:[],firmReferences:[]}as unknown as Journal;
 const selected=scopePerformance(journal,'funded','all','MNQ');assert.deepEqual(calendarAccountRows(selected.trades,selected.realized,day,'realized').map(r=>r.account),[funded]);
 const incomplete=calendarAccountRows([], [{...row(),net:null,unmatched:1}],day,'realized')[0];assert.equal(incomplete.net,null);assert.equal(incomplete.incomplete,true);
 assert.equal(calendarAccountRows([trade('OLDER-ACCOUNT')],[],day,'closed')[0].net,null);
 assert.deepEqual(calendarAccountRows(trades,realized,'2026-10-19','realized'),[]);
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

test('a dense captured day still returns only the actual endpoint reads',async()=>{
 const account='DENSE-DAY',start=Date.parse('2026-10-21T12:00:00Z');
 for(let i=0;i<5000;i++)observation(account,new Date(start+i*1000).toISOString(),50000+i);
 const result=await loadAccountDayBalances({day,accounts:[account]},Date.parse('2026-10-22T12:00:00Z'));
 assert.equal(result.accounts[0].first?.value,50000);assert.equal(result.accounts[0].last?.value,54999);assert.equal(result.accounts[0].change,4999);
});
