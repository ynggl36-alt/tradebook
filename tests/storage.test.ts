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
const database={prepare:(sql:string)=>new Statement(sql),batch:async(statements:Statement[])=>{sqlite.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
const syntheticSeed=JSON.parse(fs.readFileSync('tests/fixtures/synthetic-history.json','utf8'));
const originalLoad=(Module as any)._load;
(Module as any)._load=function(name:string,...rest:any[]){if(name.endsWith('/data/initial-history.json'))return syntheticSeed;if(name==='cloudflare:workers')return {env:{DB:database}};return originalLoad.call(this,name,...rest);};
const server=require('../lib/server-journal')as typeof import('../lib/server-journal');
const prices=require('../lib/server-prices')as typeof import('../lib/server-prices');

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


test('account monitor persists real balances and last-known positions without changing trading history or inferring payouts',async()=>{
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
 state=await server.loadAccountState();assert.equal(state.accounts[0].values.CashValue?.value,50000);assert.equal(state.accounts[0].values.UnrealizedProfitLoss?.at,t);assert.equal(state.accounts[0].positions.length,0);
 const t3='2026-10-16T21:00:30.000Z';await server.saveAccountState(snapshot(t3,[{...a,connected:false,currency:'Unknown',values:{},positionsAvailable:false,positions:[]}],false));
 state=await server.loadAccountState();assert.equal(state.monitor?.running,false);assert.equal(state.accounts[0].currency,'USD');assert.equal(state.accounts[0].values.CashValue?.value,50000);assert.equal(state.accounts[0].values.CashValue?.at,t2);assert.equal(state.accounts[0].positionsAt,t2);assert.equal(state.accounts[0].positionsAvailable,false);
 // An account absent from a newer batch is retained, without changing its manual status.
 await server.saveAccountState(snapshot('2026-10-16T21:00:45.000Z',[]));state=await server.loadAccountState();assert.equal(state.accounts.length,1);assert.deepEqual(state.monitor?.accountsSeen,[]);
 const after=await server.loadJournal();assert.deepEqual(after.accounts,before.accounts);assert.deepEqual(after.trades,before.trades);assert.deepEqual(after.cash,before.cash);assert.equal(after.profiles.find(p=>p.account===a.account)?.status,'Active');
 await server.saveCash({id:'new-current-payout',kind:'payout',date:'2026-10-16',account:a.account,deduction:1000,received:900,note:'Explicit payout confirmation'});
 const backup=JSON.parse(await(await server.backupResponse()).text());assert.equal(backup.accountState.accounts[0].values.CashValue.value,50000);assert.equal(backup.accountState.monitor.capturedAt,'2026-10-16T21:00:45.000Z');assert.equal((await server.loadJournal()).cash.length,before.cash.length+1);
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
const {inferredPayoutSummary,KNOWN_FIRM_ADJUSTMENTS}=require('../lib/balance-adjustments')as typeof import('../lib/balance-adjustments');
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
  const before=await server.loadJournal(),deduction=before.adjustments!.find(row=>row.account===account)!;assert.ok(deduction);assert.equal(deduction.amount,-1000);assert.equal(deduction.kind,'likely-payout');assert.equal(deduction.expectedShare,900);
  const observations=accountObservations(account),revision=await server.loadJournalVersion(),baselineTrade=before.trades.find(trade=>trade.account===account)!;
  await integrationTrade(account,'late-loss','2026-10-17T16:01:00Z','2026-10-17T16:02:00Z',1000,500.5);
  const after=await server.loadJournal();assert.notEqual((await server.loadJournalVersion()).revision,revision.revision);assert.equal(after.adjustments!.some(row=>row.account===account),false);assert.deepEqual(after.cash,before.cash);assert.deepEqual(accountObservations(account),observations);
  assert.deepEqual(after.trades.find(trade=>trade.id===baselineTrade.id),baselineTrade);assert.equal(after.trades.filter(trade=>trade.account===account).length,2);assert.equal(after.realized!.filter(row=>row.account===account).reduce((total,row)=>total+row.net!,0),-1000);
  assert.deepEqual(inferredPayoutSummary(after.adjustments!.filter(row=>row.account===account)),{count:0,gross:0,expected:0});
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
  assert.deepEqual(inferredPayoutSummary(rows),{count:2,gross:1000,expected:900});assert.deepEqual(after.cash,original.cash);assert.equal(accountObservations(account).length,3);
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
  const journal=await server.loadJournal(),rows=journal.adjustments!.filter(row=>row.account===account);assert.equal(rows.length,1);assert.equal(rows[0].before,53000);assert.equal(rows[0].after,53000);assert.equal(rows[0].tradingNet,1000);assert.equal(rows[0].amount,-1000);assert.equal(rows[0].kind,'likely-payout');assert.equal(rows[0].expectedShare,900);
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
