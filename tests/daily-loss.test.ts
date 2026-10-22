import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DAILY_LOSS_LIMIT,DAILY_LOSS_VERSION,DAILY_LOSS_BATCH,validateDailyLossRequest,dailyLossAccount,matchesDailyLossAccount,dailyLossSessions,summarizeDailyLoss,latestDailyLossSession} from '../lib/daily-loss';
import type {DailyLossReport,DailyLossRequest,DailyLossSession} from '../lib/daily-loss';
import type {RealizedEvent} from '../lib/realized';
import {realizedEvents} from '../lib/realized';
import type {AccountProfile,Fill,Trade} from '../lib/types';
import {accountScopeTrades} from '../lib/account-scope';
import {runDailyLoss,DAILY_LOSS_CLIENT_ROWS} from '../lib/daily-loss-runner';

const account='LFF05000000000001',day='2026-10-21',classification={stage:'Funded',markedUpgraded:false};
function event(net:number,time='2026-10-21T14:00:00Z',contract='NQ 2026-12',name=account):RealizedEvent{return {account:name,contract,symbol:contract.split(' ')[0],time,fillId:time+contract,ordinal:1,gross:net,commissions:0,net,exits:1,quantity:1,unmatched:0,coverageIssues:0};}
const report=(events:RealizedEvent[],start=day,end=day)=>dailyLossSessions(account,events,start,end,classification);
function fill(id:string,side:'Buy'|'Sell',qty:number,price:number,pos:number|null,time:string,contract='NQ 2026-12'):Fill{return {id,side,qty,price,pos,time,contract,symbol:contract.split(' ')[0],pv:20,ordinal:Number(id)};}

test('opening-relative loss and peak giveback answer different questions',()=>{
 const row=report([event(1000),event(-1200,'2026-10-21T15:00:00Z')])[0];
 assert.equal(row.worstNet,-200);assert.equal(row.maxGiveback,1200);assert.equal(row.endNet,-200);assert.equal(row.crossingAt,null);assert.equal(row.afterCrossChange,null);
});
test('the exact threshold counts, overshoots stay intact, and subsequent recovery is actual observed change',()=>{
 const exact=report([event(-1200),event(400,'2026-10-21T14:01:00Z'),event(1000,'2026-10-21T14:02:00Z'),event(-2000,'2026-10-21T14:03:00Z')])[0];
 assert.equal(exact.crossingNet,-1200);assert.equal(exact.crossingAt,'2026-10-21T14:00:00.000Z');assert.equal(exact.endNet,-1800);assert.equal(exact.worstNet,-1800);assert.equal(exact.maxGiveback,2000);assert.equal(exact.afterCrossChange,-600);assert.equal(exact.recoveredAboveAt,'2026-10-21T14:01:00.000Z');
 const overshoot=report([event(-1275),event(1500,'2026-10-21T14:01:00Z')])[0];assert.equal(overshoot.crossingNet,-1275);assert.equal(overshoot.afterCrossChange,1500);assert.equal(overshoot.endNet,225);
 const totals=summarizeDailyLoss([exact,overshoot]);assert.equal(totals.crossed,2);assert.equal(totals.recovered,2);assert.equal(totals.endedBelow,1);assert.equal(totals.afterCrossChange,900);
});
test('simultaneous fills combine across contracts and input ordering cannot invent a crossing',()=>{
 const events=[event(-1300),event(200,'2026-10-21T09:00:00-05:00','ES 2026-12'),event(-900,'2026-10-21T15:00:00Z','NQ 2027-03','OTHER-ACCOUNT')],before=JSON.stringify(events);
 const a=report(events)[0],b=report([...events].reverse())[0];assert.deepEqual(a,b);assert.equal(a.groups,1);assert.equal(a.fills,2);assert.equal(a.worstNet,-1100);assert.equal(a.crossingAt,null);assert.equal(JSON.stringify(events),before);
});
test('entry fees, partial exits and reversals retain their original FIFO financial accounting',()=>{
 const fills=[fill('1','Buy',2,1000,2,'2026-10-21T14:00:00Z'),fill('2','Sell',1,940,1,'2026-10-21T14:01:00Z'),fill('3','Sell',2,1020,-1,'2026-10-21T14:02:00Z'),fill('4','Buy',1,1010,0,'2026-10-21T14:03:00Z')],before=JSON.stringify(fills);
 const row=report(realizedEvents(account,fills))[0];
 assert.equal(row.worstNet,-1205.25);assert.equal(row.crossingNet,-1205.25);assert.equal(row.endNet,-610.5);assert.equal(row.afterCrossChange,594.75);assert.equal(row.recoveredAboveAt,'2026-10-21T14:02:00.000Z');assert.equal(JSON.stringify(fills),before);
});
test('unknown fees and inventory poison the session path rather than dropping records or showing a safe result',()=>{
 const fee={...event(-1500),commissions:null,net:null},inventory={...event(-10,'2026-10-21T14:01:00Z'),coverageIssues:1,unmatched:2,net:null};
 const row=report([fee,inventory,event(2000,'2026-10-21T15:00:00Z')])[0];
 assert.equal(row.complete,false);assert.equal(row.fills,3);assert.equal(row.missingFees,1);assert.equal(row.unmatched,2);assert.equal(row.coverageIssues,1);
 for(const key of ['worstNet','maxGiveback','endNet','crossingAt','crossingNet','afterCrossChange','recoveredAboveAt']as const)assert.equal(row[key],null);
 assert.equal(summarizeDailyLoss([row]).unknown,1);assert.equal(summarizeDailyLoss([row]).crossed,0);
 const old=realizedEvents(account,[fill('1','Buy',1,100,1,'2026-08-01T14:00:00Z')]);assert.equal(report(old,'2026-08-01','2026-08-01')[0].complete,false);
});
test('non-finite or unsafe modeled amounts stay unknown rather than becoming a threshold finding',()=>{
 for(const events of [[event(Infinity)],[event(-1200),event(Number.MAX_VALUE,'2026-10-21T15:00:00Z')],[event(-8e13),event(16e13,'2026-10-21T15:00:00Z')]]){
  const row=report(events)[0];assert.equal(row.complete,false);assert.equal(row.crossingAt,null);assert.equal(row.endNet,null);
 }
});
test('midnight stays in one session, 17:00 Central resets to zero, and spring/fall DST boundaries remain correct',()=>{
 const rows=report([event(-800,'2026-10-22T04:59:59Z'),event(-500,'2026-10-22T05:00:00Z'),event(-100,'2026-10-22T22:00:00Z')],'2026-10-22','2026-10-23');
 assert.deepEqual(rows.map(row=>[row.day,row.endNet,row.crossingNet]),[['2026-10-22',-1300,-1300],['2026-10-23',-100,null]]);
 for(const [before,after,start,end]of [['2026-03-08T21:59:59Z','2026-03-08T22:00:00Z','2026-03-08','2026-03-09'],['2026-11-01T22:59:59Z','2026-11-01T23:00:00Z','2026-11-01','2026-11-02']]){
  assert.deepEqual(report([event(-800,before),event(-500,after)],start,end).map(row=>[row.day,row.endNet,row.crossingAt]),[[start,-800,null],[end,-500,null]]);
 }
});
test('the latest calendar date cannot hide an evening fill assigned to the following session',()=>{
 const rows=report([event(-500,'2026-10-21T22:01:00Z')],'2026-01-01','2026-12-31');
 assert.equal(latestDailyLossSession(rows,'2026-10-21'),'2026-10-22');assert.equal(latestDailyLossSession([],'2026-10-21'),'2026-10-21');
});
test('pre-range inventory is reconstructed before selecting session dates',()=>{
 const events=realizedEvents(account,[fill('1','Buy',1,1000,1,'2026-10-20T14:00:00Z'),fill('2','Sell',1,940,0,'2026-10-21T14:00:00Z')]);
 const row=report(events)[0];assert.equal(row.complete,true);assert.equal(row.endNet,-1201.75);assert.equal(row.crossingNet,-1201.75);
});
test('account stages and marked-upgraded evidence retain profile precedence without inferred passing',()=>{
 const profile=(stage:string,status='Active'):AccountProfile=>({account,stage,status,label:'',notes:''});
 const upgraded=dailyLossAccount(account,profile('Evaluation','Upgraded')),funded=dailyLossAccount(account,profile('Funded','Upgraded'));
 assert.equal(upgraded.stage,'Evaluation');assert.equal(upgraded.markedUpgraded,true);assert.equal(funded.markedUpgraded,false);assert.equal(dailyLossAccount('SYNTHETIC-UNKNOWN').stage,'Unclassified');
 assert.equal(matchesDailyLossAccount(upgraded,{stage:'evaluation',markedUpgradedOnly:true}),true);assert.equal(matchesDailyLossAccount(funded,{stage:'all',markedUpgradedOnly:true}),false);assert.equal(matchesDailyLossAccount(dailyLossAccount(account),{stage:'funded',markedUpgradedOnly:false}),true);
 const profitable=report([event(4000)])[0];assert.equal(profitable.markedUpgraded,false);
});
test('request validation rejects malformed/oversized date and account scopes and any instrument-only scenario',()=>{
 const request={accounts:[account],start:day,end:day,stage:'all'};
 assert.equal(validateDailyLossRequest(request).markedUpgradedOnly,false);
 for(const bad of [null,{...request,start:'2026-02-30'},{...request,end:'2026-10-20'},{...request,end:'2027-10-22'},{...request,accounts:[]},{...request,accounts:Array(5).fill(account)},{...request,accounts:[account,account]},{...request,accounts:['a\nb']},{...request,stage:'passed'},{...request,symbol:'NQ'},{...request,limit:1200},{...request,markedUpgradedOnly:'yes'}])assert.throws(()=>validateDailyLossRequest(bad));
 assert.equal(validateDailyLossRequest({...request,start:'2028-01-01',end:'2028-12-31'}).end,'2028-12-31');
});
test('session account reviews include the prior evening and preserve existing calendar/instrument scopes',()=>{
 const trade=(id:string,exit:string,symbol='NQ'):Trade=>({id,account,exit,symbol,contract:symbol+' 2026-12',dir:'Long',entry:exit,qty:1,maxQty:1,avgEntry:1,avgExit:2,pnl:20,exitOrder:1});
 const trades=[trade('prior-morning','2026-10-20T14:00:00Z'),trade('prior-evening','2026-10-20T22:01:00Z'),trade('midnight','2026-10-21T05:01:00Z','ES'),trade('later-session','2026-10-21T22:01:00Z')];
 assert.deepEqual(accountScopeTrades(trades,account,{start:day,end:day,basis:'session',symbol:'all'}).map(row=>row.id),['prior-evening','midnight']);
 assert.deepEqual(accountScopeTrades(trades,account,{start:day,end:day,symbol:'NQ'}).map(row=>row.id),['later-session']);
});

const selection:DailyLossRequest={accounts:Array.from({length:9},(_,i)=>'SYNTHETIC-'+i),start:day,end:day,stage:'all',markedUpgradedOnly:false};
const emptyReport=(request:DailyLossRequest):DailyLossReport=>({version:DAILY_LOSS_VERSION,asOf:'2026-10-22T00:00:00Z',start:request.start,end:request.end,limit:DAILY_LOSS_LIMIT,rows:[],unavailable:[],excluded:[]});
test('client task batches canonically and rejects a late cancelled response before starting more work',async()=>{
 const batches:string[][]=[],progress:number[]=[];
 const data=await runDailyLoss(selection,async request=>{batches.push(request.accounts);return emptyReport(request);},new AbortController().signal,checked=>progress.push(checked));
 assert.deepEqual(batches.map(batch=>batch.length),[4,4,1]);assert.deepEqual(progress,[4,8,9]);assert.equal(data.checkedAccounts,9);
 const controller=new AbortController();let resolve!:(data:DailyLossReport)=>void,calls=0;
 const task=runDailyLoss(selection,async request=>{calls++;return new Promise<DailyLossReport>(done=>{resolve=done;});},controller.signal);
 controller.abort();resolve(emptyReport({...selection,accounts:selection.accounts.slice(0,DAILY_LOSS_BATCH)}));await assert.rejects(task);assert.equal(calls,1);
});
test('client task rejects wrong-scope results and exposes bounded partial reports',async()=>{
 await assert.rejects(()=>runDailyLoss(selection,async request=>({...emptyReport(request),start:'2026-01-01'}),new AbortController().signal),/Unexpected/);
 const accounts=Array.from({length:501},(_,i)=>'SYNTHETIC-'+String(i).padStart(3,'0'));
 const capped=await runDailyLoss({...selection,accounts},async request=>emptyReport(request),new AbortController().signal);assert.equal(capped.checkedAccounts,500);assert.equal(capped.requestedAccounts,501);assert.equal(capped.limited,true);
 // A server page remains within its own cap. The browser stops before a page
 // that would exceed the aggregate bound and labels the report as partial.
 const row=report([event(-1200)])[0];
 const rows=await runDailyLoss({...selection,accounts:accounts.slice(0,100),start:'2028-01-01',end:'2028-12-31'},async request=>({...emptyReport(request),rows:request.accounts.flatMap(account=>Array.from({length:366},(_,i)=>({...row,account,day:new Date(Date.parse('2028-01-01T12:00:00Z')+i*86400000).toISOString().slice(0,10)})))}),new AbortController().signal);
 assert.equal(rows.limited,true);assert.ok(rows.rows.length<=DAILY_LOSS_CLIENT_ROWS);assert.equal(rows.checkedAccounts,52);
});
