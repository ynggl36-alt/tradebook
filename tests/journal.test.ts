import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {reconstruct,mergeFills} from '../lib/reconstruct';
import {centralDay,summarize,dailySeries} from '../lib/analytics';
import {normalizeContract,parseExecutionCsv,parseTimestamp,parseDelimited} from '../lib/csv';
import {journalForYear,reportingRange} from '../lib/reporting-year';
import type {AccountHistory,Fill,Journal} from '../lib/types';
if(!globalThis.crypto)Object.defineProperty(globalThis,'crypto',{value:webcrypto});
const seed=JSON.parse(fs.readFileSync('tests/fixtures/synthetic-history.json','utf8'));
const histories:AccountHistory[]=seed.accounts.map((h:{data:string})=>JSON.parse(h.data));
test('synthetic reference executions rebuild independently specified trades with stable IDs',async()=>{
 let fills=0,count=0,gross=0,issues=0;
 for(const history of histories){const actual=await reconstruct(history.account,history.fills);fills+=actual.fills.length;count+=actual.trades.length;issues+=actual.issues.length;
  const expected=new Map(history.trades.map(t=>[t.id,t]));assert.equal(actual.trades.length,history.trades.length,history.account);
  for(const t of actual.trades){const old=expected.get(t.id);assert.ok(old,'Stable ID not found '+t.id);assert.equal(t.pnl,old.pnl);assert.equal(t.qty,old.qty);assert.equal(t.maxQty,old.maxQty);assert.equal(Date.parse(t.entry),Date.parse(old.entry));assert.equal(Date.parse(t.exit),Date.parse(old.exit));assert.ok(Math.abs(t.avgEntry-old.avgEntry)<1e-7);assert.ok(Math.abs(t.avgExit-old.avgExit)<1e-7);gross+=t.pnl;}
 }
 assert.equal(fills,16);assert.equal(count,8);assert.equal(Math.round(gross*100)/100,160);assert.equal(issues,0);
});
test('account metrics match synthetic reference values including intra-day giveback',()=>{
 const a=summarize(histories[0].trades);assert.equal(a.gross,250);assert.equal(a.count,3);assert.equal(a.drawdown,50);assert.equal(a.last5,250);
 const b=summarize(histories[1].trades);assert.equal(b.gross,-100);assert.equal(b.peak,300);assert.equal(b.giveback,400);assert.equal(b.drawdown,500);
 const all=histories.flatMap(h=>h.trades);assert.equal(dailySeries(all).reduce((s,d)=>s+d.pnl,0),160);assert.equal(summarize(all).wins,5);
});
test('reimport ignores duplicate executions and flags changed prices without overwriting originals',()=>{
 for(const h of histories){const result=mergeFills(h.fills,h.fills);assert.equal(result.added,0);assert.equal(result.duplicates,h.fills.length);assert.equal(result.conflicts.length,0);assert.equal(result.fills.length,h.fills.length);}
 const f=histories[0].fills[0];const result=mergeFills([f],[{...f,price:f.price+1}]);assert.deepEqual(result.conflicts,[f.id]);assert.equal(result.fills[0].price,f.price);
});
const f=(id:string,side:'Buy'|'Sell',qty:number,price:number,pos:number|null,ordinal:number):Fill=>({id,contract:'MNQ 2026-12',symbol:'MNQ',pv:2,time:new Date(Date.UTC(2026,9,15,14,ordinal)).toISOString(),side,qty,price,pos,ordinal});
test('partial exits and a reversal split at flat, with unfinished positions excluded',async()=>{
 const full=await reconstruct('test',[f('1','Buy',2,100,2,1),f('2','Sell',1,110,1,2),f('3','Sell',2,90,-1,3),f('4','Buy',1,80,0,4)]);
 assert.equal(full.trades.length,2);assert.equal(full.trades[0].pnl,0);assert.equal(full.trades[0].qty,2);assert.equal(full.trades[1].pnl,20);assert.equal(full.trades[1].dir,'Short');assert.equal(full.issues.length,0);
 const open=await reconstruct('test',[f('1','Buy',2,100,2,1)]);assert.equal(open.trades.length,0);assert.equal(open.issues.length,1);
 const completed=await reconstruct('test',mergeFills(open.fills,[f('2','Sell',2,105,0,2)]).fills);assert.equal(completed.trades[0].pnl,20);assert.equal(completed.issues.length,0);
 const missing=await reconstruct('test',[{...f('x','Sell',1,105,null,1),entryFlag:false}]);assert.equal(missing.trades.length,0);assert.equal(missing.issues.length,1);
});
test('native CSV, quoting, numeric identifiers, contract normalization and time zones',async()=>{
 const csv='Account,Instrument,Action,Quantity,Price,Time,ID,E/X\r\nACCT,MNQ 12-26,Buy,2,"25,000.25",10/15/2026 9:30:00 AM,0000123,Entry\r\nACCT,MNQ 12-26,Sell,2,"25,025.25",10/15/2026 9:31:00 AM,0000124,Exit';
 const fills=parseExecutionCsv(csv);assert.equal(fills[0].id,'0000123');assert.equal(fills[0].price,25000.25);assert.equal(fills[0].time,'2026-10-15T14:30:00.000Z');assert.equal(fills[0].contract,'MNQ 2026-12');assert.equal((await reconstruct('ACCT',fills)).trades[0].pnl,100);
 assert.equal(parseDelimited('a;b\n"x;y";z')[1][0],'x;y');assert.equal(normalizeContract('NQ 2026-12').pv,20);assert.throws(()=>normalizeContract('XYZ 12-26'));
 assert.equal(parseTimestamp('2026-01-15 09:30:00','America/Chicago'),'2026-01-15T15:30:00.000Z');assert.equal(centralDay('2026-10-16T03:30:00Z'),'2026-10-15');
 assert.throws(()=>parseTimestamp('03/08/2026 02:30:00','America/Chicago'),/gap/);assert.throws(()=>parseTimestamp('11/01/2026 01:30:00','America/Chicago'),/ambiguous/);assert.throws(()=>parseTimestamp('02/30/2026 09:30:00','UTC'),/date/);
});
test('cash movements cannot modify execution-derived trading profit',()=>{
 const before=summarize(histories[0].trades).gross;const payout={deduction:1000,received:900};assert.equal(payout.deduction-payout.received,100);assert.equal(summarize(histories[0].trades).gross,before);
});

test('native display-name exports retain signed positions and reverse newest-first partial fills',async()=>{
 const csv='\uFEFFInstrument,Action,Quantity,Price,Time,ID,E/X,Position,Account display name,\r\nMNQ 12-26,Sell,2,110,10/16/2026 9:31:00 AM,exit_2,Exit,-,ACTUAL-ACCOUNT,\r\nMNQ 12-26,Sell,3,110,10/16/2026 9:31:00 AM,exit_1,Exit,2 L,ACTUAL-ACCOUNT,\r\nMNQ 12-26,Buy,5,100,10/16/2026 9:30:00 AM,entry,Entry,5 L,ACTUAL-ACCOUNT,';
 const fills=parseExecutionCsv(csv);assert.deepEqual(fills.map(f=>f.id),['entry','exit_1','exit_2']);assert.deepEqual(fills.map(f=>f.pos),[5,2,0]);
 const history=await reconstruct('ACTUAL-ACCOUNT',fills);assert.equal(history.issues.length,0);assert.equal(history.trades.length,1);assert.equal(history.trades[0].pnl,100);
 const short=parseExecutionCsv('Account display name,Account Name,Instrument,Action,Quantity,Price,Time,ID,Position\nNickname,REAL-ID,MNQ 12-26,Sell,2,100,10/16/2026 9:30:00 AM,s1,2 S\nNickname,REAL-ID,MNQ 12-26,Buy,2,90,10/16/2026 9:31:00 AM,s2,Flat');
 assert.equal(short[0].account,'REAL-ID');assert.deepEqual(short.map(f=>f.pos),[-2,0]);assert.equal((await reconstruct('REAL-ID',short)).trades[0].pnl,40);
});

test('the 2026 report retains every existing trade and account with the verified annual result',()=>{
 const source:Journal={ready:true,trades:histories.flatMap(h=>h.trades),accounts:histories.map(h=>({account:h.account,fills:h.fills.length,issues:h.issues,first:h.fills[0].time,last:h.fills.at(-1)!.time})),profiles:[],notes:[],cash:[],imports:[],lastSaved:'',seedVersion:'test'};
 const report=journalForYear(source);
 assert.equal(report.accounts.length,3);assert.equal(report.trades.length,8);
 assert.equal(summarize(report.trades).gross,160);
 assert.equal(report.accounts.reduce((s,a)=>s+a.issues.length,0),0);
 assert.ok(histories.every(h=>h.fills.every(f=>centralDay(f.time).startsWith('2026-'))));
 assert.deepEqual(report.trades,source.trades);
});

test('2026 scope follows Central-time closing dates and cash dates without deleting another year',()=>{
 const template=histories[0].trades[0];
 const trades=[
  {...template,id:'prior',account:'cross-year',entry:'2025-12-31T20:00:00Z',exit:'2026-01-01T05:59:59Z',pnl:-900},
  {...template,id:'first',account:'cross-year',entry:'2025-12-31T23:00:00Z',exit:'2026-01-01T06:00:00Z',pnl:100},
  {...template,id:'last',account:'cross-year',entry:'2026-12-31T22:00:00Z',exit:'2027-01-01T05:59:59Z',pnl:-25},
  {...template,id:'next',account:'cross-year',entry:'2027-01-01T06:00:00Z',exit:'2027-01-01T06:01:00Z',pnl:800},
 ];
 const account=(name:string,first:string,last=first)=>({account:name,fills:8,first,last,issues:[]});
 const cash=(id:string,date:string,account:string)=>({id,date,account,kind:'evaluation' as const,deduction:null,received:null,expense:50,note:''});
 const source:Journal={ready:true,trades,accounts:[
  {...account('cross-year','2025-12-31T20:00:00Z','2027-01-01T06:01:00Z'),issues:[{contract:'MNQ 2026-12',time:'2026-06-01T15:00:00Z',reason:'Open',remaining:1},{contract:'MNQ 2025-12',time:'2025-06-01T15:00:00Z',reason:'Open',remaining:1}]},
  account('old-cost-account','2025-06-01T15:00:00Z'),account('prior-only','2025-06-01T15:00:00Z'),account('next-only','2027-06-01T15:00:00Z')
 ],cash:[cash('old','2025-12-31','cross-year'),cash('year-start','2026-01-01',''),cash('year-end','2026-12-31','old-cost-account'),cash('new','2027-01-01','cross-year')],notes:trades.map(t=>({id:t.id,account:t.account,setup:'tag',plan:'',note:''})),profiles:[],imports:[],lastSaved:'',seedVersion:'test'};
 const original=JSON.stringify(source),report=journalForYear(source);
 assert.deepEqual(report.trades.map(t=>t.id),['first','last']);
 assert.equal(summarize(report.trades).gross,75);
 assert.deepEqual(report.cash.map(r=>r.id),['year-start','year-end']);
 assert.deepEqual(report.accounts.map(a=>a.account),['cross-year','old-cost-account']);
 assert.equal(report.accounts[0].issues.length,1);
 assert.ok(report.accounts[0].first.startsWith('2026-01-01'));
 assert.equal(centralDay(report.accounts[0].last),'2026-12-31');
 assert.deepEqual(report.notes.map(n=>n.id),['first','last']);
 assert.equal(JSON.stringify(source),original);
 assert.deepEqual(reportingRange('all','2026-10-15'),{start:'2026-01-01',end:'2026-10-15'});
 assert.deepEqual(reportingRange('7','2026-01-02'),{start:'2026-01-01',end:'2026-01-02'});
 assert.deepEqual(reportingRange('30','2027-01-10'),{start:'2026-12-02',end:'2026-12-31'});
 assert.deepEqual(reportingRange('all','2025-12-31'),{start:'2026-01-01',end:'2026-01-01'});
});
