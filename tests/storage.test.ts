import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import Module from 'node:module';
import type {AccountHistory,Fill} from '../lib/types';
import {synchronizeExecutions,validateRecorderImport} from '../lib/recorder-sync';
import type {AccountFill} from '../lib/recorder-sync';

const sqlite=new DatabaseSync(':memory:');
for(const filename of fs.readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(fs.readFileSync('drizzle/'+filename,'utf8'));
class Statement{
 constructor(private sql:string,private values:any[]=[]){ }
 bind(...values:any[]){return new Statement(this.sql,values);}
 async first(){return sqlite.prepare(this.sql).get(...this.values)??null;}
 async all(){return {success:true,results:sqlite.prepare(this.sql).all(...this.values),meta:{changes:0}};}
 async run(){const result=sqlite.prepare(this.sql).run(...this.values);return {success:true,meta:{changes:Number(result.changes)}};}
}
const preparedQueries:string[]=[];
const database={prepare:(sql:string)=>{preparedQueries.push(sql);return new Statement(sql);},batch:async(statements:Statement[])=>{sqlite.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
const syntheticSeed=JSON.parse(fs.readFileSync('tests/fixtures/synthetic-history.json','utf8'));
const originalLoad=(Module as any)._load;
(Module as any)._load=function(name:string,...rest:any[]){if(name.endsWith('/data/initial-history.json'))return syntheticSeed;if(name==='cloudflare:workers')return {env:{DB:database}};return originalLoad.call(this,name,...rest);};
const server=require('../lib/server-journal')as typeof import('../lib/server-journal');
const prices=require('../lib/server-prices')as typeof import('../lib/server-prices');
const gapContext=require('../lib/server-gap-context')as typeof import('../lib/server-gap-context');
const trendEntries=require('../lib/server-trendline-entries')as typeof import('../lib/server-trendline-entries');

test('journal revision checks observe changes and partial-exit reports preserve original completed trades',async()=>{
 let offset=0,ready=false;while(!ready){const result=await server.bootstrap(offset);offset=result.next;ready=result.ready;}
 const original=await server.loadJournal(),version=await server.loadJournalVersion(),account='LFF-REALIZED-STORAGE';
 const fills=[{account,id:'partial-entry',contract:'MES 2026-12',side:'Buy',qty:2,price:7700,time:'2026-10-19T15:00:00Z',pos:2},{account,id:'partial-exit',contract:'MES 2026-12',side:'Sell',qty:1,price:7710,time:'2026-10-19T15:01:00Z',pos:1}];
 await server.importExecutions({source:'local-partial-check',checksum:'1'.repeat(64),chunk:0,fills});
 const partial=await server.loadJournal(),after=await server.loadJournalVersion();assert.notEqual(after.revision,version.revision);assert.equal(partial.revision,after.revision);assert.equal(partial.trades.filter(t=>t.account===account).length,0);
 const rows=partial.realized!.filter(row=>row.account===account);assert.equal(rows[0].gross,50);assert.equal(rows[0].net,48.5);assert.deepEqual(partial.trades,original.trades);
 await server.importExecutions({source:'local-duplicate-check',checksum:'2'.repeat(64),chunk:0,fills});assert.equal((await server.loadJournalVersion()).revision,after.revision);
 await server.saveProfile({account,label:'Version check',stage:'Funded',status:'Active',notes:''});assert.notEqual((await server.loadJournalVersion()).revision,after.revision);
 await server.importExecutions({source:'local-completion-check',checksum:'3'.repeat(64),chunk:0,fills:[{account,id:'partial-final',contract:'MES 2026-12',side:'Sell',qty:1,price:7720,time:'2026-10-19T15:02:00Z',pos:0}]});
 const complete=await server.loadJournal();assert.equal(complete.trades.find(t=>t.account===account)!.pnl,150);assert.equal(complete.realized!.find(row=>row.account===account)!.gross,150);
 // Keep the shared verification database at its original baseline for later tests.
 sqlite.prepare('DELETE FROM account_history WHERE account=?').run(account);sqlite.prepare('DELETE FROM account_profiles WHERE account=?').run(account);
});

test('persistent storage: seed, real SQL imports, payout edits, annotations and portable backup',async()=>{
 let offset=0,ready=false;while(!ready){const next=await server.bootstrap(offset);offset=next.next;ready=next.ready;}
 let j=await server.loadJournal();assert.equal(j.accounts.length,3);assert.equal(j.trades.length,8);assert.equal(j.accounts.reduce((s,a)=>s+a.fills,0),16);
 const originalGross=j.trades.reduce((s,t)=>s+t.pnl,0);const account=j.accounts[0].account,trade=j.trades[0];
 await server.saveProfile({account,label:'SQL verification only',stage:'Funded',status:'Active',notes:'Local test'});
 await server.saveTradeNote({id:trade.id,account:trade.account,setup:'Entry test',plan:'Yes',note:'Local test'});
 await server.saveCash({id:'payout-test',kind:'payout',date:'2026-10-16',account,deduction:1000,received:900,expense:null,note:'Local test'});
 await server.saveCash({id:'payout-partial',kind:'payout',date:'2026-10-17',account,deduction:500,received:null,expense:null,note:''});
 await server.saveCash({id:'cost-test',kind:'reset',date:'2026-10-15',account:'',deduction:null,received:null,expense:50,note:'Local test'});
 await assert.rejects(()=>server.saveCash({id:'invalid',kind:'payout',date:'2026-10-15',account,deduction:-1,received:null,note:''}));
 await assert.rejects(()=>server.saveCash({id:'invalid',kind:'payout',date:'2026-10-15',account,deduction:null,received:null,note:''}));
 j=await server.loadJournal();assert.equal(j.trades.reduce((s,t)=>s+t.pnl,0),originalGross);assert.equal(j.cash.length,3);assert.equal(j.cash.find(r=>r.id==='payout-partial')!.received,null);
 const initial=await server.initialSeed();const history=JSON.parse(initial.accounts[0].data)as AccountHistory;
 const duplicate=await server.importExecutions({source:'overlap.csv',checksum:'a'.repeat(64),chunk:0,fills:history.fills.slice(0,10).map(f=>({...f,account:history.account}))});assert.equal(duplicate.added,0);assert.equal(duplicate.duplicates,Math.min(10,history.fills.length));
 const changed={...history.fills[0],account:history.account,price:history.fills[0].price+1};await assert.rejects(()=>server.importExecutions({source:'changed.csv',checksum:'b'.repeat(64),chunk:0,fills:[changed]}),/differs/);
 const newFills=[{account:'QA-LOCAL-ONLY',id:'new1',contract:'MNQ 2026-12',side:'Buy',qty:2,price:100,time:'2026-10-16T14:30:00Z',pos:2},{account:'QA-LOCAL-ONLY',id:'new2',contract:'MNQ 2026-12',side:'Sell',qty:2,price:110,time:'2026-10-16T14:31:00Z',pos:0}];
 const result=await server.importExecutions({source:'new-account.csv',checksum:'c'.repeat(64),chunk:0,fills:newFills});assert.equal(result.added,2);
 const replay=await server.importExecutions({source:'new-account.csv',checksum:'c'.repeat(64),chunk:0,fills:newFills});assert.equal(replay.added,0);assert.equal(replay.duplicates,2);
 j=await server.loadJournal();assert.equal(j.accounts.length,4);assert.equal(j.trades.length,9);assert.equal(j.trades.reduce((s,t)=>s+t.pnl,0),originalGross+40);assert.equal(j.cash.length,3);assert.equal(j.notes[0].setup,'Entry test');assert.equal(j.profiles[0].label,'SQL verification only');
 const detail=await server.getTrade(trade.account,trade.id);assert.ok(detail?.fills.length);assert.equal(detail?.trade.pnl,trade.pnl);
 const exportFile=JSON.parse(await(await server.backupResponse()).text());assert.equal(exportFile.format,'tradebook-backup-v1');assert.equal(exportFile.history.length,4);assert.equal(exportFile.history.reduce((s:number,h:AccountHistory)=>s+h.fills.length,0),18);assert.equal(exportFile.cash.length,3);assert.equal(exportFile.notes.length,1);
 await server.bootstrap(0);j=await server.loadJournal();assert.equal(j.accounts.length,4);assert.equal(j.cash.length,3);assert.equal(j.trades.length,9);
 const beforeAuto=j;
 const automatic=[...newFills,...newFills.map((f,i)=>({...f,account:'QA-NEW-FUNDED',id:'funded-'+i,time:f.time.replace('2026-10-16','2026-10-19')}))].map(f=>({...server.validateFill(f),account:f.account})) as AccountFill[];
 let acknowledged=0;
 const synced=await synchronizeExecutions(automatic,async payload=>{validateRecorderImport(payload);return server.importExecutions(payload);},async batch=>{acknowledged+=batch.length;},()=>true);
 assert.equal(synced.added,2);assert.equal(synced.duplicates,2);assert.equal(acknowledged,4);
 const again=await synchronizeExecutions(automatic,payload=>server.importExecutions(payload),async()=>{},()=>true);assert.equal(again.added,0);assert.equal(again.duplicates,4);
 j=await server.loadJournal();assert.equal(j.accounts.length,beforeAuto.accounts.length+1);assert.equal(j.trades.length,beforeAuto.trades.length+1);assert.equal(j.trades.reduce((s,t)=>s+t.pnl,0),beforeAuto.trades.reduce((s,t)=>s+t.pnl,0)+40);
 assert.deepEqual(j.cash,beforeAuto.cash);assert.deepEqual(j.notes,beforeAuto.notes);assert.deepEqual(j.profiles,beforeAuto.profiles);
});


test('account monitor persists full snapshots without merging earlier fields or changing trading history',async()=>{
 const before=await server.loadJournal();
 const t='2026-10-16T21:00:00.000Z';
 const snapshot=(capturedAt:string,accounts:any[],running=true)=>({schemaVersion:1,mode:'AccountsReadOnly',recorderVersion:'0.3.0',capturedAt,running,scopePrefixes:['LFE','LFF'],accounts});
 const a={account:'LFF-CURRENT-NO-TRADES',currency:'USD',connected:true,connection:'Test provider',provider:'Rithmic',values:{CashValue:{value:51000,at:t,source:'PlatformRead'},UnrealizedProfitLoss:{value:0,at:t,source:'AccountItemUpdate'}},positionsAvailable:true,positions:[{instrument:'MNQ 12-26',side:'Long',quantity:2,averagePrice:29000}]};
 assert.equal((await server.saveAccountState(snapshot(t,[a]))).accepted,true);
 assert.equal((await server.saveAccountState(snapshot(t,[a]))).accepted,false);
 let state=await server.loadAccountState();assert.equal(state.accounts[0].values.CashValue?.value,51000);assert.equal(state.accounts[0].values.UnrealizedProfitLoss?.value,0);assert.equal(state.accounts[0].values.NetLiquidation,undefined);
 await server.saveProfile({account:a.account,label:'Current funded account',stage:'Funded',status:'Active',notes:'No imported executions yet'});
 // A later cash balance decrease is a snapshot, never an invented payout or trade.
 const t2='2026-10-16T21:00:15.000Z';const decreased={...a,values:{CashValue:{value:50000,at:t2,source:'PlatformRead'}},positions:[]};
 await server.saveAccountState(snapshot(t2,[decreased]));
 assert.equal((await server.saveAccountState(snapshot(t,[a]))).accepted,false);
 state=await server.loadAccountState();assert.equal(state.accounts[0].values.CashValue?.value,50000);assert.equal(state.accounts[0].values.UnrealizedProfitLoss,undefined);assert.equal(state.accounts[0].positions.length,0);
 const t3='2026-10-16T21:00:30.000Z';await server.saveAccountState(snapshot(t3,[{...a,connected:false,currency:'Unknown',values:{},positionsAvailable:false,positions:[]}],false));
 state=await server.loadAccountState();assert.equal(state.monitor?.running,false);assert.equal(state.accounts[0].currency,'Unknown');assert.deepEqual(state.accounts[0].values,{});assert.equal(state.accounts[0].positionsAt,null);assert.equal(state.accounts[0].positionsAvailable,false);
 // An account absent from a newer batch is retained, without changing its manual status.
 await server.saveAccountState(snapshot('2026-10-16T21:00:45.000Z',[]));state=await server.loadAccountState();assert.equal(state.accounts.length,1);assert.deepEqual(state.monitor?.accountsSeen,[]);
 const after=await server.loadJournal();assert.deepEqual(after.accounts,before.accounts);assert.deepEqual(after.trades,before.trades);assert.deepEqual(after.cash,before.cash);assert.equal(after.profiles.find(p=>p.account===a.account)?.status,'Active');
 await server.saveCash({id:'new-current-payout',kind:'payout',date:'2026-10-16',account:a.account,deduction:1000,received:900,note:'Explicit payout confirmation'});
 const backup=JSON.parse(await(await server.backupResponse()).text());assert.deepEqual(backup.accountState.accounts[0].values,{});assert.ok(backup.balanceObservations.some((row:any)=>row.state.account===a.account&&row.capturedAt===t2&&row.state.values.CashValue.value===50000));assert.equal(backup.accountState.monitor.capturedAt,'2026-10-16T21:00:45.000Z');assert.equal((await server.loadJournal()).cash.length,before.cash.length+1);
 // More than 30 accounts exercises bounded SQL batches with the actual SQLite engine.
 const many=Array.from({length:61},(_,i)=>({...a,account:'LFE-BATCH-'+i,values:{},positions:[]}));
 await server.saveAccountState(snapshot('2026-10-16T21:01:00.000Z',many));state=await server.loadAccountState();assert.equal(state.accounts.length,62);assert.equal(state.monitor?.accountsSeen.length,61);
});


test('dated firm figures persist in their own record and backup without rewriting executions, payouts or modeled trade costs',async()=>{
 const before=await server.loadJournal();const account='LFE05000000000003';
 const reference={account,firm:'Lucid',date:'2026-10-16',currency:'USD',balance:51839,totalProfit:1839,sessionPnl:1537,minimumBalance:49839,profitTarget:3074,daysTraded:3,source:'User-supplied Lucid dashboard screenshot'};
 await server.saveFirmReference(reference);let after=await server.loadJournal();
 assert.equal(after.firmReferences?.find(r=>r.account===account)?.totalProfit,1839);assert.deepEqual(after.trades,before.trades);assert.deepEqual(after.accounts,before.accounts);assert.deepEqual(after.cash,before.cash);assert.deepEqual(after.notes,before.notes);assert.deepEqual(after.profiles,before.profiles);
 const backup=JSON.parse(await(await server.backupResponse()).text());assert.equal(backup.firmReferences.find((r:any)=>r.account===account).minimumBalance,49839);
 await assert.rejects(()=>server.saveFirmReference({...reference,account:'NOT-A-JOURNAL-ACCOUNT'}));
 await server.saveFirmReference({...reference,sessionPnl:null});after=await server.loadJournal();assert.equal(after.firmReferences?.find(r=>r.account===account)?.sessionPnl,null);assert.equal(after.firmReferences?.filter(r=>r.account===account).length,1);
 await server.saveFirmReference({...reference,flex:{stage:'Evaluation',consistencyPercent:50,qualifyingDays:null,capturedAt:'2026-10-19T14:17:43.000Z'}});const saved=(await server.loadJournal()).firmReferences?.find(r=>r.account===account);assert.equal(saved?.flex?.consistencyPercent,50);const withCheckpoint=JSON.parse(await(await server.backupResponse()).text());assert.equal(withCheckpoint.firmReferences.find((r:any)=>r.account===account).flex.consistencyPercent,50);assert.deepEqual((await server.loadJournal()).trades,before.trades);
});

test('firm payout imports persist, replay safely after bank reconciliation, and leave execution history unchanged',async()=>{
 const before=await server.loadJournal(),account=before.accounts.find(a=>/^LFF050/.test(a.account))!.account;
 const row={account,firmPayout:{firm:'Lucid',currency:'USD',amount:2000,requestedDate:'2026-06-18',approvedDate:'2026-06-21',status:'Paid',source:'Owner screenshot'}};
 const first=await server.importFirmPayouts({records:[row]});assert.equal(first.added,1);assert.equal(first.duplicates,0);
 const imported=(await server.loadJournal()).cash.find(r=>r.firmPayout?.source==='Owner screenshot')!;assert.equal(imported.received,null);assert.equal(imported.deduction,null);assert.equal(imported.date,'2026-06-21');
 await server.saveCash({...imported,received:1800,deduction:2000,note:'Bank match verified'});
 const replay=await server.importFirmPayouts({records:[row]});assert.equal(replay.added,0);assert.equal(replay.duplicates,1);
 await assert.rejects(()=>server.importFirmPayouts({records:[{...row,firmPayout:{...row.firmPayout,amount:1500}}]}),/differs/);
 await assert.rejects(()=>server.importFirmPayouts({records:[{...row,firmPayout:{...row.firmPayout,requestedDate:'2026-07-12',approvedDate:'2026-07-12'}},{...row,account:'UNKNOWN-PAYOUT-ACCOUNT'}]}),/not in this journal/);
 const after=await server.loadJournal();assert.equal(after.cash.length,before.cash.length+1);assert.equal(after.cash.find(r=>r.id===imported.id)?.received,1800);assert.deepEqual(after.trades,before.trades);assert.deepEqual(after.accounts,before.accounts);assert.deepEqual(after.firmReferences,before.firmReferences);
 const backup=JSON.parse(await(await server.backupResponse()).text()),saved=backup.cash.find((r:any)=>r.id===imported.id);assert.equal(saved.firmPayout.requestedDate,'2026-06-18');assert.equal(saved.firmPayout.approvedDate,'2026-06-21');assert.equal(saved.received,1800);
});

// Keep these integration scenarios after the seed-count tests above. Each uses
// its own account while exercising the real SQL archive and journal readers.
const integrationAccounts={archive:'LFF05000000000011',loss:'LFF05000000000012',late:'LFF05000000000013',offset:'LFF05000000000014',future:'LFF05000000000015'};
const integrationPayoutId='integration-metadata-payout';
let integrationImport=0x1000;
const {inferredPayoutSummary}=require('../lib/balance-adjustments')as typeof import('../lib/balance-adjustments');
const {KNOWN_FIRM_ADJUSTMENTS}=server;
const {reconstruct}=require('../lib/reconstruct')as typeof import('../lib/reconstruct');
function integrationCapture(account:string,cash:number|null,capturedAt:string){
 return {schemaVersion:1,mode:'AccountsReadOnly',recorderVersion:'0.4.2',capturedAt,running:true,scopePrefixes:['LFE','LFF'],accounts:[{account,currency:'USD',connected:true,connection:'Integration Lucid login',provider:'Rithmic',values:cash===null?{}:{CashValue:{value:cash,at:capturedAt,source:'PlatformRead'}},positionsAvailable:true,positions:[]}]};
}
async function integrationTrade(account:string,id:string,entry:string,exit:string,entryPrice:number,exitPrice:number){
 return server.importExecutions({source:'integration-'+id,checksum:(++integrationImport).toString(16).padStart(64,'0'),chunk:0,fills:[{account,id:id+'-entry',contract:'MNQ 2026-12',side:'Buy',qty:1,price:entryPrice,time:entry,pos:1},{account,id:id+'-exit',contract:'MNQ 2026-12',side:'Sell',qty:1,price:exitPrice,time:exit,pos:0}]});
}
async function withSettledClock<T>(work:()=>Promise<T>):Promise<T>{
 const original=Date.now,settled=original()+10*60000;Date.now=()=>settled;
 try{return await work();}finally{Date.now=original;}
}
function accountObservations(account:string){return sqlite.prepare('SELECT id,account,captured_at,origin,cash_value,data,received_at FROM account_observations WHERE account=? ORDER BY captured_at,id').all(account);}
function countTable(table:'account_observations'|'recorder_captures'){return Number(sqlite.prepare('SELECT COUNT(*) AS count FROM '+table).get()!.count);}
async function readPortableBackup(timeoutMs=5000):Promise<any>{
 const response=await server.backupResponse();assert.ok(response.body);const reader=response.body.getReader(),decoder=new TextDecoder();
 const reading=(async()=>{let text='';for(;;){const chunk=await reader.read();if(chunk.done)break;text+=decoder.decode(chunk.value,{stream:true});}return text+decoder.decode();})();
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{const text=await Promise.race([reading,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Portable backup did not complete within '+timeoutMs+' ms.')),timeoutMs);})]);return JSON.parse(text);}
 finally{if(timer)clearTimeout(timer);await reader.cancel().catch(()=>{});reader.releaseLock();}
}

test('immutable account captures replay without new observations or revision and conflicts roll back the archive atomically',async()=>{
 await withSettledClock(async()=>{
  const account=integrationAccounts.archive,at='2026-10-17T15:00:00.000Z',capture=integrationCapture(account,53000,at);
  assert.equal((await server.saveAccountState(capture)).accepted,true);
  const observations=accountObservations(account),counts=[countTable('account_observations'),countTable('recorder_captures')],revision=await server.loadJournalVersion(),state=await server.loadAccountState(),archive=sqlite.prepare('SELECT data,received_at FROM recorder_captures WHERE captured_at=?').get(at);
  assert.equal(observations.length,1);assert.equal((await server.saveAccountState(structuredClone(capture))).accepted,false);
  assert.deepEqual(accountObservations(account),observations);assert.deepEqual([countTable('account_observations'),countTable('recorder_captures')],counts);assert.deepEqual(await server.loadJournalVersion(),revision);
  const changed=integrationCapture(account,52000,at);await assert.rejects(()=>server.saveAccountState(changed),/conflicting account snapshot/i);
  const extra={...capture,accounts:[...capture.accounts,...integrationCapture('LFF05000000000017',50000,at).accounts]};await assert.rejects(()=>server.saveAccountState(extra),/conflicting account snapshot/i);
  assert.deepEqual(accountObservations(account),observations);assert.deepEqual([countTable('account_observations'),countTable('recorder_captures')],counts);assert.deepEqual(sqlite.prepare('SELECT data,received_at FROM recorder_captures WHERE captured_at=?').get(at),archive);
  assert.deepEqual(await server.loadAccountState(),state);assert.deepEqual(await server.loadJournalVersion(),revision);assert.equal(sqlite.prepare('SELECT account FROM account_status WHERE account=?').get('LFF05000000000017'),undefined);
 });
});

test('a late loss upload explains a previously inferred deduction without rewriting cash or immutable balance observations',async()=>{
 await withSettledClock(async()=>{
  const account=integrationAccounts.loss;
  await integrationTrade(account,'loss-baseline','2026-10-17T15:50:00Z','2026-10-17T15:51:00Z',100,100.5);
  await server.saveAccountState(integrationCapture(account,50000,'2026-10-17T16:00:00.000Z'));await server.saveAccountState(integrationCapture(account,49000,'2026-10-17T16:05:00.000Z'));
  const before=await server.loadJournal(),deduction=before.adjustments!.find(row=>row.account===account)!;assert.ok(deduction);assert.equal(deduction.amount,-1000);assert.equal(deduction.kind,'payout');
  const observations=accountObservations(account),revision=await server.loadJournalVersion(),baselineTrade=before.trades.find(trade=>trade.account===account)!;
  await integrationTrade(account,'late-loss','2026-10-17T16:01:00Z','2026-10-17T16:02:00Z',1000,500.5);
  const after=await server.loadJournal();assert.notEqual((await server.loadJournalVersion()).revision,revision.revision);assert.equal(after.adjustments!.some(row=>row.account===account),false);assert.deepEqual(after.cash,before.cash);assert.deepEqual(accountObservations(account),observations);
  assert.deepEqual(after.trades.find(trade=>trade.id===baselineTrade.id),baselineTrade);assert.equal(after.trades.filter(trade=>trade.account===account).length,2);assert.equal(after.realized!.filter(row=>row.account===account).reduce((total,row)=>total+row.net!,0),-1000);
  assert.deepEqual(inferredPayoutSummary(after.adjustments!.filter(row=>row.account===account)),{count:0,gross:0});
 });
});

test('a late intermediate capture supersedes its old deduction and owner label while retaining the latest native balance',async()=>{
 await withSettledClock(async()=>{
  const account=integrationAccounts.late;
  await integrationTrade(account,'late-capture-baseline','2026-10-17T16:50:00Z','2026-10-17T16:51:00Z',100,100.5);
  await server.saveAccountState(integrationCapture(account,50000,'2026-10-17T17:00:00.000Z'));await server.saveAccountState(integrationCapture(account,49000,'2026-10-17T17:10:00.000Z'));
  const original=await server.loadJournal(),old=original.adjustments!.find(row=>row.account===account)!;assert.equal(old.amount,-1000);
  await server.saveAdjustmentLabel({id:old.id,kind:'firm-adjustment',note:'Owner classification before late snapshot'});assert.equal((await server.loadJournal()).adjustments!.find(row=>row.id===old.id)?.source,'owner');
  const revision=await server.loadJournalVersion(),late=await server.saveAccountState(integrationCapture(account,49500,'2026-10-17T17:05:00.000Z'));assert.equal(late.accepted,false);assert.equal(late.capturedAt,'2026-10-17T17:10:00.000Z');assert.notEqual((await server.loadJournalVersion()).revision,revision.revision);
  const lateRevision=await server.loadJournalVersion(),archived=accountObservations(account);await server.saveAccountState(integrationCapture(account,49500,'2026-10-17T17:05:00.000Z'));assert.deepEqual(await server.loadJournalVersion(),lateRevision);assert.deepEqual(accountObservations(account),archived);
  const after=await server.loadJournal(),rows=after.adjustments!.filter(row=>row.account===account);assert.equal(rows.length,2);assert.equal(rows.some(row=>row.id===old.id),false);assert.deepEqual(rows.map(row=>row.amount),[-500,-500]);assert.equal(rows.every(row=>row.source==='automatic-estimate'),true);
  assert.deepEqual(inferredPayoutSummary(rows),{count:2,gross:1000});assert.deepEqual(after.cash,original.cash);assert.equal(accountObservations(account).length,3);
  const current=(await server.loadAccountState()).accounts.find(row=>row.account===account)!;assert.equal(current.values.CashValue?.value,49000);assert.equal(current.values.CashValue?.at,'2026-10-17T17:10:00.000Z');assert.ok(sqlite.prepare('SELECT id FROM balance_adjustment_labels WHERE id=?').get(old.id));
  await assert.rejects(()=>server.saveAdjustmentLabel({id:old.id,kind:'payout',note:'Stale interval'}),/superseded|no longer present/i);
 });
});

test('unchanged cash with offsetting profit still reveals a debit when the later capture arrives first and source times have six fractions',async()=>{
 await withSettledClock(async()=>{
  const account=integrationAccounts.offset,fills:Fill[]=[
   {id:'offset-entry',contract:'MNQ 2026-12',symbol:'MNQ',pv:2,side:'Buy',qty:1,price:1000,time:'2026-10-18T19:01:00.123456Z',pos:1,ordinal:1},
   {id:'offset-exit',contract:'MNQ 2026-12',symbol:'MNQ',pv:2,side:'Sell',qty:1,price:1500.5,time:'2026-10-18T19:02:00.654321Z',pos:0,ordinal:2},
  ],history=await reconstruct(account,fills),data=JSON.stringify(history),compact=history.trades.map(({parts:_,...trade})=>trade),summary={account,fills:fills.length,issues:history.issues,first:fills[0].time,last:fills[1].time};
  // A prior capture without CashValue must not prevent backfilling the earlier
  // real cash interval when that capture is uploaded after the later endpoint.
  await server.saveAccountState(integrationCapture(account,null,'2026-10-18T18:59:00.000Z'));
  sqlite.prepare('INSERT INTO account_history(account,data,trades_data,summary_data,revision,updated) VALUES (?,?,?,?,1,?)').run(account,data,JSON.stringify(compact),JSON.stringify(summary),new Date().toISOString());
  await server.saveAccountState(integrationCapture(account,53000,'2026-10-18T19:05:00.999Z'));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM execution_times WHERE account=?').get(account)!.count,0);
  await server.saveAccountState(integrationCapture(account,53000,'2026-10-18T19:00:00.123Z'));
  const indexed=sqlite.prepare('SELECT time FROM execution_times WHERE account=? ORDER BY time').all(account).map(row=>row.time);assert.deepEqual(indexed,['2026-10-18T19:01:00.123Z','2026-10-18T19:02:00.654Z']);
  const journal=await server.loadJournal(),rows=journal.adjustments!.filter(row=>row.account===account);assert.equal(rows.length,1);assert.equal(rows[0].before,53000);assert.equal(rows[0].after,53000);assert.equal(rows[0].tradingNet,1000);assert.equal(rows[0].amount,-1000);assert.equal(rows[0].kind,'payout');
  const current=(await server.loadAccountState()).accounts.find(row=>row.account===account)!;assert.equal(current.values.CashValue?.value,53000);assert.equal(current.values.RealizedProfitLoss,undefined);assert.equal(sqlite.prepare('SELECT data FROM account_history WHERE account=?').get(account)!.data,data);
 });
});

test('editing a payout note preserves its amount basis, split, approval timestamp and firm confirmation',async()=>{
 const account=integrationAccounts.archive,firmPayout={firm:'Lucid',currency:'USD',amount:1800,requestedDate:'2026-10-17',approvedDate:'2026-10-18',status:'Paid',source:'Integration firm confirmation'};
 const saved=await server.saveCash({id:integrationPayoutId,kind:'payout',date:'2026-10-18',account,deduction:2000,received:null,expense:null,note:'Original payout note',payoutAmountBasis:'trader-share',payoutSplit:.9,payoutApprovalAt:'2026-10-18T15:00:00.123456Z',firmPayout});
 const edited=await server.saveCash({id:saved.id,kind:'payout',date:saved.date,account,deduction:saved.deduction,received:saved.received,expense:null,note:'Edited payout note'});
 assert.equal(edited.note,'Edited payout note');assert.equal(edited.payoutAmountBasis,'trader-share');assert.equal(edited.payoutSplit,.9);assert.equal(edited.payoutApprovalAt,'2026-10-18T15:00:00.123Z');assert.deepEqual(edited.firmPayout,saved.firmPayout);assert.equal(edited.received,null);
 assert.deepEqual((await server.loadJournal()).cash.find(row=>row.id===saved.id),edited);
});

test('portable backups retain immutable observations, receipts, owner labels, execution indexes and unknown-amount notices without changing cash',async()=>{
 const before=await server.loadJournal(),observations=Number(sqlite.prepare('SELECT COUNT(*) AS count FROM account_observations').get()!.count),captures=Number(sqlite.prepare('SELECT COUNT(*) AS count FROM recorder_captures').get()!.count),backup=await readPortableBackup();
 assert.equal(backup.format,'tradebook-backup-v1');assert.equal(backup.balanceObservations.length,observations);assert.equal(backup.recorderCaptures.length,captures);assert.deepEqual(backup.cash,before.cash);assert.deepEqual(backup.firmAdjustments,KNOWN_FIRM_ADJUSTMENTS);assert.equal(backup.firmAdjustments.every((row:any)=>row.amount===null),true);
 const observation=backup.balanceObservations.find((row:any)=>row.account===integrationAccounts.archive&&row.origin==='capture');assert.equal(observation.state.values.CashValue.value,53000);assert.equal(observation.recorderVersion,'0.4.2');assert.ok(Number.isFinite(Date.parse(observation.receivedAt)));
 const capture=backup.recorderCaptures.find((row:any)=>row.capturedAt===observation.capturedAt);assert.equal(capture.running,true);assert.ok(capture.accountsSeen.includes(integrationAccounts.archive));assert.ok(Number.isFinite(Date.parse(capture.receivedAt)));
 assert.ok(backup.adjustmentLabels.some((row:any)=>row.note==='Owner classification before late snapshot'&&row.kind==='firm-adjustment'));
 assert.deepEqual(backup.executionTimes.filter((row:any)=>row.account===integrationAccounts.offset).map((row:any)=>row.time),['2026-10-18T19:01:00.123Z','2026-10-18T19:02:00.654Z']);
 const source=JSON.parse(String(sqlite.prepare('SELECT data FROM account_history WHERE account=?').get(integrationAccounts.offset)!.data));assert.deepEqual(backup.history.find((row:any)=>row.account===integrationAccounts.offset),source);assert.equal(source.fills[0].time,'2026-10-18T19:01:00.123456Z');
 const payout=backup.cash.find((row:any)=>row.id===integrationPayoutId);assert.equal(payout.payoutAmountBasis,'trader-share');assert.equal(payout.payoutSplit,.9);assert.equal(payout.payoutApprovalAt,'2026-10-18T15:00:00.123Z');assert.equal(payout.firmPayout.source,'Integration firm confirmation');assert.equal(payout.received,null);assert.deepEqual((await server.loadJournal()).cash,before.cash);
});

test('portable backups complete when all new source sections are empty and when observations contain exactly five hundred rows',async()=>{
 const cash=(await server.loadJournal()).cash;sqlite.exec('SAVEPOINT backup_pagination');
 try{
  for(const table of ['account_observations','recorder_captures','balance_adjustment_labels','execution_times'])sqlite.prepare('DELETE FROM '+table).run();
  const empty=await readPortableBackup();for(const section of ['balanceObservations','recorderCaptures','adjustmentLabels','executionTimes'])assert.deepEqual(empty[section],[]);assert.deepEqual(empty.cash,cash);
  const insert=sqlite.prepare('INSERT INTO account_observations(id,account,captured_at,origin,cash_value,data,received_at) VALUES (?,?,?,?,?,?,?)'),name='LFF05000000000018',start=Date.parse('2026-10-18T20:00:00.000Z');
  for(let index=0;index<500;index++){
   const at=new Date(start+index*1000).toISOString(),input=integrationCapture(name,50000,at).accounts[0],row={id:name+'@'+at,account:name,capturedAt:at,origin:'capture',recorderVersion:'0.4.2',running:true,state:{...input,capturedAt:at,positionsAt:at}};
   insert.run(row.id,name,at,'capture',50000,JSON.stringify(row),at);
  }
  const page=await readPortableBackup();assert.equal(page.balanceObservations.length,500);assert.equal(new Set(page.balanceObservations.map((row:any)=>row.id)).size,500);assert.equal(page.balanceObservations[499].receivedAt,'2026-10-18T20:08:19.000Z');
  for(const section of ['recorderCaptures','adjustmentLabels','executionTimes'])assert.deepEqual(page[section],[]);assert.deepEqual(page.cash,cash);assert.deepEqual(page.firmAdjustments,KNOWN_FIRM_ADJUSTMENTS);
 }finally{sqlite.exec('ROLLBACK TO backup_pagination');sqlite.exec('RELEASE backup_pagination');}
});

test('the journal version advances as future executions arrive and cached realized results refresh without another import',async()=>{
 const account=integrationAccounts.future,original=Date.now,start=Date.parse('2030-01-15T15:00:00.000Z');let clock=start;Date.now=()=>clock;
 try{
  await integrationTrade(account,'future-arrival',new Date(start+60000).toISOString(),new Date(start+120000).toISOString(),100,110);
  const before=await server.loadJournal(),pending=await server.loadJournalVersion();assert.equal(before.trades.some(trade=>trade.account===account),false);assert.equal(before.realized!.some(row=>row.account===account),false);
  clock=start+60001;assert.notEqual((await server.loadJournalVersion()).revision,pending.revision);
  const entry=await server.loadJournal(),waiting=await server.loadJournalVersion();assert.equal(entry.trades.some(trade=>trade.account===account),false);assert.equal(entry.realized!.find(row=>row.account===account)?.net,-.5);
  clock=start+120001;assert.notEqual((await server.loadJournalVersion()).revision,waiting.revision);
  const complete=await server.loadJournal();assert.equal(complete.trades.filter(trade=>trade.account===account).length,1);assert.equal(complete.realized!.find(row=>row.account===account)?.net,19);
 }finally{Date.now=original;sqlite.prepare('DELETE FROM account_history WHERE account=?').run(account);sqlite.prepare('DELETE FROM execution_times WHERE account=?').run(account);sqlite.prepare("DELETE FROM journal_meta WHERE key='next_future_fill'").run();}
 assert.equal(Date.now,original);
});

test('a journal read keeps its pre-boundary version when the clock crosses a future fill time during its queries',async()=>{
 const account='LFF05000000000016',original=Date.now,start=Date.parse('2031-01-15T15:00:00.000Z'),boundary=start+60000;Date.now=()=>start;
 try{
  await integrationTrade(account,'future-query-boundary',new Date(boundary).toISOString(),new Date(boundary+60000).toISOString(),100,110);
  await server.loadJournal();const pending=await server.loadJournalVersion(boundary-1);
  let reads=0;Date.now=()=>++reads===1?boundary-1:boundary+1;
  const crossing=await server.loadJournal();assert.equal(crossing.realized!.some(row=>row.account===account),false);assert.equal(crossing.trades.some(trade=>trade.account===account),false);assert.equal(crossing.revision,pending.revision);
  const arrived=await server.loadJournalVersion();assert.notEqual(arrived.revision,crossing.revision);
  const refreshed=await server.loadJournal();assert.equal(refreshed.realized!.find(row=>row.account===account)?.net,-.5);assert.equal(refreshed.trades.some(trade=>trade.account===account),false);
 }finally{
  // Finish the fixture's future ledger before removing it so its private cache
  // cannot leave a pending future timestamp behind for a subsequent test.
  Date.now=()=>boundary+60001;try{await server.loadJournal();}finally{Date.now=original;sqlite.prepare('DELETE FROM account_history WHERE account=?').run(account);sqlite.prepare('DELETE FROM execution_times WHERE account=?').run(account);sqlite.prepare("DELETE FROM journal_meta WHERE key='next_future_fill'").run();}
 }
 assert.equal(Date.now,original);
});


test('durable price batches deduplicate, reject atomic conflicts and preserve all journal records',async()=>{
 const before=await server.loadJournal(),version=await server.loadJournalVersion();
 const start=Date.parse('2026-10-01T14:00:00Z');
 const bars=Array.from({length:240},(_,i)=>({id:'MES 2026-12|'+(start+i*60000),contract:'MES 2026-12',start:start+i*60000,end:start+(i+1)*60000,open:6000,high:6002,low:5999,close:6001,volume:23,capturedAt:start+241*60000}));
 assert.equal((await prices.savePriceBars(bars)).confirmed,240);
 await prices.savePriceBars(bars);assert.equal((await prices.loadPriceBars('MES 2026-12',start,start+240*60000)).length,240);
 await prices.savePriceBars([{...bars[0],capturedAt:bars[0].capturedAt+120000}]);
 await prices.savePriceBars([{...bars[0],close:6002,capturedAt:bars[0].capturedAt+60000}]);assert.equal((await prices.loadPriceBars('MES 2026-12',start,start))[0].close,6001);
 const revised={...bars[0],close:6002,capturedAt:bars[0].capturedAt+180000};await prices.savePriceBars([revised]);
 await prices.savePriceBars([bars[0]]);assert.equal((await prices.loadPriceBars('MES 2026-12',start,start))[0].close,6002);
 const fresh={...bars[0],id:'NQ 2026-12|'+start,contract:'NQ 2026-12'};
 await assert.rejects(()=>prices.savePriceBars([fresh,...bars.slice(1,11),{...revised,close:6000}]),/Conflicting/);
 assert.equal((await prices.loadPriceBars('NQ 2026-12',start,start)).length,0);
 assert.equal((await prices.loadPriceBars('MES 2026-12',start,start))[0].close,6002);
 await assert.rejects(()=>prices.savePriceBars([{...bars[0],volume:-5}]));
 const exported=JSON.parse(await(await server.backupResponse()).text());assert.equal(exported.priceBars.length,240);assert.equal(exported.priceBars[0].contract,'MES 2026-12');
 // Cross two archive pages and a contract boundary without OFFSET rescans.
 await prices.savePriceBars(bars.map(b=>({...b,contract:'NQ 2026-12',id:'NQ 2026-12|'+b.start})));
 await prices.savePriceBars(bars.slice(0,21).map(b=>({...b,contract:'ES 2026-12',id:'ES 2026-12|'+b.start})));
 const paged=JSON.parse(await(await server.backupResponse()).text());assert.equal(paged.priceBars.length,501);assert.equal(new Set(paged.priceBars.map((b:any)=>b.id)).size,501);
 const after=await server.loadJournal();assert.deepEqual(after,before);assert.deepEqual(await server.loadJournalVersion(),version);
 sqlite.exec('DELETE FROM price_bars');
});


test('weekly-gap reads select only exact boundary minutes without mutating candle or financial records',async()=>{
 const before=await server.loadJournal(),version=await server.loadJournalVersion(),asOf=Date.parse('2026-10-20T15:00:00Z');
 const candle=(time:string,contract='NQ 2026-12')=>{const start=Date.parse(time);return {id:contract+'|'+start,contract,start,end:start+60000,open:100,high:102,low:99,close:101,volume:10,capturedAt:Date.parse('2026-10-20T14:59:00Z')};};
 const source=[candle('2026-10-16T20:59:00Z'),candle('2026-10-18T22:00:00Z'),candle('2026-10-16T20:58:00Z'),candle('2026-10-18T22:01:00Z'),candle('2026-10-18T22:00:00Z','MNQ 2026-12')];
 await prices.savePriceBars(source);
 const rows=await prices.loadWeeklyGapBars('NQ 2026-12',asOf);assert.deepEqual(rows.map(b=>b.start),source.slice(0,2).map(b=>b.start));
 const historical=await prices.loadWeeklyGapBars('NQ 2026-12',Date.parse('2026-10-16T20:00:00Z'));assert.equal(historical.length,0);
 await assert.rejects(()=>prices.loadWeeklyGapBars('NQ1!',asOf));await assert.rejects(()=>prices.loadWeeklyGapBars('NQ 2026-12',Date.now()+600000));
 assert.equal((await prices.loadPriceBars('NQ 2026-12',Date.parse('2026-10-16T20:58:00Z'),Date.parse('2026-10-18T22:01:00Z'))).length,4);
 assert.deepEqual(await server.loadJournal(),before);assert.deepEqual(await server.loadJournalVersion(),version);
 sqlite.exec('DELETE FROM price_bars');
});
test('entry-context batches use canonical first fills, are bounded, and do not mutate any stored records',async()=>{
 const contract='NQ 2026-12',entry='2026-10-20T15:00:30.123456Z',minute=Date.parse('2026-10-20T15:00:00Z');
 const candle=(start:number,open=112)=>({id:contract+'|'+start,contract,start,end:start+60000,open,high:open+1,low:open-1,close:open,volume:10,capturedAt:minute+60000});
 const source=[candle(Date.parse('2026-10-16T20:59:00Z'),100),candle(Date.parse('2026-10-18T22:00:00Z'),110),...Array.from({length:20},(_,i)=>candle(minute-(20-i)*60000))];
 await prices.savePriceBars(source);
 const refs:{account:string;id:string}[]=[];
 for(let i=0;i<20;i++){
   const account='LFF-GAP-SYNTHETIC-'+i;
   const fills:Fill[]=[{id:'entry-'+i,contract,symbol:'NQ',pv:20,time:entry,ordinal:1,side:'Buy',qty:1,price:111,pos:1},{id:'exit-'+i,contract,symbol:'NQ',pv:20,time:'2026-10-20T15:02:00Z',ordinal:2,side:'Sell',qty:1,price:112,pos:0}];
   const history=await reconstruct(account,fills);refs.push({account,id:history.trades[0].id});
   sqlite.prepare('INSERT INTO account_history(account,data,trades_data,summary_data,revision,updated) VALUES (?,?,\'[]\',\'{}\',1,?)').run(account,JSON.stringify(history),entry);
 }
 const snapshot=()=>sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>({table:row.name,rows:sqlite.prepare('SELECT * FROM "'+row.name+'" ORDER BY rowid').all()}));
 const before=snapshot(),start=preparedQueries.length;
 try{
   const result=await gapContext.loadGapContexts(refs.map(ref=>({...ref,pnl:999999,contract:'MES 2027-03',entryPrice:1})));
   assert.equal(result.rows.length,20);assert.equal(result.missing.length,0);assert.equal(preparedQueries.length-start,45);assert.ok(preparedQueries.slice(start).every(sql=>/^SELECT\b/.test(sql)));
   for(const row of result.rows){assert.equal(row.entryPrice,111);assert.equal(row.contract,contract);assert.equal(row.gross,20);assert.equal(row.net,16.5);assert.deepEqual(row.tags,['near-edge']);assert.equal(row.unavailableWeeks,row.checkedWeeks-1);}
   assert.deepEqual(snapshot(),before);
   const changed=await gapContext.loadGapContexts([{account:'UNKNOWN-SYNTHETIC',id:refs[0].id},refs[1]]);assert.deepEqual(changed.missing,[{account:'UNKNOWN-SYNTHETIC',id:refs[0].id}]);assert.equal(changed.rows.length,1);assert.equal(changed.rows[0].account,refs[1].account);
   const queries=preparedQueries.length;
   for(const input of [[],[...refs,refs[0]],[refs[0],refs[0]],[{account:'',id:'x'}],[null]])await assert.rejects(()=>gapContext.loadGapContexts(input));
   assert.equal(preparedQueries.length,queries);assert.deepEqual(snapshot(),before);
 }finally{
   for(const ref of refs)sqlite.prepare('DELETE FROM account_history WHERE account=?').run(ref.account);
   sqlite.exec('DELETE FROM price_bars');
 }
});

test('trendline entry lookup is canonical, bounded and read-only across 40 account references',async()=>{
  const accounts=Array.from({length:40},(_,i)=>'PILOT-SYNTHETIC-'+i),refs:{account:string;id:string}[]=[];
  try{
    for(const [i,account] of accounts.entries()){
      const entry='2026-10-19T15:30:00Z',contract='MNQ 2026-12';
      const fills:Fill[]=[{id:'entry-'+i,contract,symbol:'MNQ',pv:2,time:entry,ordinal:1,side:'Buy',qty:1,price:100,pos:1},{id:'scale-'+i,contract,symbol:'MNQ',pv:2,time:entry,ordinal:2,side:'Buy',qty:1,price:200,pos:2},{id:'exit-'+i,contract,symbol:'MNQ',pv:2,time:'2026-10-19T15:31:00Z',ordinal:3,side:'Sell',qty:2,price:210,pos:0}];
      const h:AccountHistory={account,fills,trades:(await reconstruct(account,fills)).trades,issues:[]};refs.push({account,id:h.trades[0].id});
      if(i===0)h.fills=h.fills.filter(f=>f.id!=='entry-'+i);
      if(i===1)h.trades[0].entry='2026-10-06T15:30:00Z';
      sqlite.prepare('INSERT INTO account_history(account,data,trades_data,summary_data,revision,updated) VALUES (?,?,?, ?,1,?)').run(account,JSON.stringify(h),JSON.stringify(h.trades),JSON.stringify({account,fills:h.fills.length,issues:[],first:entry,last:entry}),entry);
    }
    const before=await server.loadJournalVersion(),rowsBefore=sqlite.prepare('SELECT COUNT(*) AS n FROM trade_notes').get();preparedQueries.length=0;
    const report=await trendEntries.loadTrendEntries(refs);const queries=[...preparedQueries];
    assert.equal(report.rows.length,39);assert.equal(report.missing.length,1);assert.equal(report.missing[0].account,accounts[0]);assert.equal(report.rows.find(r=>r.account===accounts[1])!.entryPrice,100);
    assert.equal(report.rows.find(r=>r.account===accounts[2])!.entryPrice,100);assert.equal(report.rows.find(r=>r.account===accounts[2])!.dir,'Long');assert.equal(queries.length,10);assert.ok(queries.every(q=>q.startsWith('SELECT account,data')));
    assert.deepEqual(await server.loadJournalVersion(),before);assert.deepEqual(sqlite.prepare('SELECT COUNT(*) AS n FROM trade_notes').get(),rowsBefore);
    await assert.rejects(()=>trendEntries.loadTrendEntries([...refs,refs[0]]),/1 to 40/);
    await assert.rejects(()=>trendEntries.loadTrendEntries([refs[0],refs[0]]),/repeated/);
    await assert.rejects(()=>trendEntries.loadTrendEntries([{account:'',id:'x'}]),/required/);
  }finally{for(const account of accounts)sqlite.prepare('DELETE FROM account_history WHERE account=?').run(account);}
});


test('the journal supplies a post-payout execution split without rewriting cash, raw fills or completed trades',async()=>{
 await withSettledClock(async()=>{
  const account='LFF05000000000031',cut='2026-10-19T15:00:00.000Z';
  await integrationTrade(account,'cycle-earlier','2026-10-19T14:00:00Z','2026-10-19T14:01:00Z',100,200.5);
  await server.saveAccountState(integrationCapture(account,54000,'2026-10-19T14:59:00.000Z'));
  await server.saveAccountState(integrationCapture(account,52000,cut));
  await integrationTrade(account,'cycle-later','2026-10-19T15:01:00Z','2026-10-19T15:02:00Z',100,175.5);
  const raw=sqlite.prepare('SELECT data,trades_data FROM account_history WHERE account=?').get(account),cash=await server.loadJournal();
  const split=cash.realizedCheckpoints!.filter(row=>row.account===account);assert.equal(split.length,1);
  assert.equal(split[0].capturedAt,cut);assert.equal(split[0].net,200);assert.equal(split[0].afterNet,150);
  const {accountFlexProgress}=require('../lib/account-display')as typeof import('../lib/account-display');
  const progress=accountFlexProgress(account,cash);assert.equal(progress?.payout.days,1);assert.equal(progress?.payout.remaining,4);assert.equal(progress?.payout.payoutResetAt,cut);
  const again=await server.loadJournal();assert.deepEqual(again.cash,cash.cash);assert.deepEqual(again.trades,cash.trades);assert.deepEqual(again.realizedCheckpoints,cash.realizedCheckpoints);assert.deepEqual(sqlite.prepare('SELECT data,trades_data FROM account_history WHERE account=?').get(account),raw);
 });
});

test('funded native progress and payout reconciliation bypass bad execution position metadata without rewriting history',async()=>{
 await withSettledClock(async()=>{
  const account='LFF05000000000041',time=(m:number)=>'2026-10-20T18:'+String(m).padStart(2,'0')+':00.000Z';
  const incoming=[{id:'native-entry',side:'Buy',qty:1,price:100,pos:1,m:0},{id:'native-exit',side:'Sell',qty:1,price:180,pos:0,m:1},{id:'native-stale-position',side:'Buy',qty:5,price:200,pos:7,m:3},{id:'native-partial',side:'Sell',qty:3,price:220,pos:4,m:4}].map(f=>({...f,account,contract:'MNQ 2026-12',time:time(f.m)}));
  await server.importExecutions({source:'native-cycle-integration',checksum:(++integrationImport).toString(16).padStart(64,'0'),chunk:0,fills:incoming});
  const snapshot=(m:number,net:number,cash=50000+net)=>{const c=integrationCapture(account,cash,time(m));(c.accounts[0].values as any).RealizedProfitLoss={value:net,at:time(m),source:'PlatformRead'};return c;};
  await server.saveAccountState(snapshot(2,159));await server.saveAccountState(snapshot(3,156.5));await server.saveAccountState(snapshot(4,275));
  const raw=sqlite.prepare('SELECT data,trades_data FROM account_history WHERE account=?').get(account),data=await server.loadJournal();
  assert.equal(data.adjustments!.some(r=>r.account===account),false);assert.equal(data.reportedSessions!.find(r=>r.account===account)?.net,275);
  const {accountFlexProgress}=require('../lib/account-display')as typeof import('../lib/account-display');assert.equal(accountFlexProgress(account,data)?.payout.days,1);
  const revision=await server.loadJournalVersion();await server.saveAccountState(snapshot(5,274,50275));assert.notEqual((await server.loadJournalVersion()).revision,revision.revision);
  await server.saveAccountState(snapshot(6,274,48275));const paid=await server.loadJournal(),reset=paid.adjustments!.find(r=>r.account===account&&r.amount===-2000)!;assert.ok(reset);
  assert.equal(paid.reportedCheckpoints!.find(r=>r.account===account&&r.capturedAt===time(6))?.afterNet,0);assert.equal(accountFlexProgress(account,paid)?.payout.days,0);
  assert.deepEqual(sqlite.prepare('SELECT data,trades_data FROM account_history WHERE account=?').get(account),raw);assert.deepEqual(paid.cash,data.cash);assert.deepEqual(paid.trades,data.trades);
 });
});

test('late native snapshots reconcile a position-metadata disagreement from an earlier flat capture without manual counts or history writes',async()=>{
 await withSettledClock(async()=>{
  const account='LFF05000000000042',time=(m:number)=>'2026-10-20T14:'+String(m).padStart(2,'0')+':00.000Z';
  await server.saveAccountState(integrationCapture(account,50000,'2026-10-19T21:50:00.000Z'));
  const fills=[{id:'flat-entry',side:'Buy',qty:1,price:100,pos:1,m:0},{id:'flat-exit',side:'Sell',qty:1,price:180,pos:0,m:1},{id:'disputed-entry',side:'Buy',qty:5,price:200,pos:7,m:3},{id:'disputed-exit',side:'Sell',qty:5,price:210,pos:2,m:4}].map(fill=>({...fill,account,contract:'MNQ 2026-12',time:time(fill.m)}));
  await server.importExecutions({source:'flat-inventory-integration',checksum:(++integrationImport).toString(16).padStart(64,'0'),chunk:0,fills});
  const snapshot=(m:number,cash:number)=>{const capture=integrationCapture(account,cash,time(m));(capture.accounts[0].values as any).RealizedProfitLoss={value:254,at:time(m),source:'PlatformRead'};return capture;};
  const original=sqlite.prepare('SELECT data,trades_data FROM account_history WHERE account=?').get(account),cashBefore=(await server.loadJournal()).cash;
  await server.saveAccountState(snapshot(6,50254));const journal=await server.loadJournal();
  assert.equal(journal.reportedSessions!.find(row=>row.account===account)?.net,254);assert.equal(journal.realizedSessions!.find(row=>row.account===account)?.net,254);assert.equal(journal.adjustments!.some(row=>row.account===account),false);
  const {accountFlexProgress}=require('../lib/account-display')as typeof import('../lib/account-display');assert.equal(accountFlexProgress(account,journal)?.payout.days,1);assert.equal(accountFlexProgress(account,journal)?.payout.cycleProfit,254);
  assert.equal('projections' in journal,false);assert.equal('reconciledEvents' in journal,false);
  await server.saveAccountState(snapshot(7,48254));const paid=await server.loadJournal(),deduction=paid.adjustments!.find(row=>row.account===account&&row.amount===-2000);assert.ok(deduction);assert.equal(deduction.kind,'payout');assert.equal(accountFlexProgress(account,paid)?.payout.days,0);
  assert.deepEqual(sqlite.prepare('SELECT data,trades_data FROM account_history WHERE account=?').get(account),original);assert.deepEqual(paid.cash,cashBefore);
 });
});

test('native idle reset recovery retains a finished session but a saved disappearance blocks it after reconnect',async()=>{
 await withSettledClock(async()=>{
  const account='LFF05000000000043',time=(m:number)=>'2026-10-21T14:'+String(m).padStart(2,'0')+':00.000Z';
  await server.saveAccountState(integrationCapture(account,50000,time(0)));
  await integrationTrade(account,'idle-counter',time(1),time(2),100,180);
  const snapshot=(m:number,net:number)=>{const capture=integrationCapture(account,50159,time(m));(capture.accounts[0].values as any).RealizedProfitLoss={value:net,at:time(m),source:'PlatformRead'};return capture;};
  await server.saveAccountState(snapshot(3,159));
  const before=await server.loadJournal(),raw=sqlite.prepare('SELECT data,trades_data FROM account_history WHERE account=?').get(account);
  await server.saveAccountState(snapshot(4,0));const idle=await server.loadJournal();assert.equal(idle.reportedSessions!.find(row=>row.account===account)?.net,159);
  await server.saveAccountState({...snapshot(5,0),accounts:[]});await server.saveAccountState(snapshot(6,0));
  assert.ok(accountObservations(account).some(row=>row.origin==='not-seen'));
  const reappeared=await server.loadJournal();assert.equal(reappeared.reportedSessions!.some(row=>row.account===account),false);
  assert.deepEqual(reappeared.cash,before.cash);assert.deepEqual(sqlite.prepare('SELECT data,trades_data FROM account_history WHERE account=?').get(account),raw);
 });
});

test('evaluation breach evidence refreshes on floating loss and survives disappearance without changing source history or manual profiles',async()=>{
 const account='LFE05000000000991',before=await server.loadJournal(),at='2026-10-22T14:00:00.000Z';
 const snapshot=(capturedAt:string,cash:number,floating:number,positions:any[]=[])=>({schemaVersion:1,mode:'AccountsReadOnly',recorderVersion:'0.5.0',capturedAt,running:true,scopePrefixes:['LFE','LFF'],accounts:[{account,currency:'USD',connected:true,connection:'Synthetic',provider:'Synthetic',values:{CashValue:{value:cash,at:capturedAt,source:'PlatformRead'},UnrealizedProfitLoss:{value:floating,at:capturedAt,source:'PlatformRead'}},positionsAvailable:true,positions}]});
 await server.saveAccountState(snapshot(at,50000,0));
 await server.saveProfile({account,label:'Synthetic retained label',stage:'Evaluation',status:'Active',notes:'Preserve this profile'});
 const profileBefore=(await server.loadJournal()).profiles.find(p=>p.account===account),revision=await server.loadJournalVersion();
 await server.saveAccountState(snapshot('2026-10-22T14:01:00.000Z',50000,-2001,[{instrument:'MNQ 12-26',side:'Long',quantity:1,averagePrice:30000}]));
 assert.notEqual((await server.loadJournalVersion()).revision,revision.revision);
 let result=await server.loadJournal(),failure=result.evaluationFailures!.find(p=>p.account===account)!;
 assert.equal(failure.balance,47999);assert.equal(failure.source,'cash-and-floating');assert.equal(failure.floor,48000);
 const replay=await server.loadJournalVersion();await server.saveAccountState(snapshot('2026-10-22T14:01:00.000Z',50000,-2001,[{instrument:'MNQ 12-26',side:'Long',quantity:1,averagePrice:30000}]));assert.equal((await server.loadJournalVersion()).revision,replay.revision);
 await server.saveAccountState({...snapshot('2026-10-22T14:02:00.000Z',50000,0),accounts:[]});
 result=await server.loadJournal();assert.deepEqual(result.evaluationFailures!.find(p=>p.account===account),failure);
 assert.deepEqual(result.profiles.find(p=>p.account===account),profileBefore);assert.deepEqual(result.trades,before.trades);assert.deepEqual(result.cash,before.cash);assert.deepEqual(result.notes,before.notes);
 const backup=JSON.parse(await(await server.backupResponse()).text());assert.ok(backup.balanceObservations.some((o:any)=>o.account===account&&o.state.values.UnrealizedProfitLoss?.value===-2001));
});

test('session and provider changes refresh journal verification while identical heartbeats stay lightweight',async()=>{
 const account='LFF05000000000994';
 const snapshot=(capturedAt:string,provider='Synthetic')=>({schemaVersion:1,mode:'AccountsReadOnly',recorderVersion:'0.5.0',capturedAt,running:true,scopePrefixes:['LFF'],accounts:[{account,currency:'USD',connected:true,connection:'Synthetic',provider,values:{CashValue:{value:50000,at:capturedAt,source:'PlatformRead'},RealizedProfitLoss:{value:0,at:capturedAt,source:'PlatformRead'}},positionsAvailable:true,positions:[]}]});
 await server.saveAccountState(snapshot('2026-10-26T21:58:00.000Z'));const before=await server.loadJournalVersion();
 await server.saveAccountState(snapshot('2026-10-26T21:59:00.000Z'));assert.equal((await server.loadJournalVersion()).revision,before.revision);
 await server.saveAccountState(snapshot('2026-10-26T22:00:00.000Z'));const session=await server.loadJournalVersion();assert.notEqual(session.revision,before.revision);
 await server.saveAccountState(snapshot('2026-10-26T22:01:00.000Z','Other'));assert.notEqual((await server.loadJournalVersion()).revision,session.revision);
});

test('legacy merged source remains in backup and the first immutable baseline even when current fields are unavailable',async()=>{
 const account='LFF05000000000995',capturedAt='2026-10-26T21:00:00.000Z',old='2026-10-23T21:00:00.000Z';
 const legacy={account,capturedAt,currency:'USD',connected:false,connection:'Legacy',provider:'Synthetic',values:{CashValue:{value:51234,at:old,source:'PlatformRead'},RealizedProfitLoss:{value:1234,at:old,source:'PlatformRead'}},positions:[{instrument:'MNQ 12-26',side:'Long',quantity:1,averagePrice:100}],positionsAvailable:false,positionsAt:old};
 sqlite.prepare('INSERT INTO account_status(account,captured_at,data) VALUES (?,?,?)').run(account,capturedAt,JSON.stringify(legacy));
 assert.deepEqual((await server.loadAccountState()).accounts.find(row=>row.account===account)!.values,{});
 const backup=JSON.parse(await(await server.backupResponse()).text());assert.deepEqual(backup.accountState.accounts.find((row:any)=>row.account===account),legacy);
 assert.equal(accountObservations(account).length,0);
 const next='2026-10-27T12:59:00.000Z';
 await server.saveAccountState({schemaVersion:1,mode:'AccountsReadOnly',recorderVersion:'0.5.0',capturedAt:next,running:true,scopePrefixes:['LFF'],accounts:[{...legacy,capturedAt:undefined,connected:true,values:{CashValue:{value:51234,at:next,source:'PlatformRead'}},positionsAvailable:true,positions:[]}]});
 const archived=accountObservations(account).find(row=>row.origin==='legacy')!;assert.ok(archived);assert.deepEqual(JSON.parse(String(archived.data)).state,legacy);
 const current=(await server.loadAccountState()).accounts.find(row=>row.account===account)!;assert.equal(current.values.CashValue?.value,51234);assert.equal(current.values.RealizedProfitLoss,undefined);
 assert.deepEqual(JSON.parse(String(accountObservations(account).find(row=>row.origin==='legacy')!.data)).state,legacy);
});

test('next-session omissions, explicit zeros and reconnects replace current state while verified historical net stays intact',async()=>{
 const account='LFF05000000000993',at='2026-10-26T20:00:00.000Z';
 const snapshot=(capturedAt:string,net:number|null,cash=50099)=>({schemaVersion:1,mode:'AccountsReadOnly',recorderVersion:'0.5.0',capturedAt,running:true,scopePrefixes:['LFE','LFF'],accounts:[{account,currency:'USD',connected:true,connection:'Snapshot test',provider:'Synthetic',values:{CashValue:{value:cash,at:capturedAt,source:'PlatformRead'},...(net!==null?{RealizedProfitLoss:{value:net,at:capturedAt,source:'PlatformRead'}}:{}),UnrealizedProfitLoss:{value:0,at:capturedAt,source:'PlatformRead'}},positionsAvailable:true,positions:[]}]});
 await server.saveAccountState(snapshot('2026-10-25T20:00:00.000Z',0,50000));
 await server.importExecutions({source:'snapshot-regression',checksum:'d'.repeat(64),chunk:0,fills:[{account,id:'snapshot-entry',contract:'MNQ 2026-12',side:'Buy',qty:1,price:100,time:'2026-10-26T14:00:00Z',pos:1},{account,id:'snapshot-exit',contract:'MNQ 2026-12',side:'Sell',qty:1,price:150,time:'2026-10-26T14:01:00Z',pos:0}]});
 await server.saveAccountState(snapshot(at,99));
 const before=await server.loadJournal(),history=sqlite.prepare('SELECT data,trades_data FROM account_history WHERE account=?').get(account),source=accountObservations(account).find(row=>row.captured_at===at)!;
 assert.ok(source);
 assert.equal(before.reportedSessions!.find(row=>row.account===account&&row.day==='2026-10-26')?.net,99);
 const state=()=>server.loadAccountState().then(data=>data.accounts.find(row=>row.account===account)!);
 const next='2026-10-27T13:00:00.000Z';await server.saveAccountState(snapshot(next,null));
 assert.equal((await state()).values.CashValue?.value,50099);assert.equal((await state()).values.RealizedProfitLoss,undefined);
 assert.equal((await server.saveAccountState(snapshot(next,null))).accepted,false);
 // Late observations are archived but never roll back the current account.
 assert.equal((await server.saveAccountState(snapshot('2026-10-26T20:01:00.000Z',99))).accepted,false);
 assert.equal((await state()).capturedAt,next);assert.equal((await state()).values.RealizedProfitLoss,undefined);
 let revision=await server.loadJournalVersion();await server.saveAccountState(snapshot('2026-10-27T13:01:00.000Z',0));
 assert.equal((await state()).values.RealizedProfitLoss?.value,0);assert.notEqual((await server.loadJournalVersion()).revision,revision.revision);
 revision=await server.loadJournalVersion();await server.saveAccountState(snapshot('2026-10-27T13:02:00.000Z',null));
 assert.equal((await state()).values.RealizedProfitLoss,undefined);assert.notEqual((await server.loadJournalVersion()).revision,revision.revision);
 const disconnected:any=snapshot('2026-10-27T13:03:00.000Z',null);Object.assign(disconnected.accounts[0],{connected:false,currency:'Unknown',values:{},positionsAvailable:false});
 await server.saveAccountState(disconnected);assert.deepEqual((await state()).values,{});assert.equal((await state()).currency,'Unknown');
 await server.saveAccountState(snapshot('2026-10-27T13:04:00.000Z',null));assert.equal((await state()).values.RealizedProfitLoss,undefined);assert.equal((await state()).positionsAvailable,true);
 const after=await server.loadJournal();assert.equal(after.reportedSessions!.find(row=>row.account===account&&row.day==='2026-10-26')?.net,99);
 assert.deepEqual(after.cash,before.cash);assert.deepEqual(after.profiles,before.profiles);assert.deepEqual(after.trades,before.trades);
 assert.deepEqual(sqlite.prepare('SELECT data,trades_data FROM account_history WHERE account=?').get(account),history);assert.deepEqual(accountObservations(account).find(row=>row.captured_at===at),source);
 const raw=JSON.parse(String(sqlite.prepare('SELECT data FROM account_status WHERE account=?').get(account)!.data));assert.equal(raw.values.RealizedProfitLoss,undefined);
 // Pre-fix merged status rows are safe immediately on read, with no rewrite
 // of immutable observations or dependence on another recorder upload.
 raw.values.RealizedProfitLoss={value:99,at,source:'PlatformRead'};raw.positionsAvailable=true;raw.positionsAt=at;raw.positions=[{instrument:'MNQ 12-26',side:'Long',quantity:1,averagePrice:100}];
 sqlite.prepare('UPDATE account_status SET data=? WHERE account=?').run(JSON.stringify(raw),account);
 assert.equal((await state()).values.RealizedProfitLoss,undefined);assert.equal((await state()).positionsAvailable,false);assert.deepEqual((await state()).positions,[]);
 assert.equal(JSON.parse(String(sqlite.prepare('SELECT data FROM account_status WHERE account=?').get(account)!.data)).values.RealizedProfitLoss.value,99);
});

test('overlapping uploads compare revision and settlement evidence against the committed current snapshot',async()=>{
 const account='LFF05000000000996',snapshot=(capturedAt:string,net:number)=>({schemaVersion:1,mode:'AccountsReadOnly',recorderVersion:'0.5.0',capturedAt,running:true,scopePrefixes:['LFF'],accounts:[{account,currency:'USD',connected:true,connection:'Concurrent test',provider:'Synthetic',values:{CashValue:{value:50159,at:capturedAt,source:'PlatformRead'},RealizedProfitLoss:{value:net,at:capturedAt,source:'PlatformRead'}},positionsAvailable:true,positions:[]}]});
 await server.saveAccountState(snapshot('2026-10-27T13:10:00.000Z',159));
 const originalBatch=database.batch;
 let releaseA!:()=>void,releaseB!:()=>void,enteredA!:()=>void,enteredB!:()=>void;
 const gateA=new Promise<void>(resolve=>releaseA=resolve),gateB=new Promise<void>(resolve=>releaseB=resolve),readyA=new Promise<void>(resolve=>enteredA=resolve),readyB=new Promise<void>(resolve=>enteredB=resolve);
 let calls=0;
 database.batch=async statements=>{const call=++calls;if(call===1){enteredA();await gateA;}if(call===2){enteredB();await gateB;}return originalBatch(statements);};
 try{
  const a=server.saveAccountState(snapshot('2026-10-27T13:11:00.000Z',200));await readyA;
  const b=server.saveAccountState(snapshot('2026-10-27T13:12:00.000Z',159));await readyB;
  releaseA();await a;const intermediate=await server.loadJournalVersion();
  // Both requests read 159 before either batch committed. B must still notice
  // A's committed 200, even if the settlement clock is deliberately old.
  sqlite.prepare("UPDATE journal_meta SET value='2026-10-20T00:00:00.000Z' WHERE key='last_balance_change'").run();
  releaseB();await b;assert.notEqual((await server.loadJournalVersion()).revision,intermediate.revision);
  const current=(await server.loadAccountState()).accounts.find(row=>row.account===account)!;assert.equal(current.values.RealizedProfitLoss?.value,159);
  assert.notEqual(sqlite.prepare("SELECT value FROM journal_meta WHERE key='last_balance_change'").get()!.value,'2026-10-20T00:00:00.000Z');
 }finally{releaseA();releaseB();database.batch=originalBatch;}
});

test('unchanged native amounts refresh newly verified zero-net trading, including histories without a legacy time index',async()=>{
 for(const [i,indexed]of [true,false].entries()){
  const account='LFF0500000000099'+(7+i),base=Date.parse(i===0?'2026-10-27T13:20:00.000Z':'2026-10-27T13:30:00.000Z'),time=(minute:number)=>new Date(base+minute*60000).toISOString();
  const snapshot=(capturedAt:string,net:number,cash:number)=>({schemaVersion:1,mode:'AccountsReadOnly',recorderVersion:'0.5.0',capturedAt,running:true,scopePrefixes:['LFF'],accounts:[{account,currency:'USD',connected:true,connection:'Verification test',provider:'Synthetic',values:{CashValue:{value:cash,at:capturedAt,source:'PlatformRead'},RealizedProfitLoss:{value:net,at:capturedAt,source:'PlatformRead'}},positionsAvailable:true,positions:[]}]});
  await server.saveAccountState(snapshot(time(-3),0,50000));
  const fill=(id:string,minute:number,side:string,price:number,pos:number)=>({account,id,contract:'MNQ 2026-12',side,qty:1,price,time:time(minute),pos});
  await server.importExecutions({source:'snapshot-verification-initial-'+i,checksum:String(5+i).repeat(64),chunk:0,fills:[fill('clean-entry',-2,'Buy',100,1),fill('clean-exit',-1,'Sell',180,0)]});
  await server.saveAccountState(snapshot(time(0),159,50159));
  assert.equal((await server.loadJournal()).reportedSessions!.find(row=>row.account===account)?.net,159);
  await server.importExecutions({source:'snapshot-verification-disputed-'+i,checksum:String(7+i).repeat(64),chunk:0,fills:[fill('disputed-entry',1,'Buy',200,2),fill('disputed-exit',2,'Sell',200.5,1)]});
  assert.equal((await server.loadJournal()).reportedSessions!.find(row=>row.account===account)?.net,159);
  if(!indexed)sqlite.prepare('DELETE FROM execution_times WHERE account=?').run(account);
  const before=await server.loadJournalVersion();await server.saveAccountState(snapshot(time(3),159,50159));
  assert.notEqual((await server.loadJournalVersion()).revision,before.revision);
  assert.equal((await server.loadJournal()).reportedSessions!.find(row=>row.account===account)?.net,159);
  const settled=await server.loadJournalVersion();await server.saveAccountState(snapshot(time(4),159,50159));assert.equal((await server.loadJournalVersion()).revision,settled.revision);
 }
});

test('legacy summaries are replaced only in read projections and restored trade IDs support reviews and charts',async()=>{
 const account='UNIFIED-LEGACY-SOURCE',contract='MNQ 2026-12',time=(m:number)=>new Date(Date.UTC(2026,9,20,14,m)).toISOString();
 const fills:Fill[]=[{id:'a',side:'Buy',qty:3,price:100,pos:3},{id:'b',side:'Sell',qty:3,price:110,pos:0},{id:'c',side:'Buy',qty:3,price:100,pos:5},{id:'d',side:'Sell',qty:1,price:105,pos:4},{id:'e',side:'Sell',qty:2,price:110,pos:2}].map((fill,ordinal)=>({...fill,side:fill.side as 'Buy'|'Sell',contract,symbol:'MNQ',pv:2,time:time(ordinal),ordinal}));
 const current=await reconstruct(account,fills),legacy={...current,trades:current.trades.slice(0,1),issues:[{contract,time:time(2),remaining:2,reason:'Position discontinuity: missing or inconsistent executions'}]};
 const summary={account,fills:fills.length,issues:legacy.issues,first:time(0),last:time(4)};
 sqlite.prepare('INSERT INTO account_history(account,data,trades_data,summary_data,revision,updated) VALUES (?,?,?,?,1,?)').run(account,JSON.stringify(legacy),JSON.stringify(legacy.trades),JSON.stringify(summary),time(4));
 const source=sqlite.prepare('SELECT data,trades_data,summary_data FROM account_history WHERE account=?').get(account);
 try{
  const journal=await server.loadJournal(),trades=journal.trades.filter(t=>t.account===account),rows=journal.realized!.filter(row=>row.account===account);
  assert.equal(trades.length,2);assert.equal(trades.reduce((s,t)=>s+t.pnl,0),110);assert.equal(rows.reduce((s,row)=>s+row.gross,0),110);assert.equal(journal.accounts.find(a=>a.account===account)!.issues.length,0);
  assert.equal(trades[0].id,legacy.trades[0].id);const restored=current.trades[1];
  assert.equal((await server.getTrade(account,restored.id))!.trade.pnl,50);
  await server.saveTradeNote({account,id:restored.id,setup:'Reviewed restored entry',plan:'Yes',note:'Source preserved'});
  assert.equal((await server.loadJournal()).notes.find(n=>n.id===restored.id)!.setup,'Reviewed restored entry');
  assert.equal((await gapContext.loadGapContexts([{account,id:restored.id}])).missing.length,0);
  assert.equal((await trendEntries.loadTrendEntries([{account,id:restored.id}])).missing.length,0);
  assert.deepEqual(sqlite.prepare('SELECT data,trades_data,summary_data FROM account_history WHERE account=?').get(account),source);
  // A reviewed restored ID exists only in the read projection until an import.
  // Backfill changes its grouping; the review must remain on the prior trade.
  await server.importExecutions({source:'late-unified-grouping',checksum:(++integrationImport).toString(16).padStart(64,'0'),chunk:0,fills:[{account,id:'late-entry',contract,side:'Buy',qty:1,price:90,time:'2026-10-20T14:01:30.000Z',pos:1},{account,id:'late-exit',contract,side:'Sell',qty:1,price:115,time:time(5),pos:0}]});
  const regrouped=await server.loadJournal();assert.equal(regrouped.trades.some(t=>t.id===restored.id),false);assert.equal(regrouped.notes.find(n=>n.id===restored.id)!.setup,'Reviewed restored entry');assert.equal((await server.getTrade(account,restored.id))!.trade.pnl,50);
  const saved=JSON.parse(String(sqlite.prepare('SELECT data FROM account_history WHERE account=?').get(account)!.data));assert.ok(saved.supersededTrades.some((t:any)=>t.id===restored.id));
 }finally{sqlite.prepare('DELETE FROM trade_notes WHERE account=?').run(account);sqlite.prepare('DELETE FROM account_history WHERE account=?').run(account);}
});

test('superseded trade IDs and notes survive later imports without entering current trading totals',async()=>{
 const account='UNIFIED-ARCHIVED-IDENTITY',fills:Fill[]=[{id:'a',side:'Buy',price:100,pos:1},{id:'b',side:'Sell',price:110,pos:0}].map((f,ordinal)=>({...f,side:f.side as 'Buy'|'Sell',qty:1,contract:'MNQ 2026-12',symbol:'MNQ',pv:2,time:new Date(Date.UTC(2026,9,20,14,ordinal)).toISOString(),ordinal}));
 const current=await reconstruct(account,fills),oldTrade={...current.trades[0],id:'legacy-superseded-identity',pnl:999},legacy={...current,trades:[...current.trades,oldTrade]};
 sqlite.prepare('INSERT INTO account_history(account,data,trades_data,summary_data,revision,updated) VALUES (?,?,?,?,1,?)').run(account,JSON.stringify(legacy),JSON.stringify(legacy.trades),JSON.stringify({account,fills:2,issues:[],first:fills[0].time,last:fills[1].time}),fills[1].time);
 try{
  await server.saveTradeNote({account,id:oldTrade.id,setup:'Legacy review',plan:'',note:'Keep this identity'});
  for(let i=0;i<2;i++)await server.importExecutions({source:'later-unified-'+i,checksum:(++integrationImport).toString(16).padStart(64,'0'),chunk:0,fills:[{account,id:'new-'+i,contract:'MNQ 2026-12',side:i?'Sell':'Buy',qty:1,price:i?120:110,time:new Date(Date.UTC(2026,9,20,14,2+i)).toISOString(),pos:i?0:1}]});
  assert.equal((await server.getTrade(account,oldTrade.id))!.trade.pnl,999);
  const journal=await server.loadJournal();assert.equal(journal.notes.find(n=>n.id===oldTrade.id)!.setup,'Legacy review');assert.equal(journal.trades.filter(t=>t.account===account).reduce((s,t)=>s+t.pnl,0),40);
  const saved=JSON.parse(String(sqlite.prepare('SELECT data FROM account_history WHERE account=?').get(account)!.data));assert.equal(saved.supersededTrades[0].id,oldTrade.id);assert.deepEqual(saved.fills.slice(0,2),fills);
 }finally{sqlite.prepare('DELETE FROM trade_notes WHERE account=?').run(account);sqlite.prepare('DELETE FROM account_history WHERE account=?').run(account);}
});

test('an earlier as-of read rejects a later cached ledger instead of inheriting its resolved coverage',async()=>{
 const account='LFF-UNIFIED-ASOF-CACHE',fills:Fill[]=[{id:'a',side:'Buy',qty:1,price:100,pos:1},{id:'b',side:'Sell',qty:3,price:110,pos:0},{id:'c',side:'Buy',qty:2,price:120,pos:0}].map((f,ordinal)=>({...f,side:f.side as 'Buy'|'Sell',contract:'MNQ 2026-12',symbol:'MNQ',pv:2,time:new Date(Date.UTC(2026,9,20,14,ordinal)).toISOString(),ordinal}));
 const history=await reconstruct(account,fills);
 sqlite.prepare('INSERT INTO account_history(account,data,trades_data,summary_data,revision,updated) VALUES (?,?,?,?,1,?)').run(account,JSON.stringify(history),JSON.stringify(history.trades),JSON.stringify({account,fills:3,issues:[],first:fills[0].time,last:fills[2].time}),fills[2].time);
 try{
  await server.loadJournal();assert.ok(server.cachedRealizedEvents(account,1,Date.now()));
  assert.equal(server.cachedRealizedEvents(account,1,Date.parse(fills[1].time)),null);
  const {realizedEvents}=require('../lib/realized')as typeof import('../lib/realized');
  assert.equal(realizedEvents(account,fills.slice(0,2))[1].net,null);assert.notEqual(realizedEvents(account,fills)[1].net,null);
 }finally{sqlite.prepare('DELETE FROM account_history WHERE account=?').run(account);}
});
