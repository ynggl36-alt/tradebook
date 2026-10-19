import {test} from 'node:test';
import assert from 'node:assert/strict';
import {accountExecutionKey,executionBatches,executionFingerprint,pendingAccountFills,synchronizeExecutions,validateRecorderImport} from '../lib/recorder-sync';
import type {AccountFill,SyncReceipt} from '../lib/recorder-sync';
import {validateCapture} from '../lib/recorder';
const fill=(id:string,account='LFE-TEST',ordinal=1):AccountFill=>({id,account,contract:'MNQ 2026-12',symbol:'MNQ',pv:2,side:'Buy',qty:1,price:30000,time:new Date(Date.UTC(2026,9,19,13,30,0,ordinal)).toISOString(),ordinal,pos:ordinal});
const snapshot=(fills:AccountFill[])=>({name:'2026-10-19.accounts.tradebook.xml',savedAt:1,fills});
test('account capture mode is explicit, simulator fills cannot cross it, and identical execution IDs remain separate per account',()=>{
  const root={schemaVersion:'1',mode:'AccountsReadOnly',recorderVersion:'0.2.0',day:'2026-10-19',dayTimeZone:'America/Chicago',savedAtUtc:'2026-10-19T14:00:00Z',warningCountThisRun:'0'};
  const execution={Account:'LFE-TEST',Instrument:'MNQ 12-26',ID:'same-id',Action:'Buy',Quantity:'1',Price:'30000',Time:'2026-10-19T13:30:00Z',RawAccountPosition:'1',Sequence:'1'};
  const rows={root,executions:[execution,{...execution,Account:'LFF-TEST',Sequence:'2'}],bars:[],issueCount:0};
  const capture=validateCapture(rows,'2026-10-19.accounts.tradebook.xml');assert.equal(capture.accountFills.length,2);assert.equal(capture.simulation.length,0);assert.equal(capture.simulatorFills,0);
  assert.notEqual(accountExecutionKey(capture.accountFills[0]),accountExecutionKey(capture.accountFills[1]));
  assert.throws(()=>validateCapture({...rows,executions:[{...execution,Account:'Sim101'}]}),/excluded/);
  assert.throws(()=>validateCapture({...rows,executions:[{...execution,Account:'Playback101'}]}),/excluded/);
  assert.throws(()=>validateCapture(rows,'2026-10-19.tradebook.xml'),/account mode/);
  assert.throws(()=>validateRecorderImport({mode:'Sim101Only',fills:[fill('a')]}),/exclude simulator/);
  assert.throws(()=>validateRecorderImport({mode:'AccountsReadOnly',fills:[fill('a','Sim101')]}),/exclude simulator/);
});
test('receipts suppress unchanged executions while preserving newly added accounts and surfacing conflicting snapshots',()=>{
  const a=fill('1'),b=fill('1','LFF-NEW'),receipts=[{key:accountExecutionKey(a),fingerprint:executionFingerprint(a)}];
  assert.deepEqual(pendingAccountFills([snapshot([a,b]),snapshot([a,b])],receipts),[b]);
  assert.equal(pendingAccountFills([snapshot([{...a,price:30001}])],receipts).length,1);
  assert.throws(()=>pendingAccountFills([snapshot([a]),snapshot([{...a,price:30001}])],receipts),/Conflicting/);
});
test('automatic batches respect both the account limit and fill limit without reversing partial-fill order',()=>{
  const many=Array.from({length:1200},(_,i)=>fill(String(i),'LFE-'+i%25,i+1));
  const batches=executionBatches(many);assert.deepEqual(batches.flat(),many);
  assert.ok(batches.every(batch=>batch.length<=500&&new Set(batch.map(f=>f.account)).size<=20));
  const one=executionBatches(Array.from({length:501},(_,i)=>fill(String(i),'LFE-ONE',i+1)));assert.deepEqual(one.map(b=>b.length),[500,1]);
});
test('offline failure keeps only unconfirmed rows pending; safe retry and browser restart do not duplicate prior batches',async()=>{
  const fills=Array.from({length:501},(_,i)=>fill(String(i),'LFE-ONE',i+1)),receipts:SyncReceipt[]=[];let calls=0,failedChecksum='';
  await assert.rejects(()=>synchronizeExecutions(fills,async body=>{calls++;if(calls===2){failedChecksum=String(body.checksum);throw new Error('Offline');}return {added:(body.fills as AccountFill[]).length,duplicates:0};},async batch=>{receipts.push(...batch.map(f=>({key:accountExecutionKey(f),fingerprint:executionFingerprint(f)})));},()=>true),/Offline/);
  assert.equal(receipts.length,500);const pending=pendingAccountFills([snapshot(fills)],receipts);assert.equal(pending.length,1);
  const retried=await synchronizeExecutions(pending,async body=>{assert.equal(body.checksum,failedChecksum);assert.equal(body.mode,'AccountsReadOnly');return {added:1,duplicates:0};},async batch=>{receipts.push(...batch.map(f=>({key:accountExecutionKey(f),fingerprint:executionFingerprint(f)})));},()=>true);
  assert.equal(retried.added,1);assert.equal(pendingAccountFills([snapshot(fills)],receipts).length,0);
});
test('a server-accepted batch whose local receipt could not save retries as duplicates and is then acknowledged',async()=>{
  const fills=[fill('a')];let firstHash='';
  await assert.rejects(()=>synchronizeExecutions(fills,async body=>{firstHash=String(body.checksum);return {added:1,duplicates:0};},async()=>{throw new Error('Storage unavailable');},()=>true),/Storage/);
  let acknowledged=0;const result=await synchronizeExecutions(fills,async body=>{assert.equal(body.checksum,firstHash);return {added:0,duplicates:1};},async batch=>{acknowledged+=batch.length;},()=>true);
  assert.equal(result.added,0);assert.equal(result.duplicates,1);assert.equal(acknowledged,1);
});
test('pausing stops later batches and simulator rows or invalid server acknowledgements never get receipts',async()=>{
  const fills=Array.from({length:501},(_,i)=>fill(String(i),'LFE-ONE',i+1));let enabled=true,acknowledged=0;
  const result=await synchronizeExecutions(fills,async body=>({added:(body.fills as AccountFill[]).length,duplicates:0}),async batch=>{acknowledged+=batch.length;enabled=false;},()=>enabled);
  assert.equal(result.sent,500);assert.equal(acknowledged,500);
  let posted=false;await assert.rejects(()=>synchronizeExecutions([fill('s','Sim101')],async()=>{posted=true;return {added:1,duplicates:0};},async()=>{},()=>true),/Simulator/);assert.equal(posted,false);
  let receipts=0;await assert.rejects(()=>synchronizeExecutions([fill('a')],async()=>({added:0,duplicates:0}),async()=>{receipts++;},()=>true),/did not confirm/);assert.equal(receipts,0);
});
